"use strict";
// On macOS/Linux node-pty does not fork+exec directly: it first starts its own small helper
// `prebuilds/<platform>-<arch>/spawn-helper` to setsid and open the pty, and the helper then execs
// the real shell. npm unpacks this file from the tarball, and some npm version / file system
// combinations drop the executable bit (macOS + npm 11 was observed installing it as
// -rw-r--r--), so pty.spawn() throws "posix_spawnp failed." and "new session" in the Web UI is
// just a bare 500 with no information.
// This sets 0755 on every spawn-helper. Idempotent and cross-platform (Windows has no such file
// and is skipped). It runs as the npm postinstall and once more when server.js starts (a packaged
// Electron build has no postinstall step, and files extracted to asar.unpacked may lack the
// permission too).
const fs = require("fs");
const path = require("path");

function fixNodePtyPerms(nodeModulesDir) {
  const prebuilds = path.join(nodeModulesDir || path.join(__dirname, "..", "node_modules"), "node-pty", "prebuilds");
  let fixed = [];
  let entries;
  try {
    entries = fs.readdirSync(prebuilds);
  } catch (e) {
    return fixed; // node-pty not installed / Windows platform: nothing to fix
  }
  for (const dir of entries) {
    const helper = path.join(prebuilds, dir, "spawn-helper");
    try {
      const st = fs.statSync(helper);
      if ((st.mode & 0o111) !== 0o111) {
        fs.chmodSync(helper, st.mode | 0o755);
        fixed.push(helper);
      }
    } catch (e) {
      // No spawn-helper in this platform directory (e.g. win32-*): skip
    }
  }
  return fixed;
}

if (require.main === module) {
  const fixed = fixNodePtyPerms();
  if (fixed.length) console.log(`[CC-Monitor] Made node-pty spawn-helper executable: ${fixed.join(", ")}`);
}

module.exports = { fixNodePtyPerms };
