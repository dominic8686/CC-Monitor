"use strict";
// Under root, Chromium refuses `npm run electron` outright with FATAL (the sandbox relies on
// dropping privileges via Linux user namespaces, which means nothing for a process that is already
// root; see the comment at the top of electron-main.js). That check happens in the startup phase
// of Electron's native main, before any JS code in electron-main.js runs, so it cannot be added at
// runtime with app.commandLine.appendSwitch: --no-sandbox must already be in the argv when the
// electron binary is actually spawned. This small launcher decides by user whether to add the
// flag, rather than hard-coding --no-sandbox in package.json (which would also strip sandbox
// protection from non-root users in normal use).
const { spawnSync } = require("child_process");
const path = require("path");

const electronPath = require("electron");
const entry = path.join(__dirname, "..", "electron-main.js");
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
// --no-sandbox only turns off the renderer sandbox. The GPU process has its own separate sandbox
// layer, which under root likewise fails to start because it cannot get a privilege-dropped user
// namespace ("GPU process isn't usable. Goodbye."), so it must be turned off too.
const args = isRoot ? ["--no-sandbox", "--disable-gpu-sandbox", entry] : [entry];

const result = spawnSync(electronPath, args, { stdio: "inherit" });
process.exit(result.status === null ? 1 : result.status);
