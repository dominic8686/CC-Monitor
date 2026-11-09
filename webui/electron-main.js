"use strict";
// Desktop entry point. Electron bundles Node.js, so the existing server.js (Express + ws +
// node-pty + better-sqlite3) runs in the same process by simply requiring it, without changing a
// line. The only difference from "open the web version in a browser" is that you do not run npm
// start and open a browser by hand: double-click the icon and you get a standalone window, served
// by default only to that window (independent of browser / system proxy settings).
//
// Running as root needs --no-sandbox (Chromium's sandbox relies on Linux user-namespace
// isolation; root already has full privileges, so isolation means nothing for it, and without
// this flag it exits with FATAL, see https://crbug.com/638180). That check happens in Electron's
// native startup phase, before any line of JS in this file runs. It has been verified in practice
// that even relaunching itself with Node at the very top of this file with the flag is too late,
// because this JS never gets a chance to run before the crash. So the switch must be put into the
// real process argv from outside, before the electron binary is spawned: `npm run electron` goes
// through the scripts/electron-start.js launcher; packaged AppImage/binaries use the wrapper
// script shipped with the release. This file neither needs to nor can handle it.
const { app, BrowserWindow, Menu, Notification, shell } = require("electron");
const path = require("path");

// The desktop app has no need to listen on a port "for other devices to connect": it always binds
// to this machine and uses an uncommon port to reduce the chance of clashing with other services
// on the user's machine (the web version's default 9999 is unchanged, the two do not interfere
// and can run at the same time).
process.env.CC_MONITOR_WEBUI_HOST = process.env.CC_MONITOR_WEBUI_HOST || "127.0.0.1";
process.env.CC_MONITOR_WEBUI_PORT = process.env.CC_MONITOR_WEBUI_PORT || "9998";

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    title: "CC-Monitor",
    webPreferences: {
      // The page needs no Node capabilities (it is a shell around our own Web UI using ordinary
      // browser APIs). Disabling nodeIntegration and enabling contextIsolation is Electron's
      // official security baseline, and there is no reason to deviate.
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  mainWindow.loadURL(`http://${process.env.CC_MONITOR_WEBUI_HOST}:${process.env.CC_MONITOR_WEBUI_PORT}/`);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ---- AI Approvals desktop alerts (main process side) ----
// The web version uses the browser's Notification API for system notifications; wrapped in
// Electron that path is broken on macOS: in the renderer Notification.permission is always
// "granted" (Electron does not implement a real permission flow) and new Notification() does not
// throw, but underneath it goes through UNUserNotificationCenter, and the system rejects apps
// that are not properly signed (the Electron.app in node_modules that `npm run electron` runs has
// only an ad-hoc signature). In testing, a main-process Notification fires a failed event
// "UNErrorDomain error 1" (= UNErrorCodeNotificationsNotAllowed), while the renderer fails
// silently and shows nothing.
// So the desktop app has the main process poll the pending approval list itself: it shows a
// system notification when it can, and even when it cannot there is always a Dock bounce + badge
// + window raise, none of which depend on signing. The page's Notification API path is turned
// off inside Electron (app.js checks the UA), so alerts are not shown twice.
const approvals = require("./lib/approvals");
const APPROVAL_POLL_MS = 2000;
const notifiedApprovalIds = new Set();
let nativeNotificationBroken = false;

function approvalTitle(kind) {
  if (kind === "notify") return "CC-Monitor: a question is waiting for your answer";
  if (kind === "permission") return "CC-Monitor: Claude is requesting permission";
  return "CC-Monitor: an operation is awaiting approval";
}

function approvalBody(r) {
  let summary = r.matched_value || "";
  if (r.kind === "notify") {
    try {
      summary = JSON.parse(summary).map((q) => q.question || "").join(" / ") || summary;
    } catch (e) {
      // Not the expected JSON: show it as is
    }
  }
  const folder = (r.cwd || "").split("/").filter(Boolean).pop() || r.cwd || "";
  return `${r.tool_name} · ${folder}\n${summary}`.slice(0, 200);
}

function showApprovalsTab() {
  if (!mainWindow) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents
    .executeJavaScript(`document.querySelector('.tab-btn[data-tab="approvals"]')?.click()`)
    .catch(() => {});
}

function announceApproval(r) {
  // None of these need any system permission: the system alert sound + Dock icon bounce (macOS)
  // / taskbar flash (Windows, Linux) + badge (maintained in pollApprovals).
  shell.beep();
  if (app.dock) app.dock.bounce("critical");
  if (mainWindow) mainWindow.flashFrame(true);
  if (nativeNotificationBroken || !Notification.isSupported()) return;
  const n = new Notification({ title: approvalTitle(r.kind), body: approvalBody(r) });
  n.on("click", showApprovalsTab);
  n.on("failed", (_event, error) => {
    // After one failure, stop trying for every item: the cause is almost always something like
    // "this app has no notification permission", which will not fix itself; Dock bounce + badge
    // continue as usual.
    nativeNotificationBroken = true;
    console.warn(
      `[CC-Monitor] Could not show a system notification (${error}). macOS rejects unsigned Electron builds (npm run electron); ` +
        "the Dock icon bounce and badge are unaffected."
    );
  });
  n.show();
}

function pollApprovals() {
  let rows;
  try {
    rows = approvals.listPending();
  } catch (e) {
    return;
  }
  if (app.dock) app.dock.setBadge(rows.length ? String(rows.length) : "");
  const stillPending = new Set(rows.map((r) => r.id));
  for (const r of rows) {
    if (notifiedApprovalIds.has(r.id)) continue;
    notifiedApprovalIds.add(r.id);
    announceApproval(r);
  }
  for (const id of notifiedApprovalIds) {
    if (!stillPending.has(id)) notifiedApprovalIds.delete(id);
  }
}

app.whenReady().then(() => {
  // This require really starts the server.listen(...) at the bottom of server.js. That module is
  // designed to "start listening as soon as it runs", so the desktop app needs no extra "wait until
  // ready" layer: Node's require is synchronous, and by the line below the port is already
  // listening.
  require("./server.js");
  Menu.setApplicationMenu(null); // a wrapper app needs no full menu bar; the page's own navigation is enough
  createWindow();
  setInterval(pollApprovals, APPROVAL_POLL_MS);

  app.on("activate", () => {
    // macOS convention: when the dock icon is clicked and there is no window, open a new one (do
    // not require server.js again, that must only run once).
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  // Windows/Linux convention: closing the last window quits the whole app; the macOS convention is to stay in the dock.
  if (process.platform !== "darwin") app.quit();
});
