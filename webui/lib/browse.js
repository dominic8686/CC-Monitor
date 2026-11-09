"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

// Used by the folder browser in the "new terminal session" dialog: lists subdirectories only,
// not files (what is picked is a cwd, not a particular file). This machine already allows typing
// any path into the cwd box to open a shell there, so browsing directories grants no more access
// than that, and no extra allowlist is added.
function listDir(dirPath) {
  const target = path.resolve(dirPath || os.homedir());
  let names;
  try {
    names = fs.readdirSync(target, { withFileTypes: true });
  } catch (e) {
    return { error: `Cannot open this directory: ${e.message}` };
  }
  const dirs = names
    .filter((d) => {
      if (!d.isDirectory() && !d.isSymbolicLink()) return false;
      if (d.isSymbolicLink()) {
        // Symlinks need an actual stat to confirm they point to a directory, or clicking into one gives a 500.
        try {
          return fs.statSync(path.join(target, d.name)).isDirectory();
        } catch (e) {
          return false;
        }
      }
      return true;
    })
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));

  const parent = path.dirname(target);
  return {
    path: target,
    parent: parent === target ? null : parent,
    dirs,
  };
}

module.exports = { listDir };
