"use strict";
// Multi-session event timeline: one lane per session, the x axis is a shared time window, and sessions are ordered vertically by most
// recent activity. Each time bucket draws a bar growing up from the bottom, coloured by the bucket's "worst risk"
// (a single high event in the bucket turns the whole bar red, even if the other 199 are info: risk must not be averaged away).
// Bar height is the bucket's event count normalised against "this lane's own busiest bucket", so quiet and noisy
// sessions both show the relative ups and downs of "how busy" in the same chart, instead of the quiet one always looking empty.
// Buckets with decision=blocked also get a highlighted outline that does not depend on event count: "1 blocked
// operation" must not get lost in "this bucket has lots of other events".
//
// The canvas does not understand CSS variables (fillStyle does not expand var(--x); this project has hit the same
// pitfall elsewhere, see the comment on vitalColor() in app.js). Colours are read fresh from
// getComputedStyle(document.documentElement) on every render(), so after a theme change the next render()
// follows automatically, with no extra theme-change listener. Like network-map.js, this is a vanilla module with no
// third-party libraries that manages its own lifecycle and talks to the outside through setData()/render().
(function () {
  const LANE_HEIGHT = 30;
  const LABEL_WIDTH = 200;
  const AXIS_HEIGHT = 22;
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  // Tick interval is chosen from the window length, aiming for about 6–12 ticks per screen
  function tickStepFor(rangeMs) {
    if (rangeMs <= HOUR) return 10 * MIN;
    if (rangeMs <= 6 * HOUR) return HOUR;
    if (rangeMs <= DAY) return 3 * HOUR;
    return DAY;
  }

  // Ticks align to local time (on the hour / every 3 hours / midnight), not rounded on the epoch; otherwise in time zones
  // that are not whole hours (+05:30 and the like) ticks would land on odd minutes.
  function firstTick(startMs, stepMs) {
    const d = new Date(startMs);
    if (stepMs >= DAY) {
      d.setHours(0, 0, 0, 0);
    } else if (stepMs >= HOUR) {
      d.setMinutes(0, 0, 0);
      d.setHours(d.getHours() - (d.getHours() % (stepMs / HOUR)));
    } else {
      d.setSeconds(0, 0);
      d.setMinutes(d.getMinutes() - (d.getMinutes() % (stepMs / MIN)));
    }
    let t = d.getTime();
    while (t < startMs) t += stepMs;
    return t;
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function tickLabel(ms, stepMs) {
    const d = new Date(ms);
    if (stepMs >= DAY) return `${d.getMonth() + 1}/${d.getDate()}`;
    const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    // The tick that crosses midnight carries the date, otherwise two "03:00" in a 24h window are ambiguous about the day
    return d.getHours() === 0 && d.getMinutes() === 0 ? `${d.getMonth() + 1}/${d.getDate()}` : hm;
  }

  function readColor(varName, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
    return v || fallback;
  }

  function riskColors() {
    return {
      high: readColor("--red", "#ef4444"),
      medium: readColor("--yellow", "#eab308"),
      low: readColor("--green", "#22c55e"),
      info: readColor("--cyan", "#06b6d4"),
      blocked: readColor("--red", "#ef4444"),
      dim: readColor("--text-dim", "#7a8094"),
      border: readColor("--border", "#2a3040"),
      text: readColor("--text", "#e6e8ee"),
    };
  }

  function worstRisk(b) {
    if (b.nHigh > 0) return "high";
    if (b.nMedium > 0) return "medium";
    if (b.nLow > 0) return "low";
    return "info";
  }

  function folderNameLocal(cwd) {
    if (!cwd) return "";
    const parts = String(cwd).replace(/\/+$/, "").split("/");
    return parts[parts.length - 1] || cwd;
  }

  function truncateLocal(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(t + "…").width > maxWidth) t = t.slice(0, -1);
    return t + "…";
  }

  function escapeHtmlLocal(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  class SessionTimeline {
    constructor(canvas, tooltipEl) {
      this.canvas = canvas;
      this.tooltipEl = tooltipEl;
      this.ctx = canvas.getContext("2d");
      this.data = null; // {rangeMinutes, bucketMs, now, lanes}
      this.onLaneClick = null; // (sessionId) => void, attached by app.js to jump to the Logs page
      // (lane, bucket|null, bucketMs) => html; app.js provides the translated version, this is only a fallback
      this.tooltipHtml = null;
      this._resize();
      window.addEventListener("resize", () => this._resize());
      canvas.addEventListener("mousemove", (ev) => this._onMouseMove(ev));
      canvas.addEventListener("mouseleave", () => this._hideTooltip());
      canvas.addEventListener("click", (ev) => this._onClick(ev));
    }

    setData(data) {
      this.data = data;
      this._resize();
    }

    _resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const laneCount = this.data ? this.data.lanes.length : 0;
      const rect = this.canvas.parentElement.getBoundingClientRect();
      // When the page is switched away (.view is display:none) the measured width is 0. Setting canvas.width anyway would
      // shrink the bitmap to 1px wide and then CSS would stretch it, so on switching back you would see an empty chart with only horizontal lines.
      // When hidden, skip; the next setData()/resize while visible measures again.
      if (rect.width === 0) return;
      const cssHeight = AXIS_HEIGHT + Math.max(1, laneCount) * LANE_HEIGHT;
      this.canvas.style.height = cssHeight + "px";
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(cssHeight * dpr));
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w;
        this.canvas.height = h;
      }
      this.dpr = dpr;
      this.render();
    }

    // The exact calculation must mirror the formula in render() that places buckets on x, otherwise you get
    // "the mouse points at one time but the tooltip says another". Both are based on "how many buckets from now",
    // not absolute indexes, so switching windows (1h/6h/24h/7d) needs no change to the formula.
    _hitTest(ev) {
      const box = this.canvas.getBoundingClientRect();
      const x = ev.clientX - box.left;
      const y = ev.clientY - box.top;
      const laneIndex = Math.floor((y - AXIS_HEIGHT) / LANE_HEIGHT);
      if (!this.data || laneIndex < 0 || laneIndex >= this.data.lanes.length) return null;
      const lane = this.data.lanes[laneIndex];
      if (x < LABEL_WIDTH) return { lane, bucket: null };
      const { bucketMs, rangeMinutes, now } = this.data;
      const bucketCount = Math.max(1, Math.round((rangeMinutes * 60 * 1000) / bucketMs));
      const plotW = Math.max(1, box.width - LABEL_WIDTH);
      const bucketW = plotW / bucketCount;
      const slot = Math.floor((x - LABEL_WIDTH) / bucketW);
      const bucketIndexFromNow = bucketCount - 1 - slot;
      const alignedNow = Math.floor(now / bucketMs) * bucketMs;
      const startMs = alignedNow - bucketIndexFromNow * bucketMs;
      const bucket = lane.buckets.find((b) => b.startMs === startMs) || null;
      return { lane, bucket };
    }

    _onMouseMove(ev) {
      const hit = this._hitTest(ev);
      if (!hit) {
        this._hideTooltip();
        return;
      }
      this._showTooltip(ev, hit);
    }

    _onClick(ev) {
      const hit = this._hitTest(ev);
      if (!hit || !this.onLaneClick) return;
      const range = hit.bucket ? { startMs: hit.bucket.startMs, endMs: hit.bucket.startMs + this.data.bucketMs } : null;
      this.onLaneClick(hit.lane.sessionId, range);
    }

    _showTooltip(ev, hit) {
      if (!this.tooltipEl) return;
      const { lane, bucket } = hit;
      if (this.tooltipHtml) {
        this.tooltipEl.innerHTML = this.tooltipHtml(lane, bucket, this.data.bucketMs);
      } else {
        const parts = [`<div class="tt-title">${escapeHtmlLocal(folderNameLocal(lane.cwd) || lane.sessionId)}</div>`];
        if (bucket) parts.push(`<div>${bucket.n} events${bucket.nBlocked ? `, ${bucket.nBlocked} blocked` : ""}</div>`);
        else parts.push(`<div>${lane.eventCount} events total</div>`);
        this.tooltipEl.innerHTML = parts.join("");
      }
      this.tooltipEl.hidden = false;
      const left = Math.min(ev.clientX + 14, window.innerWidth - 260);
      this.tooltipEl.style.left = Math.max(4, left) + "px";
      this.tooltipEl.style.top = ev.clientY + 14 + "px";
    }

    _hideTooltip() {
      if (this.tooltipEl) this.tooltipEl.hidden = true;
    }

    render() {
      const ctx = this.ctx;
      const dpr = this.dpr || 1;
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const cssW = this.canvas.width / dpr;
      const cssH = this.canvas.height / dpr;
      ctx.clearRect(0, 0, cssW, cssH);
      if (!this.data || !this.data.lanes.length) {
        ctx.restore();
        return;
      }

      const colors = riskColors();
      const { lanes, bucketMs, rangeMinutes, now } = this.data;
      const bucketCount = Math.max(1, Math.round((rangeMinutes * 60 * 1000) / bucketMs));
      const plotX0 = LABEL_WIDTH;
      const plotW = Math.max(1, cssW - LABEL_WIDTH);
      const bucketW = plotW / bucketCount;
      const alignedNow = Math.floor(now / bucketMs) * bucketMs;

      ctx.font = "11px -apple-system, system-ui, sans-serif";
      ctx.textBaseline = "middle";

      // Time axis: tick labels at the top + faint vertical lines across all lanes. The time → x mapping uses the same coordinate system
      // as the "how many buckets from now" formula used to draw the bars below (right edge of the window = end of the current bucket).
      const rangeMs = bucketCount * bucketMs;
      const windowStart = alignedNow + bucketMs - rangeMs;
      const xOf = (ms) => plotX0 + ((ms - windowStart) / rangeMs) * plotW;
      const stepMs = tickStepFor(rangeMs);
      ctx.fillStyle = colors.dim;
      ctx.textAlign = "center";
      for (let tMs = firstTick(windowStart, stepMs); tMs <= windowStart + rangeMs; tMs += stepMs) {
        const x = Math.round(xOf(tMs)) + 0.5;
        ctx.strokeStyle = colors.border;
        ctx.globalAlpha = 0.6;
        ctx.beginPath();
        ctx.moveTo(x, AXIS_HEIGHT - 4);
        ctx.lineTo(x, cssH);
        ctx.stroke();
        ctx.globalAlpha = 1;
        const label = tickLabel(tMs, stepMs);
        const halfW = ctx.measureText(label).width / 2;
        if (x - halfW >= plotX0 && x + halfW <= cssW) ctx.fillText(label, x, AXIS_HEIGHT / 2);
      }
      ctx.textAlign = "left";
      ctx.strokeStyle = colors.border;
      ctx.beginPath();
      ctx.moveTo(0, AXIS_HEIGHT - 0.5);
      ctx.lineTo(cssW, AXIS_HEIGHT - 0.5);
      ctx.moveTo(plotX0 - 0.5, 0);
      ctx.lineTo(plotX0 - 0.5, cssH);
      ctx.stroke();

      lanes.forEach((lane, laneIndex) => {
        const y0 = AXIS_HEIGHT + laneIndex * LANE_HEIGHT;

        // 🛑/⚠ follow the same visual convention as sessionLabel()/#log-session-filter in app.js:
        // 🛑 for operations that were really blocked, ⚠ for only a suspected hook bypass (not blocked, but not normal either).
        const flag = lane.blockedCount > 0 ? " \u{1F6D1}" : lane.bypassCount > 0 ? " ⚠" : "";
        const folder = folderNameLocal(lane.cwd);
        const idPart = lane.sessionId.slice(0, 8);
        const main = truncateLocal(ctx, (folder || idPart) + flag, LABEL_WIDTH - 80);
        ctx.fillStyle = colors.text;
        ctx.fillText(main, 6, y0 + LANE_HEIGHT / 2);
        if (folder) {
          ctx.fillStyle = colors.dim;
          ctx.fillText(" · " + idPart, 6 + ctx.measureText(main).width, y0 + LANE_HEIGHT / 2);
        }

        ctx.strokeStyle = colors.border;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, y0 + LANE_HEIGHT - 0.5);
        ctx.lineTo(cssW, y0 + LANE_HEIGHT - 0.5);
        ctx.stroke();

        const laneMaxN = lane.buckets.reduce((m, b) => Math.max(m, b.n), 1);
        for (const b of lane.buckets) {
          const bucketIndexFromNow = Math.round((alignedNow - b.startMs) / bucketMs);
          if (bucketIndexFromNow < 0 || bucketIndexFromNow >= bucketCount) continue; // bucket outside the window (should not happen in theory, skipped defensively)
          const bx = plotX0 + (bucketCount - 1 - bucketIndexFromNow) * bucketW;
          const heightFrac = Math.max(0.14, Math.min(1, b.n / laneMaxN));
          const barH = Math.max(3, heightFrac * (LANE_HEIGHT - 6));
          ctx.fillStyle = colors[worstRisk(b)];
          ctx.fillRect(bx + 1, y0 + LANE_HEIGHT - 3 - barH, Math.max(1, bucketW - 2), barH);
          if (b.nBlocked > 0) {
            ctx.strokeStyle = colors.blocked;
            ctx.lineWidth = 1.5;
            ctx.strokeRect(bx + 0.5, y0 + 1.5, Math.max(1, bucketW - 1), LANE_HEIGHT - 3);
          }
        }
      });
      ctx.restore();
    }
  }

  window.SessionTimeline = SessionTimeline;
})();
