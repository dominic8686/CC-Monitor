"use strict";
// World map traffic visualisation, modelled on WorldMap.jsx from the BeeEye project (projects by the same author
// borrow from each other, see https://github.com/cn0xroot/BeeEye/blob/main/BeeEye-web/src/components/WorldMap.jsx).
// It depends on no map tile service or third-party map API (avoiding extra network dependencies and data exposure) and draws
// everything itself with WebGL2: equirectangular projection (lon/lat mapped linearly to clip space), coastlines from a locally bundled low-resolution
// world.geo.json drawn as line segments, each destination with traffic drawn as a glowing point whose brightness depends on traffic volume/freshness,
// plus an arc from "this machine (nominal position)" to the destination with a moving light dot, whose direction follows whichever of
// upload/download bytes is larger on that connection (mostly upload runs outward, mostly download runs back, unknown direction defaults to outward).
// When WebGL2 is unavailable (old browsers, no GPU acceleration on this machine, or some sandboxes/remote sessions)
// it falls back to Canvas 2D drawing the same content, so the map does not vanish just because WebGL2 is missing.
(function () {
  function project(lat, lon) {
    return [lon / 180, lat / 90];
  }

  // "This machine" has no real geographic position on this map (it is the machine running Claude Code, not
  // the public egress the traffic actually goes through, and we do not send another request to ask "where is my public IP": that
  // would hand the user's real location to a third party, against this whole project's principle of "no extra requests to third
  // parties"). It is pinned at (0, 0) (off the Gulf of Guinea in the South Atlantic, known as "Null Island"); this
  // point was chosen only because it is obviously nobody's real location and cannot be mistaken for "this is where you are".
  const ANCHOR = { lat: 0, lon: 0 };
  const ARC_DURATION = 2.2; // seconds for a light dot to travel the arc once; arcs older than this disappear entirely
  const MAX_ARCS = 60; // cap on the number of arcs, so a page left open all day does not pile up into a tangle of lines

  // arc2d: a quadratic Bezier curve from a to b that bulges a little in the latitude direction at the midpoint (giving the
  // curved feel of a great-circle route). Each vertex carries a t in 0..1 (position along the arc); returns the flattened
  // [lat,lon,t, lat,lon,t, ...], exactly the same as BeeEye's function of the same name.
  function arc2d(aLat, aLon, bLat, bLon, steps = 40) {
    const out = [];
    const midLat = (aLat + bLat) / 2 + Math.min(40, Math.abs(aLon - bLon) * 0.25);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const lat = (1 - t) * (1 - t) * aLat + 2 * (1 - t) * t * midLat + t * t * bLat;
      const lon = (1 - t) * (1 - t) * aLon + 2 * (1 - t) * t * ((aLon + bLon) / 2) + t * t * bLon;
      out.push(lat, lon, t);
    }
    return out;
  }

  // Given the [lat,lon,t, ...] data produced by arc2d() and a head progress in 0..1, interpolate the (lat, lon) where the head
  // should currently be. Used to draw the head light dot; it is not for the GPU, plain JS computes it.
  function arcHeadLatLon(data, head) {
    const n = data.length / 3;
    const clamped = Math.max(0, Math.min(1, head));
    const idx = clamped * (n - 1);
    const i0 = Math.floor(idx);
    const i1 = Math.min(n - 1, i0 + 1);
    const frac = idx - i0;
    const lat = data[i0 * 3] + (data[i1 * 3] - data[i0 * 3]) * frac;
    const lon = data[i0 * 3 + 1] + (data[i1 * 3 + 1] - data[i0 * 3 + 1]) * frac;
    return [lat, lon];
  }

  // The equirectangular projection is inherently 2:1 (longitude spans 360°, latitude 180°), but the canvas is not necessarily 2:1,
  // so clip space is scaled again by the canvas's actual aspect ratio to keep pixel density equal in longitude and latitude,
  // with the leftover area letterboxed/pillarboxed instead of stretched to fill.
  const VERT_POINT = `#version 300 es
layout(location=0) in vec2 a_ll;
layout(location=1) in float a_mag;
uniform float u_size;
uniform vec2 u_scale;
out float v_mag;
void main() {
  vec2 p = vec2(a_ll.y / 180.0, a_ll.x / 90.0) * u_scale;
  gl_Position = vec4(p, 0.0, 1.0);
  gl_PointSize = u_size * (0.6 + a_mag * 1.8);
  v_mag = a_mag;
}`;

  const FRAG_POINT = `#version 300 es
precision highp float;
in float v_mag;
uniform vec3 u_col;
out vec4 outColor;
void main() {
  vec2 d = gl_PointCoord - vec2(0.5);
  float r = length(d) * 2.0;
  float core = smoothstep(1.0, 0.0, r);
  float glow = pow(core, 2.2);
  float a = glow * (0.35 + v_mag * 0.65);
  outColor = vec4(u_col * (0.6 + glow * 0.8), a);
}`;

  const VERT_LINE = `#version 300 es
layout(location=0) in vec2 a_ll;
uniform vec2 u_scale;
void main() {
  vec2 p = vec2(a_ll.y / 180.0, a_ll.x / 90.0) * u_scale;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

  const FRAG_LINE = `#version 300 es
precision highp float;
uniform vec3 u_col;
uniform float u_alpha;
out vec4 outColor;
void main() { outColor = vec4(u_col, u_alpha); }`;

  // A pair of shaders just for arcs. Unlike VERT_LINE/FRAG_LINE above, each vertex carries a t for its position
  // along the arc; the fragment shader compares t with the current animation head position u_head and lights up when close, giving
  // the "light dot running along the arc" effect. The arc itself is also drawn as a very faint base line, so nothing
  // is left blank after the dot has passed.
  const VERT_ARC = `#version 300 es
layout(location=0) in vec2 a_ll;
layout(location=1) in float a_t;
uniform vec2 u_scale;
out float v_t;
void main() {
  vec2 p = vec2(a_ll.y / 180.0, a_ll.x / 90.0) * u_scale;
  gl_Position = vec4(p, 0.0, 1.0);
  v_t = a_t;
}`;

  const FRAG_ARC = `#version 300 es
precision highp float;
in float v_t;
uniform float u_head;
uniform vec3 u_col;
out vec4 outColor;
void main() {
  float base = 0.16;
  float d = abs(v_t - u_head);
  float pulse = smoothstep(0.12, 0.0, d);
  float a = base + pulse * 0.9;
  outColor = vec4(u_col, a * (0.4 + v_t * 0.4));
}`;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error(log || "shader compile failed");
    }
    return s;
  }
  function makeProgram(gl, vsSrc, fsSrc) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(p);
      gl.deleteProgram(p);
      throw new Error(log || "program link failed");
    }
    return p;
  }

  // buildLandSegments: splits each edge of the GeoJSON polygons into [lat,lon, lat,lon] segment pairs,
  // drawn with GL_LINES (or segment by segment with moveTo/lineTo on the 2D path) as coastline outlines (not filled solid continents).
  function buildLandSegments(geojson) {
    const out = [];
    const addRing = (ring) => {
      for (let i = 0; i < ring.length; i++) {
        const [lon0, lat0] = ring[i];
        const [lon1, lat1] = ring[(i + 1) % ring.length];
        out.push(lat0, lon0, lat1, lon1);
      }
    };
    for (const f of geojson.features || []) {
      const g = f.geometry;
      if (!g) continue;
      if (g.type === "Polygon") {
        for (const ring of g.coordinates) addRing(ring);
      } else if (g.type === "MultiPolygon") {
        for (const poly of g.coordinates) for (const ring of poly) addRing(ring);
      }
    }
    return new Float32Array(out);
  }

  // Which way the light dot runs on a connection: more upload bytes means "this machine sending out" (this machine → destination),
  // more download bytes means "pulling back from the destination" (destination → this machine). If both are 0 (an inferred target
  // with no real byte counts) or tied, default to outward, matching BeeEye's fallback for "direction unknown".
  function arcDirection(p) {
    const tx = p.txBytes || 0;
    const rx = p.rxBytes || 0;
    return rx > tx
      ? arc2d(p.lat, p.lon, ANCHOR.lat, ANCHOR.lon)
      : arc2d(ANCHOR.lat, ANCHOR.lon, p.lat, p.lon);
  }

  class NetworkWorldMap {
    constructor(canvas) {
      this.canvas = canvas;
      this.arcs = []; // {born, data: Float32Array}
      const gl = canvas.getContext("webgl2", { antialias: true, alpha: true });
      if (gl) {
        this._initGL(gl);
      } else {
        this._init2D();
      }
      this._resize();
      window.addEventListener("resize", () => this._resize());
      this._startLoop();
    }

    _initGL(gl) {
      this.mode = "gl2";
      this.ok = true;
      this.gl = gl;
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE); // additive: where traffic overlaps it naturally gets brighter

      this.pointProg = makeProgram(gl, VERT_POINT, FRAG_POINT);
      this.lineProg = makeProgram(gl, VERT_LINE, FRAG_LINE);
      this.arcProg = makeProgram(gl, VERT_ARC, FRAG_ARC);

      this.landBuf = gl.createBuffer();
      this.landCount = 0;
      this.pointBuf = gl.createBuffer();
      this.magBuf = gl.createBuffer();
      this.pointCount = 0;
      // Inferred targets (command text parsing + DNS, see commandNetworkHosts() in audit.js) get a separate buffer/drawArrays call
      // from the real traffic measured by the system-layer probe, drawn in a different colour. They cannot use the same orange as real
      // traffic, or the map would give no way to tell which points are "inferred, not guaranteed to have connected".
      this.pointBufInferred = gl.createBuffer();
      this.magBufInferred = gl.createBuffer();
      this.pointCountInferred = 0;
      this.arcBuf = gl.createBuffer();
      // Light dot head: only adjusting the arc's own opacity (the original approach) was too weak; a 1px thin line under additive blending
      // shows no visible bright spot. Instead a small dot is drawn separately at the head position with the same
      // pointProg/FRAG_POINT shaders as the destination glow points, so it really looks like "a light dot running", not "the line
      // being slightly brighter somewhere".
      this.arcHeadBuf = gl.createBuffer();
    }

    _init2D() {
      this.mode = "2d";
      this.ctx = this.canvas.getContext("2d");
      this.ok = !!this.ctx;
      this.land2d = null; // Float32Array [lat,lon,lat,lon,...], same data as the GL path
      this.pointsReal = [];
      this.pointsInferred = [];
    }

    _resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = this.canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w;
        this.canvas.height = h;
      }
      if (this.mode === "gl2") this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      const canvasAspect = this.canvas.width / this.canvas.height;
      const dataAspect = 2; // longitude 360° / latitude 180°
      this.scale = canvasAspect > dataAspect ? [dataAspect / canvasAspect, 1] : [1, canvasAspect / dataAspect];
      this.render();
    }

    async loadLand(url) {
      if (!this.ok) return;
      try {
        const res = await fetch(url);
        const geojson = await res.json();
        const segments = buildLandSegments(geojson);
        if (this.mode === "gl2") {
          this.landCount = segments.length / 2;
          const gl = this.gl;
          gl.bindBuffer(gl.ARRAY_BUFFER, this.landBuf);
          gl.bufferData(gl.ARRAY_BUFFER, segments, gl.STATIC_DRAW);
        } else {
          this.land2d = segments;
        }
        this.render();
      } catch (e) {
        // If the world map outline file fails to load, the traffic points still show; it degrades to "a scatter plot without coastlines"
        this.landCount = 0;
        this.land2d = null;
      }
    }

    // pairs: [{lat, lon, bytes, txBytes, rxBytes, inferred}], normalised by bytes into 0..1
    // brightness/size; points with inferred:true are handled separately so they can be drawn in a different colour. Every call (one per
    // 10-second poll) adds a new arc for each destination in the current list, not only "the first time this
    // destination is seen", so as long as traffic keeps happening there are always light dots running on the map, instead of it
    // going completely still after one look.
    setData(pairs) {
      if (!this.ok) return;
      const maxBytes = Math.max(1, ...pairs.map((p) => p.bytes || 0));
      const build = (list) =>
        list
          .filter((p) => typeof p.lat === "number" && typeof p.lon === "number")
          .map((p) => ({ lat: p.lat, lon: p.lon, mag: Math.min(1, Math.log(1 + (p.bytes || 0)) / Math.log(1 + maxBytes)) }));
      const real = build(pairs.filter((p) => !p.inferred));
      const inferred = build(pairs.filter((p) => p.inferred));

      const now = performance.now() / 1000;
      for (const p of pairs) {
        if (typeof p.lat !== "number" || typeof p.lon !== "number") continue;
        this.arcs.push({ born: now, data: new Float32Array(arcDirection(p)) });
      }
      if (this.arcs.length > MAX_ARCS) this.arcs.splice(0, this.arcs.length - MAX_ARCS);

      if (this.mode === "gl2") {
        const gl = this.gl;
        this.pointCount = real.length;
        this.pointCountInferred = inferred.length;
        const flat = (list) => {
          const verts = new Float32Array(list.length * 2);
          const mags = new Float32Array(list.length);
          list.forEach((p, i) => {
            verts[i * 2] = p.lat;
            verts[i * 2 + 1] = p.lon;
            mags[i] = p.mag;
          });
          return { verts, mags };
        };
        const realFlat = flat(real);
        const inferredFlat = flat(inferred);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.pointBuf);
        gl.bufferData(gl.ARRAY_BUFFER, realFlat.verts, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.magBuf);
        gl.bufferData(gl.ARRAY_BUFFER, realFlat.mags, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.pointBufInferred);
        gl.bufferData(gl.ARRAY_BUFFER, inferredFlat.verts, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.magBufInferred);
        gl.bufferData(gl.ARRAY_BUFFER, inferredFlat.mags, gl.DYNAMIC_DRAW);
      } else {
        this.pointsReal = real;
        this.pointsInferred = inferred;
      }
      this.render();
    }

    // Continuously running animation loop: the only way the light dots on the arcs can "move". A single render() triggered
    // by setData()/resize() and the like only makes new data visible immediately; the moving dot needs u_head/head position
    // recomputed every frame. It stays resident for the page's whole lifetime (this component is not unmounted the way React components are),
    // the same as the other setInterval polling in this file: no need to stop it manually.
    _startLoop() {
      if (!this.ok) return;
      const loop = () => {
        const now = performance.now() / 1000;
        this.arcs = this.arcs.filter((a) => now - a.born < ARC_DURATION);
        this.render();
        this._rafId = requestAnimationFrame(loop);
      };
      this._rafId = requestAnimationFrame(loop);
    }

    render() {
      if (this.mode === "gl2") this._renderGL();
      else if (this.mode === "2d") this._render2D();
    }

    _renderGL() {
      const gl = this.gl;
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      const scale = this.scale || [1, 1];

      if (this.landCount > 0) {
        gl.useProgram(this.lineProg);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.landBuf);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.uniform2f(gl.getUniformLocation(this.lineProg, "u_scale"), scale[0], scale[1]);
        gl.uniform3f(gl.getUniformLocation(this.lineProg, "u_col"), 0.35, 0.55, 0.75);
        gl.uniform1f(gl.getUniformLocation(this.lineProg, "u_alpha"), 0.55);
        gl.drawArrays(gl.LINES, 0, this.landCount);
      }

      // Arcs: every arc has different vertex data (different start and end points), so each is uploaded and drawn one by one; the count is
      // already capped at MAX_ARCS, so the cost is acceptable. The line itself is only a faint guide line; what "looks like it is running"
      // is the head light dot drawn separately below. Only adjusting the line's opacity (what early versions did) with a 1px thin line +
      // additive blending makes it practically impossible to see which part is brighter; real screenshots confirmed this.
      const headPoints = [];
      if (this.arcs.length > 0) {
        gl.useProgram(this.arcProg);
        gl.uniform2f(gl.getUniformLocation(this.arcProg, "u_scale"), scale[0], scale[1]);
        gl.uniform3f(gl.getUniformLocation(this.arcProg, "u_col"), 0.45, 0.85, 1.0);
        const now = performance.now() / 1000;
        for (const a of this.arcs) {
          const head = (now - a.born) / ARC_DURATION;
          gl.bindBuffer(gl.ARRAY_BUFFER, this.arcBuf);
          gl.bufferData(gl.ARRAY_BUFFER, a.data, gl.DYNAMIC_DRAW);
          gl.enableVertexAttribArray(0);
          gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 12, 0);
          gl.enableVertexAttribArray(1);
          gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 12, 8);
          gl.uniform1f(gl.getUniformLocation(this.arcProg, "u_head"), head);
          gl.drawArrays(gl.LINE_STRIP, 0, a.data.length / 3);
          headPoints.push(arcHeadLatLon(a.data, head));
        }
      }

      // Head light dots: reuse the same pointProg/FRAG_POINT shaders as the destination glow points (a soft radial
      // halo), drawing the heads of all live arcs in one batched drawArrays, not one draw call
      // per arc. mag is fixed at a fairly bright value (0.75), not tied to the destination's traffic volume:
      // this dot shows "where the light dot has got to", not "how much traffic this destination has"; those are different things.
      if (headPoints.length > 0) {
        const verts = new Float32Array(headPoints.length * 2);
        headPoints.forEach(([lat, lon], i) => {
          verts[i * 2] = lat;
          verts[i * 2 + 1] = lon;
        });
        gl.useProgram(this.pointProg);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.arcHeadBuf);
        gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        // mag is a constant, so no real buffer is needed: vertexAttrib1f supplies a constant value for a disabled attribute array,
        // saving a bufferData call.
        gl.disableVertexAttribArray(1);
        gl.vertexAttrib1f(1, 0.75);
        gl.uniform2f(gl.getUniformLocation(this.pointProg, "u_scale"), scale[0], scale[1]);
        gl.uniform1f(gl.getUniformLocation(this.pointProg, "u_size"), 14 * (window.devicePixelRatio || 1));
        gl.uniform3f(gl.getUniformLocation(this.pointProg, "u_col"), 0.45, 0.85, 1.0);
        gl.drawArrays(gl.POINTS, 0, headPoints.length);
      }

      if (this.pointCount > 0) {
        gl.useProgram(this.pointProg);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.pointBuf);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.magBuf);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 0, 0);
        gl.uniform2f(gl.getUniformLocation(this.pointProg, "u_scale"), scale[0], scale[1]);
        gl.uniform1f(gl.getUniformLocation(this.pointProg, "u_size"), 26 * (window.devicePixelRatio || 1));
        gl.uniform3f(gl.getUniformLocation(this.pointProg, "u_col"), 0.95, 0.55, 0.25);
        gl.drawArrays(gl.POINTS, 0, this.pointCount);
      }

      // Inferred targets (command text parsing, not measured by the probe) get their own drawArrays call, coloured in
      // the same amber family as the .dd-badge-inferred badge in the table, visually distinct from the orange of real traffic,
      // so nobody mistakes every point on the map for a probe-confirmed connection.
      if (this.pointCountInferred > 0) {
        gl.useProgram(this.pointProg);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.pointBufInferred);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.magBufInferred);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 0, 0);
        gl.uniform2f(gl.getUniformLocation(this.pointProg, "u_scale"), scale[0], scale[1]);
        gl.uniform1f(gl.getUniformLocation(this.pointProg, "u_size"), 26 * (window.devicePixelRatio || 1));
        gl.uniform3f(gl.getUniformLocation(this.pointProg, "u_col"), 1.0, 0.83, 0.47);
        gl.drawArrays(gl.POINTS, 0, this.pointCountInferred);
      }
    }

    // Canvas 2D fallback path: draws the same content when WebGL2 is unavailable (grid lines dropped, coastlines + arcs +
    // light dots all present), using globalCompositeOperation='lighter' to mimic the additive blending on the GL side
    // (overlaps naturally get brighter). Runs on requestAnimationFrame, animating continuously like the GL path.
    _render2D() {
      const ctx = this.ctx;
      const w = this.canvas.width;
      const h = this.canvas.height;
      if (w <= 0 || h <= 0) return; // not laid out yet (first draw / mid-resize), clientWidth may read as 0
      const scale = this.scale || [1, 1];
      // Same projection + letterbox scaling as the GL path, only converted from clip space [-1,1] to pixels at the end.
      const toPx = (lat, lon) => {
        const cx = (lon / 180) * scale[0];
        const cy = (lat / 90) * scale[1];
        return [((cx + 1) / 2) * w, ((1 - cy) / 2) * h];
      };

      ctx.clearRect(0, 0, w, h);

      if (this.land2d && this.land2d.length > 0) {
        ctx.strokeStyle = "rgba(89, 140, 191, 0.55)";
        ctx.lineWidth = Math.max(1, window.devicePixelRatio || 1);
        ctx.beginPath();
        for (let i = 0; i < this.land2d.length; i += 4) {
          const [x0, y0] = toPx(this.land2d[i], this.land2d[i + 1]);
          const [x1, y1] = toPx(this.land2d[i + 2], this.land2d[i + 3]);
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
        }
        ctx.stroke();
      }

      ctx.globalCompositeOperation = "lighter";

      const now = performance.now() / 1000;
      for (const a of this.arcs) {
        const n = a.data.length / 3;
        if (n <= 0) continue;
        const head = (now - a.born) / ARC_DURATION;
        ctx.strokeStyle = "rgba(115, 217, 255, 1)";
        ctx.lineWidth = Math.max(1, 1.4 * (window.devicePixelRatio || 1));
        ctx.globalAlpha = 0.3;
        ctx.beginPath();
        for (let k = 0; k < n; k++) {
          const [x, y] = toPx(a.data[k * 3], a.data[k * 3 + 1]);
          k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
        const hi = Math.max(0, Math.min(n - 1, Math.round(head * (n - 1))));
        const [hx, hy] = toPx(a.data[hi * 3], a.data[hi * 3 + 1]);
        const rad = 7 * (window.devicePixelRatio || 1);
        const g = ctx.createRadialGradient(hx, hy, 0, hx, hy, rad);
        g.addColorStop(0, "rgba(115, 217, 255, 0.95)");
        g.addColorStop(1, "rgba(115, 217, 255, 0)");
        ctx.globalAlpha = 1;
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(hx, hy, rad, 0, Math.PI * 2);
        ctx.fill();
      }

      const drawPoints = (list, colorCss) => {
        for (const p of list) {
          const [x, y] = toPx(p.lat, p.lon);
          const rad = (10 + p.mag * 18) * (window.devicePixelRatio || 1);
          const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
          g.addColorStop(0, colorCss);
          g.addColorStop(1, "rgba(0,0,0,0)");
          ctx.globalAlpha = 0.35 + p.mag * 0.5;
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(x, y, rad, 0, Math.PI * 2);
          ctx.fill();
        }
      };
      drawPoints(this.pointsReal, "rgba(242, 140, 64, 1)");
      // Inferred targets use the same amber family as the .dd-badge-inferred badge, matching the GL path's
      // u_col (1.0, 0.83, 0.47) so the two render paths look the same.
      drawPoints(this.pointsInferred, "rgba(255, 212, 120, 1)");

      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }
  }

  window.NetworkWorldMap = NetworkWorldMap;
})();
