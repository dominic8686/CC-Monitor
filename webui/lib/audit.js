"use strict";
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");

function dbPath() {
  const home = process.env.CC_MONITOR_HOME || path.join(os.homedir(), ".cc-monitor");
  return path.join(home, "events.db");
}

// Splits a Bash command into "subcommands" at ; & | and newlines and looks at how each one starts. Several
// classifiers in this file share this technique (rather than substring-matching the whole command text, so a
// string that is merely echoed is not taken for something actually executed). But naively splitting the whole
// command with cmd.split(/[;&|\n]+/) has a hole: inside a quoted multi-line string argument or a heredoc body
// (<<'EOF' ... EOF), newlines are content, not shell command separators. Ignoring that turns the body into a
// pile of "independent subcommands" whose starts get inspected; real production data caught two cases:
//   1. `python3 -c "\nimport json, sys\n..."`: the "import json, sys" inside the double-quoted argument sits on
//      its own line and was taken for a call to ImageMagick's screenshot command import;
//   2. `git commit -m "$(cat <<'EOF' ... EOF)"`: a word-wrapped line in the heredoc body happened to start with
//      "spectacle" (text describing the KDE screenshot tool by name) and was taken for a real spectacle
//      screenshot call.
// splitShellSegments() fixes this with a simplified shell tokenizer: it tracks whether we are inside single or
// double quotes or a heredoc body, and treats ; & | and newline as separators only at the "top level" (outside
// quotes/heredocs). It does not aim to reproduce bash syntax 100% (for example newlines inside backticks or
// nested $() get no special handling), but it covers both observed sources of false matches.
// The second argument seps is optional. By default it splits on all four of ; & | and newline (the original
// behaviour, the "look only at subcommand starts" most classifiers want). Some cases (for example detecting a
// pipe send like `cat file | nc host port`) need to keep both sides of `|` together, so they pass `";&\n"` to
// split only on ; & and newline, leaving the `|`-joined parts in one string, then split again themselves with
// `splitShellSegments(group, "|")` as needed.
function splitShellSegments(cmd, seps = ";&|\n") {
  const segments = [];
  let cur = "";
  let i = 0;
  let quote = null; // "'" | '"' | null
  let heredocEnd = null; // closing delimiter, or null (not inside a heredoc body)
  const n = cmd.length;
  while (i < n) {
    if (heredocEnd !== null) {
      const lineEnd = cmd.indexOf("\n", i);
      const line = lineEnd === -1 ? cmd.slice(i) : cmd.slice(i, lineEnd);
      cur += line;
      if (line.trim() === heredocEnd) heredocEnd = null;
      if (lineEnd === -1) {
        i = n;
      } else {
        cur += "\n";
        i = lineEnd + 1;
      }
      continue;
    }
    const ch = cmd[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      i++;
      continue;
    }
    if (ch === "<" && cmd[i + 1] === "<") {
      const m = /^<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(cmd.slice(i));
      if (m) {
        cur += m[0];
        i += m[0].length;
        const nl = cmd.indexOf("\n", i);
        if (nl === -1) {
          i = n;
        } else {
          cur += cmd.slice(i, nl + 1);
          i = nl + 1;
          heredocEnd = m[2];
        }
        continue;
      }
    }
    if (seps.indexOf(ch) !== -1) {
      segments.push(cur);
      cur = "";
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  if (cur) segments.push(cur);
  return segments;
}

// Whether a Bash command really deletes files: split into subcommands with splitShellSegments() and look at how
// each starts, rather than substring-matching the whole command text. The old SQL LIKE '%rm %' approach counted
// ordinary output with words ending in "rm " ("confirm "/"warm "/"term ") as deletions, or counted an echoed
// string (such as echo "rm -rf is dangerous") as a real deletion: lots of false positives.
function commandDeletesFiles(cmd) {
  if (!cmd) return false;
  // find -exec rm ... \; and cmd | xargs rm are not at a subcommand start; check them separately as a fallback.
  if (/(?:^|\s)(?:-exec\s+|xargs\s+(?:-\S+\s+)*)(?:rm|shred|unlink)\b/.test(cmd)) return true;
  const segments = splitShellSegments(cmd);
  for (const raw of segments) {
    const seg = raw.trim().replace(/^sudo\s+/, "");
    if (/^(rm|rmdir|unlink|shred|trash-put|trash)\b/.test(seg)) return true;
    if (/^git\s+rm\b/.test(seg)) return true;
    if (/^find\b/.test(seg) && /(?:^|\s)-delete(?:\s|$)/.test(seg)) return true;
  }
  return false;
}

function isDeleteEvent(detailJson) {
  try {
    const detail = detailJson ? JSON.parse(detailJson) : {};
    return commandDeletesFiles(detail.command || "") ? 1 : 0;
  } catch (e) {
    return 0;
  }
}

// Classifies GitHub operations, same approach as commandDeletesFiles: split into subcommands at ; & | and
// newlines and look at how each starts, rather than substring-matching the whole command text (so output like
// echo "git push is dangerous" does not count as a real git push). Several subcommands of one Bash command may
// match (for example `git add . && git commit -m x && git push`); return the single "most specific" category
// rather than counting each subcommand, for the same reason commandDeletesFiles returns one boolean.
const GITHUB_OP_ORDER = ["push", "clone", "commit", "pullFetch", "ghCli", "otherGit"];
function classifyGithubOp(cmd) {
  if (!cmd) return null;
  const segments = splitShellSegments(cmd).map((raw) => raw.trim().replace(/^sudo\s+/, ""));
  const found = new Set();
  for (const seg of segments) {
    if (/^git\s+push\b/.test(seg)) found.add("push");
    else if (/^git\s+clone\b/.test(seg)) found.add("clone");
    else if (/^git\s+commit\b/.test(seg)) found.add("commit");
    else if (/^git\s+(pull|fetch)\b/.test(seg)) found.add("pullFetch");
    else if (/^gh\s+\S/.test(seg)) found.add("ghCli");
    else if (/^git\s+\S/.test(seg)) found.add("otherGit");
  }
  for (const kind of GITHUB_OP_ORDER) {
    if (found.has(kind)) return kind;
  }
  return null;
}

function githubOpType(detailJson) {
  try {
    const detail = detailJson ? JSON.parse(detailJson) : {};
    return classifyGithubOp(detail.command || "");
  } catch (e) {
    return null;
  }
}

// Classifies SSH operations, exactly like classifyGithubOp: split into subcommands at ; & | and newlines and look
// only at subcommand starts. (`\s|$` rather than `\b`, so independent hyphenated commands like
// ssh-keygen/ssh-copy-id/ssh-add/ssh-agent are not taken for "ssh" itself: with a plain \b, the "-" right after
// "ssh" in "ssh-keygen" also counts as a word boundary, and /^ssh\b/ would match.)
const SSH_OP_ORDER = ["ssh", "scp", "sftp", "keyManagement", "other"];
function classifySshOp(cmd) {
  if (!cmd) return null;
  const segments = splitShellSegments(cmd).map((raw) => raw.trim().replace(/^sudo\s+/, ""));
  const found = new Set();
  for (const seg of segments) {
    if (/^ssh(\s|$)/.test(seg)) found.add("ssh");
    else if (/^scp(\s|$)/.test(seg)) found.add("scp");
    else if (/^sftp(\s|$)/.test(seg)) found.add("sftp");
    else if (/^(ssh-keygen|ssh-copy-id|ssh-add|ssh-agent)(\s|$)/.test(seg)) found.add("keyManagement");
    else if (/^(autossh|sshpass|ssh-askpass)(\s|$)/.test(seg)) found.add("other");
  }
  for (const kind of SSH_OP_ORDER) {
    if (found.has(kind)) return kind;
  }
  return null;
}

function sshOpType(detailJson) {
  try {
    const detail = detailJson ? JSON.parse(detailJson) : {};
    return classifySshOp(detail.command || "");
  } catch (e) {
    return null;
  }
}

// Classifies download activity, by subcommand start like classifyGithubOp/classifySshOp. Take care not to overlap
// categories already counted elsewhere (git clone counts as a GitHub operation; pip/npm/system package manager
// installs count toward software install stats); none of those are counted again here, only dedicated download
// tools.
// curl is handled separately: it only counts as a "download" with an option that really writes to disk
// (-o/-O/--output/--remote-name). Bare curl (such as curl https://api.example.com/status) is mostly calling an
// API to read the response, not downloading a file; counting it all as downloads would pull in ordinary API
// calls and add too much noise.
const DOWNLOAD_OP_ORDER = ["wget", "curl", "aria2", "other"];
const CURL_OUTPUT_FLAG_RE = /(^|\s)(-O\b|--remote-name\b|-o\s|--output(\s|=))/;
function classifyDownloadOp(cmd) {
  if (!cmd) return null;
  const segments = splitShellSegments(cmd).map((raw) => raw.trim().replace(/^sudo\s+/, ""));
  const found = new Set();
  for (const seg of segments) {
    if (/^wget2?(\s|$)/.test(seg)) found.add("wget");
    else if (/^curl(\s|$)/.test(seg) && CURL_OUTPUT_FLAG_RE.test(seg)) found.add("curl");
    else if (/^aria2c?(\s|$)/.test(seg)) found.add("aria2");
    else if (/^(axel|lftp|ftp|http|https)(\s|$)/.test(seg)) found.add("other");
  }
  for (const kind of DOWNLOAD_OP_ORDER) {
    if (found.has(kind)) return kind;
  }
  return null;
}

function downloadOpType(detailJson) {
  try {
    const detail = detailJson ? JSON.parse(detailJson) : {};
    return classifyDownloadOp(detail.command || "");
  } catch (e) {
    return null;
  }
}

// Classifies file send / exfiltration. Unlike the classifiers above it has to judge "direction": the ssh-ops card
// only answers "was scp/sftp used", while this card answers "was a local file actually pushed out". The same scp
// command can count on both cards, on purpose (the two cards answer different questions; this is not double
// counting). Direction is judged only from whether "the last argument looks like a remote target"
// (user@host:path / host:path / scheme://bucket/path / rclone's remote:path), without fully parsing the argument
// list. A download like `scp host:a host:b local/`, whose destination is really a local path, is not counted
// because the last argument does not look like a remote target. Better to miss one than to take a download for
// a send (the same principle as the other classifiers in this file).
const REMOTE_DEST_TAIL_RE = /(?:^|\s)((?:[\w.-]+@)?[a-zA-Z0-9][\w.-]*:(?:\/\/)?\S+)\s*$/;
// The curl/wget "upload" options: only forms that clearly send a local file's content as the request body
// (-T/--upload-file for a whole file, -F/--form parts with @file, --data(-binary) with @file, wget --post-file).
// A bare -d/--data (no @file) is most likely an ordinary API request body and is not treated as "sending a
// file", so not every POST request gets counted.
const CURL_UPLOAD_FLAG_RE = /(^|\s)(-T\s|--upload-file(\s|=)|-F\s|--form(\s|=)|--data(-binary)?(\s+|=)@|-d\s+@)/;
const WGET_UPLOAD_FLAG_RE = /--post-file(\s|=)/;
// Write-type subcommands of cloud storage CLIs: cp/sync/copy/upload/put/mv. Used with REMOTE_DEST_TAIL_RE above:
// it only counts as a send when the subcommand is a write AND the destination (last argument) looks like a remote
// bucket/remote. Read-only subcommands like ls/cat, or a local destination (such as the download
// `aws s3 cp s3://bucket/file ./local`), are not counted.
const CLOUD_WRITE_VERB_RE = /\b(cp|sync|copy|upload|put|mv)\b/;
// The "pipe it into nc to send" form for nc/ncat/netcat. In real production data the pipe form
// `cat file | nc -w 10 host port` is much more common than the explicit redirect `nc host port < file` below;
// accepting only the redirect form missed these real "send a file to a remote device" operations entirely. The
// pipe form cannot be judged from segments split on all of ; & | and newline: once `|` is a separator, the
// information "was this nc segment fed by another command's output" is lost. So here
// splitShellSegments(cmd, ";&\n") keeps `|` groups together, only real pipe groups are split again on `|`, and
// we check whether the last stage is nc/ncat/netcat in the client "host + port" form connecting out (not `-l`
// listen mode: listening waits for others to connect in, the opposite meaning, and policy.py's reverse shell
// rules already cover it, so it is not counted again here). Whatever produces the data before the pipe, cat or
// anything else, "feeding nc to send it out" counts in itself.
const NC_LISTEN_OR_SCAN_FLAG_RE = /(^|\s)-[a-zA-Z]*[lz][a-zA-Z]*(\s|$)/;
const NC_HOST_PORT_TAIL_RE = /\S+\s+\d{1,5}\s*$/;
function classifyNetcatPipeSend(cmd) {
  const groups = splitShellSegments(cmd, ";&\n");
  for (const group of groups) {
    if (!group.includes("|")) continue;
    const stages = splitShellSegments(group, "|").map((raw) => raw.trim().replace(/^sudo\s+/, ""));
    const last = stages[stages.length - 1];
    if (!last || !/^(nc|ncat|netcat)(\s|$)/.test(last)) continue;
    if (NC_LISTEN_OR_SCAN_FLAG_RE.test(last)) continue;
    if (NC_HOST_PORT_TAIL_RE.test(last)) return true;
  }
  return false;
}

const FILE_SEND_OP_ORDER = ["scp", "rsync", "sftp", "curlUpload", "cloudSync", "netcatSend", "other"];
function classifyFileSendOp(cmd) {
  if (!cmd) return null;
  const segments = splitShellSegments(cmd).map((raw) => raw.trim().replace(/^sudo\s+/, ""));
  const found = new Set();
  if (classifyNetcatPipeSend(cmd)) found.add("netcatSend");
  for (const seg of segments) {
    if (/^scp(\s|$)/.test(seg)) {
      if (REMOTE_DEST_TAIL_RE.test(seg)) found.add("scp");
    } else if (/^rsync(\s|$)/.test(seg)) {
      if (REMOTE_DEST_TAIL_RE.test(seg)) found.add("rsync");
    } else if (/^sftp(\s|$)/.test(seg)) {
      // sftp is an interactive protocol; the real upload is its `put` subcommand (as opposed to `get`). Count it only
      // when put is visible directly in the command-line text (for example in a -b batch script or a heredoc).
      if (/\bput\b/.test(seg)) found.add("sftp");
    } else if (/^curl(\s|$)/.test(seg) && CURL_UPLOAD_FLAG_RE.test(seg)) {
      found.add("curlUpload");
    } else if (/^wget2?(\s|$)/.test(seg) && WGET_UPLOAD_FLAG_RE.test(seg)) {
      found.add("other");
    } else if (/^(aws\s+s3|gsutil|az\s+storage|azcopy|ossutil|rclone|b2)(\s|$)/.test(seg)) {
      if (CLOUD_WRITE_VERB_RE.test(seg) && REMOTE_DEST_TAIL_RE.test(seg)) found.add("cloudSync");
    } else if (/^(nc|ncat|netcat)(\s|$)/.test(seg)) {
      // The pipe form (`cat file | nc host port`) was already checked above by classifyNetcatPipeSend(); here we only
      // accept the explicit input redirect form `nc host port < file`.
      if (/<\s*\S/.test(seg)) found.add("netcatSend");
    } else if (/^(wormhole\s+send|croc\s+send|magic-wormhole\s+send)(\s|$)/.test(seg)) {
      found.add("other");
    }
  }
  for (const kind of FILE_SEND_OP_ORDER) {
    if (found.has(kind)) return kind;
  }
  return null;
}

// Everything above handles "Bash command text". Claude can also skip the shell entirely and send local files out
// with its own native tools or MCP tools. Bash regexes cannot see that path, so it is recognised by tool_name
// (the same idea as screenshotKind() judging Bash/Read/MCP separately for screenshots):
//   1. The Artifact tool's asset upload: with `asset: true` it uploads the local files file_path/file_paths
//      point to, as is, to the claude.ai artifact asset store. This is the most direct "send a local file to an
//      external service" path among the built-in tools. Publishing a whole page with `files`/`root` technically
//      also sends local file content to claude.ai, but that is "publish a page", a more common action triggered
//      by almost every use of the Artifact tool; counting all of it as "sending files" would flood this card
//      with noise. Only the clear-cut asset:true path, whose meaning is "upload a file", is picked.
// 2. MCP tool names that clearly say "upload/send file". No list of MCP servers is maintained; tools are
//      recognised by the literal meaning of their names (write-type tools exposed by MCP servers such as Slack,
//      GDrive or mail attachments almost always contain one of upload/send_file/attach/put_object).
// 3. Fallback for built-in/MCP tool arguments containing both a "remote URL target" and a "local file path /
//      attachment" field. No currently known built-in tool (WebFetch etc.) documents support for sending a local
//      file as the request body; this is a defensive check written "in case such an argument shape ever shows
//      up". Better to miss one than to record a normal read-only fetch as a file send.
const MCP_FILE_SEND_NAME_RE = /(upload|send_?file|attach(_?file)?|put_?object|share_?file)/i;
const URL_FIELD_RE = /^https?:\/\//i;
function isArtifactAssetUpload(detail) {
  return Boolean(detail && detail.asset === true && (detail.file_path || detail.file_paths));
}
function hasRemoteFileBodyShape(detail) {
  if (!detail || typeof detail !== "object") return false;
  const url = detail.url || detail.uri || "";
  if (!URL_FIELD_RE.test(url)) return false;
  return Boolean(detail.file_path || detail.file_paths || detail.attachment || detail.body_file);
}
function classifyNativeFileSendOp(toolName, detail) {
  // The Artifact tool returns here and never reaches the generic fallback below. Its normal "update a published
  // artifact" use has url (the existing artifact to update) + file_path (the local page file) together, exactly
  // the "remote target + local file" argument shape hasRemoteFileBodyShape() looks for. Real production data
  // confirmed the collision (lots of normal page publish/update calls were misjudged as "sending files" by the
  // generic fallback), so it must be stopped here first.
  if (toolName === "Artifact") return isArtifactAssetUpload(detail) ? "artifactUpload" : null;
  if (toolName && toolName.startsWith("mcp__") && MCP_FILE_SEND_NAME_RE.test(toolName)) return "mcpFileSend";
  if (toolName && toolName !== "Bash" && hasRemoteFileBodyShape(detail)) return "toolFileBody";
  return null;
}

function fileSendOpType(toolName, detailJson) {
  try {
    const detail = detailJson ? JSON.parse(detailJson) : {};
    if (toolName === "Bash") return classifyFileSendOp(detail.command || "");
    return classifyNativeFileSendOp(toolName, detail);
  } catch (e) {
    return null;
  }
}

// Classifies Docker operations, by subcommand start like classifySshOp/classifyDownloadOp. build/run are split out
// because they "execute instructions from arbitrary external images/Dockerfiles", a different order of risk from
// read-only views like ps/logs/images; exec is split out because it "runs a command inside an already running
// container", with risk similar to running commands directly on the host. compose covers docker compose (the v2
// subcommand) and standalone docker-compose (the v1 binary). docker-compose is checked separately as a
// subcommand start; \b cannot be used (or docker would match too).
const DOCKER_OP_ORDER = ["run", "build", "exec", "compose", "other"];
function classifyDockerOp(cmd) {
  if (!cmd) return null;
  const segments = splitShellSegments(cmd).map((raw) => raw.trim().replace(/^sudo\s+/, ""));
  const found = new Set();
  for (const seg of segments) {
    if (/^docker-compose(\s|$)/.test(seg)) found.add("compose");
    else if (/^docker\s+compose\b/.test(seg)) found.add("compose");
    else if (/^docker\s+run\b/.test(seg)) found.add("run");
    else if (/^docker\s+build\b/.test(seg)) found.add("build");
    else if (/^docker\s+exec\b/.test(seg)) found.add("exec");
    else if (/^docker(\s|$)/.test(seg)) found.add("other");
  }
  for (const kind of DOCKER_OP_ORDER) {
    if (found.has(kind)) return kind;
  }
  return null;
}

function dockerOpType(detailJson) {
  try {
    const detail = detailJson ? JSON.parse(detailJson) : {};
    return classifyDockerOp(detail.command || "");
  } catch (e) {
    return null;
  }
}

// Classifies compression/archive operations, by subcommand start like classifyDockerOp.
const ARCHIVE_OP_ORDER = ["tar", "zip", "sevenZip", "gzip", "other"];
function classifyArchiveOp(cmd) {
  if (!cmd) return null;
  const segments = splitShellSegments(cmd).map((raw) => raw.trim().replace(/^sudo\s+/, ""));
  const found = new Set();
  for (const seg of segments) {
    if (/^tar(\s|$)/.test(seg)) found.add("tar");
    else if (/^(zip|unzip)(\s|$)/.test(seg)) found.add("zip");
    else if (/^(7z|7za|7zr)(\s|$)/.test(seg)) found.add("sevenZip");
    else if (/^(gzip|gunzip|zcat)(\s|$)/.test(seg)) found.add("gzip");
    else if (/^(bzip2|bunzip2|xz|unxz|zstd|unzstd|lzma|unlzma|rar|unrar)(\s|$)/.test(seg)) found.add("other");
  }
  for (const kind of ARCHIVE_OP_ORDER) {
    if (found.has(kind)) return kind;
  }
  return null;
}

function archiveOpType(detailJson) {
  try {
    const detail = detailJson ? JSON.parse(detailJson) : {};
    return classifyArchiveOp(detail.command || "");
  } catch (e) {
    return null;
  }
}

// Classifies network diagnostic tools. nc/ncat/netcat are counted on their own, which does not mean a reverse
// shell: the truly dangerous use like `nc -e /bin/sh` is already blocked/warned by policy.py's
// reverse_shell_pattern rule. This is only the broader visibility count "this command used a tool like
// nc/nmap/telnet", a separate matter from risk judgement.
const NETDIAG_OP_ORDER = ["nc", "nmap", "telnet", "other"];
function classifyNetdiagOp(cmd) {
  if (!cmd) return null;
  const segments = splitShellSegments(cmd).map((raw) => raw.trim().replace(/^sudo\s+/, ""));
  const found = new Set();
  for (const seg of segments) {
    if (/^(nc|ncat|netcat)(\s|$)/.test(seg)) found.add("nc");
    else if (/^nmap(\s|$)/.test(seg)) found.add("nmap");
    else if (/^telnet(\s|$)/.test(seg)) found.add("telnet");
    else if (/^socat(\s|$)/.test(seg)) found.add("other");
  }
  for (const kind of NETDIAG_OP_ORDER) {
    if (found.has(kind)) return kind;
  }
  return null;
}

function netdiagOpType(detailJson) {
  try {
    const detail = detailJson ? JSON.parse(detailJson) : {};
    return classifyNetdiagOp(detail.command || "");
  } catch (e) {
    return null;
  }
}

// Reverse-engineering tool calls, same idea as the network diagnostic tools: a pure visibility count, not a risk
// judgement. IDA/Ghidra/radare2/GDB are everyday tools for professional reverse engineers, everywhere in CTFs,
// vulnerability research and compliance security testing, so there is no reason to block them or ask for
// confirmation. But "has Claude used these tools to analyse some binary" is a visibility signal worth keeping;
// together with the session's cwd and command details it helps review which files a reverse-engineering task
// touched. Classified by tool family, not down to specific subcommand arguments.
const REVERSE_ENG_OP_ORDER = ["ida", "ghidra", "radare2", "gdb", "other"];
// In real data IDA/GDB are often called by absolute path (such as /opt/idapro-9.0/idat64); once installed they
// are rarely added to PATH, so matching only "^ida..." from the start would miss all those calls. Same idea as
// policy.py's _normalize_head: first strip any environment variable assignment prefix at the start of the
// subcommand (LD_LIBRARY_PATH=xxx PYTHONHOME=xxx gdb ...; this really occurs in production, attaching a custom
// runtime library path to gdb for cross-architecture debugging), then strip the executable's path prefix, and
// finally match the bare file name. The order matters: stripping the path prefix first would treat the
// assignment "LD_LIBRARY_PATH=/a/b/c" itself as a "path/file name" (the extracted "file name" would be the last
// part of the assignment, not the command actually running), so the environment variable layer must go first.
const ENV_ASSIGN_RE = /^(?:[A-Za-z_]\w*=(?:'[^']*'|"[^"]*"|\S*)\s+)+/;
function stripEnvAssignments(seg) {
  return seg.replace(ENV_ASSIGN_RE, "");
}
function stripPathPrefix(seg) {
  const m = seg.match(/^(\S*\/)(\S+)/);
  return m ? seg.slice(m[1].length) : seg;
}
// On macOS, GUI reverse-engineering tools like IDA/Ghidra/Hopper/Binary Ninja are often packaged as .app and
// launched with `open -a "IDA Pro"` rather than a bare executable name. This call form is recognised separately,
// alongside the executable-name matching above.
const MACOS_OPEN_APP_RE = /^open\s+(-\S+\s+)*-a\s+["']?([^"'\n]+?)["']?(\s|$)/;
function classifyReverseEngOp(cmd) {
  if (!cmd) return null;
  const segments = splitShellSegments(cmd)
    .map((raw) => raw.trim().replace(/^sudo\s+/, ""))
    .map(stripEnvAssignments)
    .map(stripPathPrefix);
  const found = new Set();
  for (const seg of segments) {
    if (/^ida(t|q)?(64)?(\.exe)?(\s|$)/.test(seg)) found.add("ida");
    else if (/^(ghidraRun|analyzeHeadless|ghidraSvr)(\s|$)/.test(seg)) found.add("ghidra");
    else if (/^(radare2|r2|rizin|rz-\w+|cutter)(\s|$)/.test(seg)) found.add("radare2");
    else if (/^(gdb|gdb-multiarch|cgdb|gdbserver|pwndbg)(\s|$)/.test(seg)) found.add("gdb");
    else if (
      /^(binaryninja|binja|hopperv?4?|x(64|32)dbg|windbg|cdb|ollydbg|immunitydebugger|dnspy|jadx(-gui)?|apktool|dex2jar|jd-gui|frida(-[\w-]+)?|objection|retdec-decompiler|binwalk|checksec|diaphora|bindiff|uncompyle6|decompyle3|pycdc)(\s|$)/.test(
        seg
      )
    )
      found.add("other");
    else {
      const appMatch = MACOS_OPEN_APP_RE.exec(seg);
      if (appMatch && /\b(ida|ghidra|hopper|binary\s*ninja)\b/i.test(appMatch[2])) {
        if (/\bida\b/i.test(appMatch[2])) found.add("ida");
        else if (/\bghidra\b/i.test(appMatch[2])) found.add("ghidra");
        else found.add("other");
      }
    }
  }
  for (const kind of REVERSE_ENG_OP_ORDER) {
    if (found.has(kind)) return kind;
  }
  return null;
}

function reverseEngOpType(detailJson) {
  try {
    const detail = detailJson ? JSON.parse(detailJson) : {};
    return classifyReverseEngOp(detail.command || "");
  } catch (e) {
    return null;
  }
}

// Classifies process management / staying resident. nohup/disown/setsid are recognised by subcommand start, the
// same approach. A "background job" (bare `&`) is different: it is not a command name but a shell syntax marker
// at the end of the whole command, so it cannot be matched at the subcommand starts from splitShellSegments()
// (which itself splits on a single `&`, after which you can no longer tell whether it was a background marker).
// Instead, search the raw command text for a "standalone `&`": not preceded by `&`/`>` (ruling out `&&`, `2>&1`,
// `&>`, which are not real background markers), not followed by a digit/`&`/`>` (likewise ruling out the
// `2>&1`/`&>` file descriptor redirects), and followed (after whitespace) directly by the end of the command or
// `;`. This catches only the most typical "the command ends here, sent to the background" form. A rarer form
// like `task1 & task2` (backgrounding followed directly by the next command with no `;`) is missed, a deliberate
// narrowing so that an `&` in a URL query string like `curl 'http://x.com/a&b=c'` is not hit.
const BG_JOB_RE = /[^&>]&(?![&>0-9])\s*(;|$)/m;
const PROCMGMT_OP_ORDER = ["nohup", "disown", "backgroundJob", "other"];
function classifyProcessBackground(cmd) {
  if (!cmd) return null;
  const segments = splitShellSegments(cmd).map((raw) => raw.trim().replace(/^sudo\s+/, ""));
  const found = new Set();
  for (const seg of segments) {
    if (/^nohup(\s|$)/.test(seg)) found.add("nohup");
    else if (/^disown(\s|$)/.test(seg)) found.add("disown");
    else if (/^setsid(\s|$)/.test(seg)) found.add("other");
  }
  if (!found.size && BG_JOB_RE.test(cmd)) found.add("backgroundJob");
  for (const kind of PROCMGMT_OP_ORDER) {
    if (found.has(kind)) return kind;
  }
  return null;
}

function processBackgroundType(detailJson) {
  try {
    const detail = detailJson ? JSON.parse(detailJson) : {};
    return classifyProcessBackground(detail.command || "");
  } catch (e) {
    return null;
  }
}

// Extracts target host names from the command text. Three forms are accepted, all requiring a clear syntax marker
// with low false-match risk; a "bare word that looks like a domain" is not accepted:
//   1. URL form: scheme://[user@]host[:port]/… (wget/curl/aria2/axel/lftp/http(s))
//   2. user@host (typical for ssh/sftp; the @ is a strong signal and will not be confused with a local file name)
//   3. host:path (scp/rsync remote spec; user@ is optional, but the colon must follow directly)
// Deliberately not accepted: a "bare host name with neither @ nor colon" (such as `ssh myserver`, or the local
// source file file.txt in `scp file.txt user@host:/path`). The first version used a broader regex that took the
// output file name in `-o out.tar.gz` and scp's local source file name for "host names", because those file
// names are also dotted strings followed by whitespace, and pure regex cannot tell them apart from a target host
// by shape. Better to miss an internal short name, a real edge case, than to take any dotted word in a command
// for a host name.
const URL_HOST_RE = /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(?:[^\s@/]+@)?([^\s/:?#'"]+)/g;
const AT_HOST_RE = /@((?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}|(?:\d{1,3}\.){3}\d{1,3})/g;
const COLON_HOST_RE = /(?:^|[\s])((?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}|(?:\d{1,3}\.){3}\d{1,3}):(?=[\w~./]|$)/g;

function extractCommandHosts(text) {
  if (!text) return [];
  const hosts = new Set();
  let m;
  URL_HOST_RE.lastIndex = 0;
  while ((m = URL_HOST_RE.exec(text))) hosts.add(m[1].toLowerCase());
  AT_HOST_RE.lastIndex = 0;
  while ((m = AT_HOST_RE.exec(text))) hosts.add(m[1].toLowerCase());
  COLON_HOST_RE.lastIndex = 0;
  while ((m = COLON_HOST_RE.exec(text))) hosts.add(m[1].toLowerCase());
  return Array.from(hosts);
}

// Which subcommands count as "made a network request". Broader than the download stats (DOWNLOAD_OP_ORDER): that
// one deliberately excludes bare curl without -o/-O (so pure API calls are not counted as "downloads"), but for
// the AI trail a bare curl API call is itself a real network request and belongs in the trail; the narrower
// download definition does not apply. For git only clone/pull/fetch/push, which really open network
// connections, count; commit is purely local and does not. In the ssh family, keyManagement (ssh-keygen etc.) is
// local and likewise does not count.
function isNetworkTouchingSegment(seg) {
  return (
    /^(wget2?|curl|aria2c?|axel|lftp|ftp|https?)(\s|$)/.test(seg) ||
    /^git\s+(clone|pull|fetch|push)\b/.test(seg) ||
    /^(ssh|scp|sftp|autossh|sshpass)(\s|$)/.test(seg)
  );
}

// Commands Claude ran through Bash that involve network requests. This is a different kind of evidence from the
// system-layer probe (os_net, a real connect() observed): here the command text only "looks like it goes
// online", which does not mean it connected (it may fail, time out or be blocked by policy), and there is no
// byte count. The user explicitly asked that such commands appear in the "AI trail" even when the probe did not
// capture them (many people have never started the system-layer probe by hand, and before this there was no
// visibility at all). Only hook_pre events Claude itself triggered are considered; commands a user types in
// another terminal never pass through Claude Code's hooks, so they never appear here.
// Target domains of WebFetch requests: like the Bash command inference, these "look like they go online" rather
// than being real connections measured by the probe, and are merged into the same AI trail data. WebFetch's url
// field is already a full URL, so there is no need for extractCommandHosts(), the regex designed for shell
// command text to avoid taking local file names for host names; parsing the host with URL() is more accurate.
// WebSearch's query field holds search keywords, not a URL, has no domain to extract, and so is naturally absent.
function webFetchHostRows(db, limit) {
  const rows = db
    .prepare(
      `SELECT id, ts, session_id, cwd, detail FROM events
       WHERE source = 'hook_pre' AND tool_name = 'WebFetch'
       ORDER BY id DESC LIMIT ?`
    )
    .all(limit);
  const out = [];
  for (const row of rows) {
    let detail;
    try {
      detail = row.detail ? JSON.parse(row.detail) : {};
    } catch (e) {
      continue;
    }
    const url = detail.url || "";
    let host;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch (e) {
      continue;
    }
    if (!host) continue;
    out.push({ id: row.id, ts: row.ts, sessionId: row.session_id, cwd: row.cwd, command: `WebFetch: ${url}`, host });
  }
  return out;
}

function commandNetworkHosts(limit = 2000) {
  return withDb((db) => {
    const rows = db
      .prepare(
        `SELECT id, ts, session_id, cwd, detail FROM events
         WHERE source = 'hook_pre' AND tool_name = 'Bash'
         ORDER BY id DESC LIMIT ?`
      )
      .all(limit);
    const out = [];
    for (const row of rows) {
      let detail;
      try {
        detail = row.detail ? JSON.parse(row.detail) : {};
      } catch (e) {
        continue;
      }
      const cmd = detail.command || "";
      const segments = splitShellSegments(cmd).map((raw) => raw.trim().replace(/^sudo\s+/, ""));
      const hostsInCmd = new Set();
      for (const seg of segments) {
        if (!isNetworkTouchingSegment(seg)) continue;
        for (const host of extractCommandHosts(seg)) hostsInCmd.add(host);
      }
      for (const host of hostsInCmd) {
        out.push({ id: row.id, ts: row.ts, sessionId: row.session_id, cwd: row.cwd, command: cmd, host });
      }
    }
    return out.concat(webFetchHostRows(db, limit));
  }, []);
}

// Screenshot audit. Claude Code has no built-in "screenshot" tool; observed screenshot activity follows three
// paths, each judged independently by its most likely signal source:
//   1. A Bash command calls a screenshot CLI tool. Same idea as commandDeletesFiles(): split into subcommands
//      with splitShellSegments() and look at each start, no substring matching on the whole command text (so
//      output like "echo screenshot done" is not misjudged). The list used to include ImageMagick's import
//      command, which production data showed was a bad idea: "import" is an extremely common Python keyword.
//      Even with splitShellSegments() correctly skipping newlines inside quotes/heredocs, any line of a user's
//      own shell script that really starts with a bare "import ..." (for example inside backticks or an unquoted
//      command substitution) would still be taken for a screenshot tool call. ImageMagick's import is also
//      marginal on modern Linux desktops (grim/flameshot/spectacle/gnome-screenshot are more common); dropping
//      it cut false positives by far more than the recall it lost.
//      Under Wayland the usual route is a D-Bus request through xdg-desktop-portal (gdbus/dbus-send calling the
//      org.freedesktop.portal.Screenshot interface), where command-line tools do not work; judged separately.
//   2. The file the Read tool opens is itself an image. Not strictly "a screenshot" (it may be the user's own
//      photo or design), but from the angle of "Claude saw screen/image content" the user explicitly asked for
//      this case to count too, accepting broader recall than pure screenshot detection.
//   3. Screenshot actions of MCP / "computer use" tools: the tool name contains "screenshot" (common in tool
//      names exposed by browser automation MCP servers like Playwright/Puppeteer, such as
//      mcp__playwright__browser_take_screenshot), or Anthropic Computer Use's "computer" tool with the action
//      field equal to "screenshot".
// Screenshot methods are covered as broadly as possible: desktop screenshot tools (X11 / Wayland / macOS /
// Windows), screen recording, direct framebuffer reads, screen-capture libraries called from scripts, headless
// browser / web page screenshot tools, and virtual machine / remote device screen capture.
// They fall into three classes: cliTool (host screen), headless (web pages), vm (virtual machine / remote device).

// —— Host desktop screenshot tools / screen recording / framebuffer ——
const SCREENSHOT_CLI_RE =
  /^(scrot|maim|xwd|shutter|escrotum|ksnip|gscreenshot|deepin-screenshot|xfce4-screenshooter|gnome-screenshot|spectacle|flameshot|screencapture|snippingtool|nircmd|nircmdc|grim|grimshot|wayshot|swappy|hyprshot|slurp|fbgrab|fbcat|recordmydesktop|simplescreenrecorder|vokoscreen|kazam|wf-recorder|wl-screenrec|peek)\b/i;
// ImageMagick's import / magick import clash with Python's `import x`, so they only count with screenshot options
// or an image file name (in production `python3 -c "import socket, os"` was misjudged as a screenshot).
const SCREENSHOT_IMPORT_RE =
  /^(magick\s+import|import)\b[^\n]*?(\s-(window|screen|root|crop)\b|\.(png|jpe?g|gif|bmp|tiff?|webp|xwd|ppm)(\s|$))/i;
// Desktop portal (under Wayland, screenshots often go through DBus rather than a command-line tool)
const SCREENSHOT_PORTAL_RE = /^(gdbus|dbus-send|qdbus|busctl)\b/i;
// Screen recording also "takes the screen content", just as continuous frames
const SCREENSHOT_FFMPEG_RE = /^(ffmpeg|gst-launch-1\.0)\b/i;
const SCREENSHOT_FFMPEG_SCREEN_RE =
  /-f\s+(x11grab|gdigrab|avfoundation|kmsgrab)\b|ximagesrc|dxgiscreencapsrc|avfvideosrc\s+capture-screen/i;
// Screen-capture libraries called directly from scripts (Python/Node/PowerShell): the head is the interpreter, so match by API name
const SCREENSHOT_HOST_API_RE =
  /\bImageGrab\.grab\s*\(|\bpyautogui\.screenshot\s*\(|\bpyscreenshot\.grab\s*\(|\bmss\.mss\s*\(|\bsct\.(shot|grab)\s*\(|\brobotjs\.screen\.capture\s*\(|\bscreenshot-desktop\b|\bCopyFromScreen\s*\(/i;

// —— Headless browsers / web page screenshots ——
const SCREENSHOT_WEB_TOOL_RE =
  /^(shot-scraper|wkhtmltoimage|cutycapt|gowitness|aquatone|eyewitness|webscreenshot|pageres|capture-website)\b/i;
const SCREENSHOT_RUNTIME_RE =
  /^(google-chrome(-stable|-beta|-unstable)?|chromium(-browser)?|chrome|msedge|microsoft-edge|firefox|node|nodejs|deno|bun|python3?|npx|pnpm|yarn|playwright|puppeteer|chromedriver|geckodriver)\b/i;
const SCREENSHOT_API_RE =
  /--screenshots?\b|--screenshot=|\bcaptureScreenshot\b|\bpage\.screenshot\s*\(|\bbrowser_take_screenshot\b|\bsave_screenshot\s*\(|\bget_screenshot_as_\w+\s*\(|\btake_screenshot\s*\(/i;

// —— Virtual machine / remote device screen capture ——
// QEMU's screendump (HMP, or {"execute":"screendump"} over a QMP socket), libvirt, VirtualBox, VMware, VNC,
// Android adb screencap, iOS. These capture the guest's/device's screen, which is not the same as a host desktop
// screenshot, but screen content is still taken. The audit database really had 170+ of these, and none were
// recognised before.
const SCREENSHOT_VM_RE =
  /\bscreendump\b|\bvirsh\s+screenshot\b|\bVBoxManage\b[^\n]*\bscreenshotpng\b|\bvmrun\b[^\n]*\bcaptureScreen\b|\bvncsnapshot\b|\bvncdo(tool)?\b[^\n]*\bcapture\b|\badb\b[^\n]*\bscreencap\b|\bidevicescreenshot\b|\bsimctl\b[^\n]*\bscreenshot\b/i;
// Pure search / file management commands only "mention" these keywords (grep searching for them, rm deleting outputs); not real screenshots
const SCREENSHOT_TEXT_TOOL_RE =
  /^(grep|rg|ag|ack|sed|awk|ls|find|rm|mv|cp|git|diff|wc|sort|uniq|less|more|nano|vim|vi|code|echo|printf|cat|head|tail)\b/i;

const SCREENSHOT_IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

// Wrapper stripping at the start of a subcommand: environment variable assignments (DISPLAY=:1 …), wrapper
// commands such as sudo/env/timeout/nohup, and the executable's path prefix (/usr/bin/scrot -> scrot). It used to
// strip only sudo, so `DISPLAY=:1 import -window …` and `timeout 60 google-chrome …` all failed to match.
const SEG_ENV_ASSIGN_RE = /^(?:[A-Za-z_]\w*=(?:'[^']*'|"[^"]*"|\S*)\s+)+/;
const SEG_WRAPPER_RE = /^(?:sudo(?:\s+-\S+)*|doas|env(?:\s+-\S+)*|nohup|nice(?:\s+-n\s*\S+)?|time|command|exec|xargs(?:\s+-\S+)*|timeout(?:\s+-\S+)*\s+\S+)\s+/;
function normalizeSegHead(raw) {
  let seg = (raw || "").trim().replace(/^[({]\s*/, "");
  for (let i = 0; i < 5; i++) {
    const before = seg;
    seg = seg.replace(SEG_ENV_ASSIGN_RE, "").replace(SEG_WRAPPER_RE, "");
    if (seg === before) break;
  }
  return seg.replace(/^(\S*\/)(\S+)/, "$2");
}

// Returns which screenshot method this Bash command belongs to: "cliTool" (screenshot tool / screen recording) or
// "headless" (browser or automation-script screenshot); null if neither.
function screenshotCommandKind(cmd) {
  if (!cmd) return null;
  for (const raw of splitShellSegments(cmd)) {
    const seg = normalizeSegHead(raw);
    if (!seg) continue;
    // Host screen
    if (SCREENSHOT_CLI_RE.test(seg)) return "cliTool";
    if (SCREENSHOT_IMPORT_RE.test(seg)) return "cliTool";
    if (SCREENSHOT_PORTAL_RE.test(seg) && /screenshot/i.test(seg)) return "cliTool";
    if (SCREENSHOT_FFMPEG_RE.test(seg) && SCREENSHOT_FFMPEG_SCREEN_RE.test(seg)) return "cliTool";
    if (SCREENSHOT_HOST_API_RE.test(seg)) return "cliTool";
    // Web pages
    if (SCREENSHOT_WEB_TOOL_RE.test(seg)) return "headless";
    if (SCREENSHOT_RUNTIME_RE.test(seg) && SCREENSHOT_API_RE.test(seg)) return "headless";
    // Virtual machine / remote device
    if (!SCREENSHOT_TEXT_TOOL_RE.test(seg) && SCREENSHOT_VM_RE.test(seg)) return "vm";
  }
  return null;
}

// Which category of "screenshot / viewing image content" the event belongs to; null if none.
// cliTool / headless = really took a screenshot; imageRead = only read an image file; mcp = a screenshot action of
// an MCP or computer-use tool.
function screenshotKind(toolName, detailJson) {
  try {
    const detail = detailJson ? JSON.parse(detailJson) : {};
    if (toolName === "Bash") return screenshotCommandKind(detail.command || "");
    if (toolName === "Read") {
      const filePath = detail.file_path || detail.path || "";
      return SCREENSHOT_IMAGE_EXT_RE.test(filePath) ? "imageRead" : null;
    }
    if (toolName === "computer" && detail.action === "screenshot") return "mcp";
    if (toolName && toolName !== "Bash" && toolName !== "Read" && /screenshot/i.test(toolName)) return "mcp";
    return null;
  } catch (e) {
    return null;
  }
}

function isScreenCaptureEvent(toolName, detailJson) {
  return screenshotKind(toolName, detailJson) ? 1 : 0;
}

// Sensitive operation stats. Unlike the SSH/download/Docker classifiers it does not recognise command text from
// scratch; it reuses the matched_rule policy.py has already computed. These five rules are all the existing
// coverage for "reading sensitive information": sensitive_file_read (Read tool), sensitive_file_read_bash (Bash
// commands like cat/less/head), env_dump (env/printenv/export -p), history_read (touching history files in any
// way in Bash, bare history/fc -l) and history_file_read (Read/Grep tools reading history files directly). There
// is no need for a duplicate set of regexes on the JS side; if one side's regex changed some day, the two would
// easily drift apart. When sensitive_file_read/sensitive_file_read_bash match, the path is further split by
// whether it is an SSH key (.ssh/, id_rsa, id_ed25519, known_hosts); if not (.env/.aws/credentials/.pem/.p12) it
// goes under "credentials/token"; env_dump on its own is "environment variable lookup"; history_read/
// history_file_read go under "other sensitive operations".
// The same ids appear in the SQL of sensitiveOpsBreakdown/sensitiveOpsEvents below (SENSITIVE_READ_RULES_SQL);
// change both places when adding a rule.
const SENSITIVE_OP_ORDER = ["sshKey", "credential", "envVar", "other"];
const SENSITIVE_SSH_KEY_RE = /\.ssh\/|id_rsa|id_ed25519|known_hosts/i;
const SENSITIVE_READ_RULES = new Set(["sensitive_file_read", "sensitive_file_read_bash", "env_dump", "history_read", "history_file_read"]);
const SENSITIVE_READ_RULES_SQL = [...SENSITIVE_READ_RULES].map((r) => `'${r}'`).join(", ");
function classifySensitiveOp(matchedRule, text) {
  if (matchedRule === "env_dump") return "envVar";
  if (matchedRule === "history_read" || matchedRule === "history_file_read") return "other";
  if (matchedRule === "sensitive_file_read" || matchedRule === "sensitive_file_read_bash") {
    return SENSITIVE_SSH_KEY_RE.test(text || "") ? "sshKey" : "credential";
  }
  return null;
}

function sensitiveOpType(toolName, matchedRule, detailJson) {
  if (!SENSITIVE_READ_RULES.has(matchedRule)) return null;
  try {
    const detail = detailJson ? JSON.parse(detailJson) : {};
    // Bash: look at command; Read: file_path; Grep and similar: path (consistent with policy.py's
    // FIELD_CANDIDATES).
    const text = toolName === "Bash" ? detail.command || "" : detail.file_path || detail.path || "";
    return classifySensitiveOp(matchedRule, text);
  } catch (e) {
    return null;
  }
}

// Sensitive data stats. Same idea as the "sensitive operation stats" above (reuse the matched_rule policy.py has
// computed, no duplicate regexes in JS), but covering the other half: the group above is about "reading"
// sensitive information (reading SSH keys, dumping environment variables, browsing command history); this group
// is about "what the sensitive information itself looks like": credential formats of cloud providers / code
// hosting platforms appearing in written content, PII (ID numbers / phone numbers / email addresses), and
// reading/writing VPN/cloud CLI config files.
// The secret_pattern_in_write and pii_pattern_in_write rules match the content field (Write uses content, Edit
// uses new_string, NotebookEdit uses new_source, depending on which tool triggered it); the two
// cloud_vpn_config_write/read rules match file_path. Check which rule matched before choosing the field; unlike
// the SSH key group, a single fixed field cannot be used.
const SENSITIVE_DATA_RULES = new Set(["secret_pattern_in_write", "pii_pattern_in_write", "cloud_vpn_config_write", "cloud_vpn_config_read"]);
const SENSITIVE_DATA_PATH_RULES = new Set(["cloud_vpn_config_write", "cloud_vpn_config_read"]);
const SENSITIVE_VPN_RE = /\.ovpn|wireguard|wg0\.conf|PrivateKey\s*=/i;
function classifySensitiveData(matchedRule, text) {
  if (matchedRule === "pii_pattern_in_write") return "pii";
  if (matchedRule === "cloud_vpn_config_write" || matchedRule === "cloud_vpn_config_read" || matchedRule === "secret_pattern_in_write") {
    return SENSITIVE_VPN_RE.test(text || "") ? "vpnConfig" : "credential";
  }
  return "other";
}

function sensitiveDataType(toolName, matchedRule, detailJson) {
  if (!SENSITIVE_DATA_RULES.has(matchedRule)) return null;
  try {
    const detail = detailJson ? JSON.parse(detailJson) : {};
    const text = SENSITIVE_DATA_PATH_RULES.has(matchedRule)
      ? detail.file_path || detail.path || ""
      : detail.content || detail.new_string || detail.new_source || "";
    return classifySensitiveData(matchedRule, text);
  } catch (e) {
    return null;
  }
}

// Advanced threat detection. Same idea as the two groups above (reuse the matched_rule policy.py has computed).
// It covers the batch of rules added following the directory categories of al0ne/suricata-rules: mining pool
// domains, MySQL arbitrary file writes dropping a webshell, webshell one-liner code signatures, scripts that
// download and then execute in steps, penetration testing / C2 framework tool calls, and DNS/ICMP covert tunnel
// tool calls. Each matched_rule maps to a fixed category, with no need to inspect field contents to
// disambiguate as the sensitive data group does. To add a rule, add its id to ADVANCED_THREAT_RULE_MAP; one
// category can have several rules (for example the command/write variants of the mining pool domain rule).
const ADVANCED_THREAT_ORDER = ["cryptoMining", "dbFileWrite", "webshell", "reverseEscapeShell", "downloadExec", "c2Framework", "postExploitation", "suspiciousMcp", "pentestRecon", "covertTunnel"];
const ADVANCED_THREAT_RULE_MAP = {
  crypto_miner_pool_domain_command: "cryptoMining",
  crypto_miner_pool_domain_write: "cryptoMining",
  db_arbitrary_file_write: "dbFileWrite",
  db_arbitrary_file_write_content: "dbFileWrite",
  webshell_pattern_in_write: "webshell",
  reverse_shell_pattern: "reverseEscapeShell",
  shell_escape_via_utility: "reverseEscapeShell",
  curl_download_then_exec: "downloadExec",
  c2_framework_execution: "c2Framework",
  post_exploitation_tool_execution: "postExploitation",
  mcp_suspicious_tool_name: "suspiciousMcp",
  pentest_recon_tool_execution: "pentestRecon",
  covert_tunnel_tool_execution: "covertTunnel",
};
const ADVANCED_THREAT_RULES = new Set(Object.keys(ADVANCED_THREAT_RULE_MAP));
const ADVANCED_THREAT_RULES_SQL = [...ADVANCED_THREAT_RULES].map((r) => `'${r}'`).join(", ");
function advancedThreatType(matchedRule) {
  return ADVANCED_THREAT_RULE_MAP[matchedRule] || null;
}

// Cross-workdir operations: the four rules with match="workdir" in policy.py (cc_monitor/workdir.py grades them by
// "where the path is relative to cwd × read/write"). Here too they are only grouped by matched_rule, with no path
// recalculation in JS. Note these rules sit near the end of the rule table as a fallback: an event like reading
// ~/.ssh that a more specific rule matches first is counted under that rule (the sensitive operation card) and
// does not appear here again.
const WORKDIR_ESCAPE_ORDER = ["writeSensitive", "writeOther", "readSensitive", "readOther"];
const WORKDIR_ESCAPE_RULE_MAP = {
  workdir_escape_write_sensitive: "writeSensitive",
  workdir_escape_write_other: "writeOther",
  workdir_escape_read_sensitive: "readSensitive",
  workdir_escape_read_other: "readOther",
};
const WORKDIR_ESCAPE_RULES_SQL = Object.keys(WORKDIR_ESCAPE_RULE_MAP).map((r) => `'${r}'`).join(", ");
function workdirEscapeType(matchedRule) {
  return WORKDIR_ESCAPE_RULE_MAP[matchedRule] || null;
}

function withDb(fn, fallback) {
  let db;
  try {
    db = new Database(dbPath(), { readonly: true, fileMustExist: true });
    db.function("cc_is_delete", isDeleteEvent);
    db.function("cc_github_op", githubOpType);
    db.function("cc_is_screenshot", isScreenCaptureEvent);
    db.function("cc_screenshot_kind", screenshotKind);
    db.function("cc_ssh_op", sshOpType);
    db.function("cc_download_op", downloadOpType);
    db.function("cc_filesend_op", fileSendOpType);
    db.function("cc_docker_op", dockerOpType);
    db.function("cc_archive_op", archiveOpType);
    db.function("cc_netdiag_op", netdiagOpType);
    db.function("cc_reverseeng_op", reverseEngOpType);
    db.function("cc_procbg_op", processBackgroundType);
    db.function("cc_sensitive_op", sensitiveOpType);
    db.function("cc_sensitive_data", sensitiveDataType);
    db.function("cc_advanced_threat", advancedThreatType);
    db.function("cc_workdir_escape", workdirEscapeType);
    return fn(db);
  } catch (e) {
    return fallback;
  } finally {
    if (db) db.close();
  }
}

// The `transcript_path` column is added lazily by an ALTER TABLE after cc_monitor/storage.py upgrades (see
// storage.py's `_connect()`), so an old database lacks it until the new hook first runs. The Node side has a
// read-only connection and cannot add the column itself, so probe before querying and degrade gracefully if it
// is missing.
function hasTranscriptColumn(db) {
  try {
    const cols = db.prepare(`PRAGMA table_info(events)`).all();
    return cols.some((c) => c.name === "transcript_path");
  } catch (e) {
    return false;
  }
}

function listSessions(limit = 200) {
  return withDb((db) => {
    const withTranscript = hasTranscriptColumn(db);
    return db
      .prepare(
        `SELECT session_id, cwd, MIN(ts) AS first_ts, MAX(ts) AS last_ts, COUNT(*) AS event_count,
                SUM(CASE WHEN decision = 'blocked' THEN 1 ELSE 0 END) AS blocked_count,
                SUM(CASE WHEN matched_rule = 'hook_bypass_suspected' THEN 1 ELSE 0 END) AS bypass_count
                ${withTranscript ? ", MAX(transcript_path) AS transcript_path" : ""}
         FROM events
         WHERE session_id IS NOT NULL AND session_id != ''
         GROUP BY session_id
         ORDER BY last_ts DESC
         LIMIT ?`
      )
      .all(limit);
  }, []);
}

function getTranscriptPath(sessionId) {
  return withDb((db) => {
    if (!hasTranscriptColumn(db)) return null;
    const row = db
      .prepare(
        `SELECT transcript_path FROM events
         WHERE session_id = ? AND transcript_path IS NOT NULL AND transcript_path != ''
         ORDER BY id DESC LIMIT 1`
      )
      .get(sessionId);
    return row ? row.transcript_path : null;
  }, null);
}

function queryEvents({ sessionId, sinceId = 0, limit = 300 } = {}) {
  return withDb((db) => {
    let sql = `SELECT id, ts, session_id, source, tool_name, cwd, risk, matched_rule, decision, detail
               FROM events WHERE id > ?`;
    const params = [sinceId];
    if (sessionId) {
      sql += ` AND session_id = ?`;
      params.push(sessionId);
    }
    sql += ` ORDER BY id ASC LIMIT ?`;
    params.push(limit);
    return db.prepare(sql).all(...params);
  }, []);
}

function stats() {
  return withDb((db) => {
    const byRisk = db.prepare(`SELECT risk, COUNT(*) AS n FROM events GROUP BY risk`).all();
    const byDecision = db.prepare(`SELECT decision, COUNT(*) AS n FROM events GROUP BY decision`).all();
    const bySource = db.prepare(`SELECT source, COUNT(*) AS n FROM events GROUP BY source`).all();
    const total = db.prepare(`SELECT COUNT(*) AS n FROM events`).get().n;
    const sessionCount = db
      .prepare(`SELECT COUNT(DISTINCT session_id) AS n FROM events WHERE session_id IS NOT NULL AND session_id != ''`)
      .get().n;
    const blockedTotal = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE decision = 'blocked'`).get().n;
    const bypassTotal = db
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE matched_rule = 'hook_bypass_suspected'`)
      .get().n;
    // Bypass detection relies on comparing kernel-level execve observations with hook records, and only the Linux
    // bpftrace probe produces those. The macOS probe uses nettop and covers only the network, so bypassTotal is always
    // 0 on macOS. The front end must be able to tell "checked, and it is 0" from "this check never ran on this
    // platform"; otherwise that 0 reads like a safety verdict when it is really a missing capability.
    const bypassSupported = process.platform !== "darwin";
    return { total, sessionCount, blockedTotal, bypassTotal, bypassSupported, byRisk, byDecision, bySource };
  }, { total: 0, sessionCount: 0, blockedTotal: 0, bypassTotal: 0, bypassSupported: process.platform !== "darwin", byRisk: [], byDecision: [], bySource: [] });
}

// File read/write/edit/delete counts. There is no dedicated delete tool (Claude Code has no built-in "delete
// file" tool), so deletions are recognised by parsing Bash command text (only the detail.command field itself,
// split into subcommands at ; & | to check whether they start with rm/rmdir/unlink/shred/git rm/find -delete
// etc.); see commandDeletesFiles() above. Not 100% accurate (for example deletions inside $() command
// substitution are missed), but far more accurate than the old whole-string LIKE substring match.
const DELETE_CLAUSE = `source = 'hook_pre' AND tool_name = 'Bash' AND cc_is_delete(detail) = 1`;

function fileOpsStats() {
  return withDb((db) => {
    const countTool = (names) => {
      const placeholders = names.map(() => "?").join(",");
      return db
        .prepare(
          `SELECT COUNT(*) AS n FROM events WHERE source = 'hook_pre' AND tool_name IN (${placeholders})`
        )
        .get(...names).n;
    };
    const reads = countTool(["Read"]);
    const writes = countTool(["Write"]);
    const edits = countTool(["Edit", "MultiEdit", "NotebookEdit"]);
    const deletes = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE ${DELETE_CLAUSE}`).get().n;
    return { reads, writes, edits, deletes };
  }, { reads: 0, writes: 0, edits: 0, deletes: 0 });
}

const FILE_OP_TOOLS = {
  read: ["Read"],
  write: ["Write"],
  edit: ["Edit", "MultiEdit", "NotebookEdit"],
};

// Drill-down details for the home page file operation cards (read/write/edit/delete): which events exactly.
function fileOpDetails(type, limit = 300) {
  return withDb((db) => {
    if (type === "delete") {
      return db
        .prepare(`SELECT id, ts, session_id, cwd, tool_name, matched_rule, detail FROM events WHERE ${DELETE_CLAUSE} ORDER BY id DESC LIMIT ?`)
        .all(limit);
    }
    const tools = FILE_OP_TOOLS[type];
    if (!tools) return [];
    const placeholders = tools.map(() => "?").join(",");
    return db
      .prepare(
        `SELECT id, ts, session_id, cwd, tool_name, matched_rule, detail FROM events
         WHERE source = 'hook_pre' AND tool_name IN (${placeholders})
         ORDER BY id DESC LIMIT ?`
      )
      .all(...tools, limit);
  }, []);
}

// Software install stats. No separate recognition logic: reuse the matched_rule groups the policy rule engine has
// already judged (the pip / system package manager / npm / other rules are maintained in default_rules.json, so
// there is one copy of the recognition logic and it cannot disagree with policy's judgement).
const INSTALL_RULE_GROUPS = {
  pip: ["sudo_pip_install", "pip_install_venv_context", "pip_install_no_venv"],
  // uv gets its own card instead of being merged into pip: it is a different executable with different rules, and
  // its default behaviour is the opposite of pip's (with no active virtual environment uv errors out instead of
  // installing into the system Python). The risk profile differs, and mixing them would distort the count of "how
  // many installs went into the system Python".
  uv: ["sudo_uv_pip_install", "uv_pip_install_system", "uv_pip_install", "uv_project_install"],
  // conda/poetry/pipenv/pipx/pdm/rye: all Python packages, but neither pip nor uv, each managing its own
  // environment. Counted apart from pip because only the pip group can answer "how many installs may have gone into
  // the system Python".
  pythonOther: ["python_package_install_other", "python_legacy_install"],
  // npm / yarn / pnpm / bun / deno share one "JS package managers" card: to users they are the same thing, and five
  // cards would each show single digits with no sense of the total. The two global-install rules are in it too; the
  // drill-down can tell them apart.
  js: ["npm_global_install", "npm_local_install", "js_package_install_global", "js_package_install"],
  toolchain: ["toolchain_install"],
  system: ["system_package_install"],
  // Both the local and global rules count toward the total of this one "npm install" card; when the details are
  // opened the front end splits them by matchedRule into "local install" / "global install" groups (see the
  // install-op-npm special case in app.js) rather than one flat list.
  other: ["package_install_other", "source_build_install", "container_image_pull", "editor_plugin_install"],
};

function installGroupNames() {
  return Object.keys(INSTALL_RULE_GROUPS);
}

function installStats() {
  return withDb((db) => {
    const countRules = (rules) => {
      const placeholders = rules.map(() => "?").join(",");
      return db
        .prepare(`SELECT COUNT(*) AS n FROM events WHERE source = 'hook_pre' AND matched_rule IN (${placeholders})`)
        .get(...rules).n;
    };
    const out = {};
    for (const key of Object.keys(INSTALL_RULE_GROUPS)) out[key] = countRules(INSTALL_RULE_GROUPS[key]);
    return out;
  }, Object.fromEntries(Object.keys(INSTALL_RULE_GROUPS).map((k) => [k, 0])));
}

// Drill-down details for the home page software install card: which install commands exactly.
function installDetails(type, limit = 300) {
  const rules = INSTALL_RULE_GROUPS[type];
  if (!rules) return [];
  return withDb((db) => {
    const placeholders = rules.map(() => "?").join(",");
    return db
      .prepare(
        `SELECT id, ts, session_id, cwd, tool_name, matched_rule, detail FROM events
         WHERE source = 'hook_pre' AND matched_rule IN (${placeholders})
         ORDER BY id DESC LIMIT ?`
      )
      .all(...rules, limit);
  }, []);
}

// Operation stats for seven groups: GitHub/SSH/download/Docker/compression/network diagnostics/process management.
// The home page used to give each group a full row of per-category cards (30+ in total), far too cluttered; now
// each group has a single summary card, and opening it shows that group's subtotal table + event details, the
// same interaction as the MCP/Skill/subagent call cards. All seven share the same query shape, "classify with a
// custom cc_xxx_op() SQL function, GROUP BY kind", extracted into two generic functions; each group just passes a
// different function name.
function opsBreakdown(sqlFn) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT ${sqlFn}(detail) AS kind, COUNT(*) AS n FROM events
         WHERE source = 'hook_pre' AND tool_name = 'Bash' AND ${sqlFn}(detail) IS NOT NULL
         GROUP BY kind ORDER BY n DESC`
      )
      .all();
  }, []);
}

function opsEvents(sqlFn, limit = 300) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT id, ts, session_id, cwd, tool_name, matched_rule, detail, ${sqlFn}(detail) AS kind FROM events
         WHERE source = 'hook_pre' AND tool_name = 'Bash' AND ${sqlFn}(detail) IS NOT NULL
         ORDER BY id DESC LIMIT ?`
      )
      .all(limit);
  }, []);
}

function githubOpsBreakdown() {
  return opsBreakdown("cc_github_op");
}
function githubOpsEvents(limit = 300) {
  return opsEvents("cc_github_op", limit);
}
function sshOpsBreakdown() {
  return opsBreakdown("cc_ssh_op");
}
function sshOpsEvents(limit = 300) {
  return opsEvents("cc_ssh_op", limit);
}
function downloadOpsBreakdown() {
  return opsBreakdown("cc_download_op");
}
function downloadOpsEvents(limit = 300) {
  return opsEvents("cc_download_op", limit);
}
// File send stats are written separately and do not reuse the generic opsBreakdown()/opsEvents() above. Those two
// always filter on tool_name = 'Bash', but this category now spans three sources: Bash command text, the Artifact
// tool's asset upload, and MCP file-sending tools (see the comment above fileSendOpType()). The query shape
// follows sensitiveOpsBreakdown/sensitiveOpsEvents instead: cc_filesend_op() routes by tool_name itself and
// returns null when nothing matches, which does the filtering, rather than restricting to one tool name in the
// SQL WHERE.
function fileSendOpsBreakdown() {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT cc_filesend_op(tool_name, detail) AS kind, COUNT(*) AS n FROM events
         WHERE source = 'hook_pre' AND cc_filesend_op(tool_name, detail) IS NOT NULL
         GROUP BY kind ORDER BY n DESC`
      )
      .all();
  }, []);
}
function fileSendOpsEvents(limit = 300) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT id, ts, session_id, cwd, tool_name, matched_rule, detail, cc_filesend_op(tool_name, detail) AS kind FROM events
         WHERE source = 'hook_pre' AND cc_filesend_op(tool_name, detail) IS NOT NULL
         ORDER BY id DESC LIMIT ?`
      )
      .all(limit);
  }, []);
}
function dockerOpsBreakdown() {
  return opsBreakdown("cc_docker_op");
}
function dockerOpsEvents(limit = 300) {
  return opsEvents("cc_docker_op", limit);
}
function archiveOpsBreakdown() {
  return opsBreakdown("cc_archive_op");
}
function archiveOpsEvents(limit = 300) {
  return opsEvents("cc_archive_op", limit);
}
function netdiagOpsBreakdown() {
  return opsBreakdown("cc_netdiag_op");
}
function netdiagOpsEvents(limit = 300) {
  return opsEvents("cc_netdiag_op", limit);
}
function reverseEngOpsBreakdown() {
  return opsBreakdown("cc_reverseeng_op");
}
function reverseEngOpsEvents(limit = 300) {
  return opsEvents("cc_reverseeng_op", limit);
}
function procbgOpsBreakdown() {
  return opsBreakdown("cc_procbg_op");
}
function procbgOpsEvents(limit = 300) {
  return opsEvents("cc_procbg_op", limit);
}

// Sensitive operation stats (SSH keys/credentials, tokens, environment variable lookup, other sensitive reads).
// Unlike the groups above, this does not filter on tool_name='Bash' and then classify one detail field; it
// selects the events of the SENSITIVE_READ_RULES rules directly by matched_rule (spanning Read/Grep and Bash),
// so it cannot reuse the generic opsBreakdown()/opsEvents() above and is written separately.
function sensitiveOpsBreakdown() {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT cc_sensitive_op(tool_name, matched_rule, detail) AS kind, COUNT(*) AS n FROM events
         WHERE source = 'hook_pre' AND matched_rule IN (${SENSITIVE_READ_RULES_SQL})
         GROUP BY kind ORDER BY n DESC`
      )
      .all();
  }, []);
}

function sensitiveOpsEvents(limit = 300) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT id, ts, session_id, cwd, tool_name, matched_rule, detail, cc_sensitive_op(tool_name, matched_rule, detail) AS kind FROM events
         WHERE source = 'hook_pre' AND matched_rule IN (${SENSITIVE_READ_RULES_SQL})
         ORDER BY id DESC LIMIT ?`
      )
      .all(limit);
  }, []);
}

// Sensitive data stats: the query shape matches sensitiveOpsBreakdown/sensitiveOpsEvents above; only the
// matched_rule set differs (see the comment above sensitiveDataType).
function sensitiveDataBreakdown() {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT cc_sensitive_data(tool_name, matched_rule, detail) AS kind, COUNT(*) AS n FROM events
         WHERE source = 'hook_pre' AND matched_rule IN ('secret_pattern_in_write', 'pii_pattern_in_write', 'cloud_vpn_config_write', 'cloud_vpn_config_read')
         GROUP BY kind ORDER BY n DESC`
      )
      .all();
  }, []);
}

function sensitiveDataEvents(limit = 300) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT id, ts, session_id, cwd, tool_name, matched_rule, detail, cc_sensitive_data(tool_name, matched_rule, detail) AS kind FROM events
         WHERE source = 'hook_pre' AND matched_rule IN ('secret_pattern_in_write', 'pii_pattern_in_write', 'cloud_vpn_config_write', 'cloud_vpn_config_read')
         ORDER BY id DESC LIMIT ?`
      )
      .all(limit);
  }, []);
}

// Advanced threat detection: the query shape matches sensitiveOpsBreakdown/sensitiveDataBreakdown above, except
// the classifier needs only matched_rule as its argument (see the comment above advancedThreatType; no need to
// inspect field contents to disambiguate).
function advancedThreatBreakdown() {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT cc_advanced_threat(matched_rule) AS kind, COUNT(*) AS n FROM events
         WHERE source = 'hook_pre' AND matched_rule IN (${ADVANCED_THREAT_RULES_SQL})
         GROUP BY kind ORDER BY n DESC`
      )
      .all();
  }, []);
}

function advancedThreatEvents(limit = 300) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT id, ts, session_id, cwd, tool_name, matched_rule, detail, cc_advanced_threat(matched_rule) AS kind FROM events
         WHERE source = 'hook_pre' AND matched_rule IN (${ADVANCED_THREAT_RULES_SQL})
         ORDER BY id DESC LIMIT ?`
      )
      .all(limit);
  }, []);
}

// Cross-workdir operations: the query shape matches advancedThreatBreakdown/advancedThreatEvents.
function workdirEscapeBreakdown() {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT cc_workdir_escape(matched_rule) AS kind, COUNT(*) AS n FROM events
         WHERE source = 'hook_pre' AND matched_rule IN (${WORKDIR_ESCAPE_RULES_SQL})
         GROUP BY kind ORDER BY n DESC`
      )
      .all();
  }, []);
}

function workdirEscapeEvents(limit = 300) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT id, ts, session_id, cwd, tool_name, matched_rule, detail, cc_workdir_escape(matched_rule) AS kind FROM events
         WHERE source = 'hook_pre' AND matched_rule IN (${WORKDIR_ESCAPE_RULES_SQL})
         ORDER BY id DESC LIMIT ?`
      )
      .all(limit);
  }, []);
}

// The home page "screenshot audit" card: a single count, not split into categories like software install /
// GitHub operations. Screenshots are rare anyway, so there is no need for several cards by source (Bash/Read/MCP);
// the tool name on each row of the drill-down list already shows the source.
function screenshotStats() {
  return withDb((db) => {
    const total = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE source = 'hook_pre' AND cc_is_screenshot(tool_name, detail) = 1`).get().n;
    return { total };
  }, { total: 0 });
}

// Subtotals by method: real screenshots (screenshot tool / headless browser / MCP action) and "only opened an
// image" mixed into one number hide the difference. Before, the card's 391 events were almost all imageRead, and
// the only 3 screenshot commands could not be seen at all.
function screenshotBreakdown() {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT cc_screenshot_kind(tool_name, detail) AS kind, COUNT(*) AS n FROM events
         WHERE source = 'hook_pre' AND cc_is_screenshot(tool_name, detail) = 1
         GROUP BY kind ORDER BY n DESC`
      )
      .all();
  }, []);
}

function screenshotDetails(limit = 300) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT id, ts, session_id, cwd, tool_name, matched_rule, detail,
                cc_screenshot_kind(tool_name, detail) AS kind FROM events
         WHERE source = 'hook_pre' AND cc_is_screenshot(tool_name, detail) = 1
         ORDER BY id DESC LIMIT ?`
      )
      .all(limit);
  }, []);
}

// Tool call stats. The "total audit events" adds up hook_pre + hook_post + os_net, so one tool call counts at
// least twice (one pre, one post). Only hook_pre is counted here, matching the more intuitive number "how many
// tool calls Claude Code actually made".
function toolCallStats() {
  return withDb((db) => {
    const total = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE source = 'hook_pre'`).get().n;
    return { total };
  }, { total: 0 });
}

// Drill-down for the home page "tool calls" card: counts grouped by tool name (rather than listing every event
// flat; a number like "how many times Bash was called" says more than a screenful of events).
function toolCallBreakdown(limit = 100) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT tool_name, COUNT(*) AS n FROM events
         WHERE source = 'hook_pre'
         GROUP BY tool_name ORDER BY n DESC LIMIT ?`
      )
      .all(limit);
  }, []);
}

// MCP tool calls. Claude Code names the tools it provides for MCP servers in the uniform format
// `mcp__<server>__<tool>`, so no separate list of MCP servers is needed; recognise them by tool_name prefix.
const MCP_TOOL_PATTERN = "mcp\\_\\_%";

function mcpCallStats() {
  return withDb((db) => {
    const total = db
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE source = 'hook_pre' AND tool_name LIKE ? ESCAPE '\\'`)
      .get(MCP_TOOL_PATTERN).n;
    return { total };
  }, { total: 0 });
}

// Drill-down for the home page "MCP calls" card: grouped by MCP server (the server name parsed from the
// mcp__<server>__<tool> convention in tool_name) rather than by tool name. One server may have a dozen tools, and
// summing by server makes it easier to see "which MCP service it is actually dealing with".
function mcpCallBreakdown(limit = 100) {
  return withDb((db) => {
    const rows = db
      .prepare(`SELECT tool_name, COUNT(*) AS n FROM events WHERE source = 'hook_pre' AND tool_name LIKE ? ESCAPE '\\' GROUP BY tool_name`)
      .all(MCP_TOOL_PATTERN);
    const byServer = new Map();
    for (const r of rows) {
      const m = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(r.tool_name);
      const server = m ? m[1] : r.tool_name;
      byServer.set(server, (byServer.get(server) || 0) + r.n);
    }
    return [...byServer.entries()]
      .map(([server, n]) => ({ server, n }))
      .sort((a, b) => b.n - a.n)
      .slice(0, limit);
  }, []);
}

// Skill calls: same idea as MCP calls, except the grouping is not by tool_name prefix but by the skill field in
// tool_input (the tool name `Skill` never changes; which skill was called is all in detail.skill). SQLite's
// built-in json_extract reads it directly in SQL, so there is no need to read every row's detail and JSON.parse
// it in JS.
function skillCallStats() {
  return withDb((db) => {
    const total = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE source = 'hook_pre' AND tool_name = 'Skill'`).get().n;
    return { total };
  }, { total: 0 });
}

function skillCallBreakdown(limit = 100) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT COALESCE(json_extract(detail, '$.skill'), '?') AS skill, COUNT(*) AS n
         FROM events WHERE source = 'hook_pre' AND tool_name = 'Skill'
         GROUP BY skill ORDER BY n DESC LIMIT ?`
      )
      .all(limit);
  }, []);
}

// Glob/Grep call stats. These pure search tools are already in the "tool calls" total and its by-tool-name
// drill-down; they are pulled out here because searching is a behaviour pattern worth a separate glance (how many
// times the codebase was searched). Same idea as the MCP/Skill calls, except the grouping field is tool_name
// itself (Glob vs Grep), with no need for json_extract to pick another level out of detail.
function searchCallStats() {
  return withDb((db) => {
    const total = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE source = 'hook_pre' AND tool_name IN ('Glob', 'Grep')`).get().n;
    return { total };
  }, { total: 0 });
}

function searchCallBreakdown(limit = 100) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT tool_name, COUNT(*) AS n FROM events
         WHERE source = 'hook_pre' AND tool_name IN ('Glob', 'Grep')
         GROUP BY tool_name ORDER BY n DESC LIMIT ?`
      )
      .all(limit);
  }, []);
}

function searchCallEvents(limit = 300) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT id, ts, session_id, cwd, tool_name FROM events
         WHERE source = 'hook_pre' AND tool_name IN ('Glob', 'Grep')
         ORDER BY id DESC LIMIT ?`
      )
      .all(limit);
  }, []);
}

// TodoWrite usage frequency: pure stats with no security meaning, only how many calls. The drill-down event
// details also include the number of tasks in the list at each call (json_array_length computed directly in SQL,
// no need to read every row's detail and JSON.parse it in JS), without showing the task text. Like the other
// drill-down cards, it gives only basic information about "what scale of operation happened".
function todoCallStats() {
  return withDb((db) => {
    const total = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE source = 'hook_pre' AND tool_name = 'TodoWrite'`).get().n;
    return { total };
  }, { total: 0 });
}

function todoCallEvents(limit = 300) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT id, ts, session_id, cwd, COALESCE(json_array_length(detail, '$.todos'), 0) AS todoCount
         FROM events WHERE source = 'hook_pre' AND tool_name = 'TodoWrite'
         ORDER BY id DESC LIMIT ?`
      )
      .all(limit);
  }, []);
}

// The "event details" part of the drill-down for the tool call / MCP call / Skill call cards. Counts by tool name
// only show "used a lot or not", not "which session, which directory, when". These three functions fill that
// gap: they list recent events flat, with Session ID/cwd/timestamp.
function toolCallEvents(limit = 300) {
  return withDb((db) => {
    return db
      .prepare(`SELECT id, ts, session_id, cwd, tool_name FROM events WHERE source = 'hook_pre' ORDER BY id DESC LIMIT ?`)
      .all(limit);
  }, []);
}

function mcpCallEvents(limit = 300) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT id, ts, session_id, cwd, tool_name FROM events
         WHERE source = 'hook_pre' AND tool_name LIKE ? ESCAPE '\\'
         ORDER BY id DESC LIMIT ?`
      )
      .all(MCP_TOOL_PATTERN, limit);
  }, []);
}

function skillCallEvents(limit = 300) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT id, ts, session_id, cwd, COALESCE(json_extract(detail, '$.skill'), '?') AS skill FROM events
         WHERE source = 'hook_pre' AND tool_name = 'Skill'
         ORDER BY id DESC LIMIT ?`
      )
      .all(limit);
  }, []);
}

// Subagent (Task/Agent) spawn stats: exactly the same idea as MCP/Skill calls, except the grouping field is
// subagent_type in tool_input ("which subagent type was used", such as general-purpose/Explore/Plan/fork, or a
// user-defined subagent name). Claude Code versions differ on whether the tool is called "Task" or "Agent", so
// both are accepted. Subagents consume their own resources and have a whole trail of operations of their own,
// worth pulling out separately rather than mixing into the general "tool calls" count.
function subagentCallStats() {
  return withDb((db) => {
    const total = db
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE source = 'hook_pre' AND tool_name IN ('Task', 'Agent')`)
      .get().n;
    return { total };
  }, { total: 0 });
}

function subagentCallBreakdown(limit = 100) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT COALESCE(json_extract(detail, '$.subagent_type'), '?') AS subagentType, COUNT(*) AS n
         FROM events WHERE source = 'hook_pre' AND tool_name IN ('Task', 'Agent')
         GROUP BY subagentType ORDER BY n DESC LIMIT ?`
      )
      .all(limit);
  }, []);
}

function subagentCallEvents(limit = 300) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT id, ts, session_id, cwd, COALESCE(json_extract(detail, '$.subagent_type'), '?') AS subagentType,
                COALESCE(json_extract(detail, '$.description'), '') AS description
         FROM events WHERE source = 'hook_pre' AND tool_name IN ('Task', 'Agent')
         ORDER BY id DESC LIMIT ?`
      )
      .all(limit);
  }, []);
}

// The event details part of the AI trail card drill-down. Two different kinds of evidence are combined,
// distinguished by the inferred field:
//   - Probe measurements (source='os_net', inferred=false): the probe sees only pid/uid at the kernel level and
//     cannot know "which Claude Code session this belongs to", so sessionId/cwd are always empty on these rows.
//     That is not a field the query missed; the front end must show "unavailable" as is, never invent a value.
//     What it can give is the timestamp and pid (the process id the probe observed, a rough clue to "which
//     process").
//   - Command text inference (inferred=true): from commandNetworkHosts(), with sessionId/cwd/the exact command,
//     but no pid (whether the command really connected, and to the host in the text, is only "looks like", not
//     a kernel-level confirmation like the probe's).
function networkConnectEvents(limit = 300) {
  const observed = withDb((db) => {
    const rows = db
      .prepare(`SELECT id, ts, tool_name, detail FROM events WHERE source = 'os_net' ORDER BY id DESC LIMIT ?`)
      .all(limit);
    return rows.map((r) => {
      let detail = {};
      try {
        detail = r.detail ? JSON.parse(r.detail) : {};
      } catch (e) {
        detail = {};
      }
      return {
        id: r.id,
        ts: r.ts,
        comm: r.tool_name,
        pid: detail.pid,
        ip: detail.ip,
        port: detail.port,
        host: detail.host,
        inferred: false,
      };
    });
  }, []);
  const inferred = commandNetworkHosts(limit).map((e) => ({
    id: "cmd-" + e.id + "-" + e.host,
    ts: e.ts,
    comm: e.command,
    pid: null,
    ip: null,
    port: null,
    host: e.host,
    sessionId: e.sessionId,
    cwd: e.cwd,
    inferred: true,
  }));
  return observed
    .concat(inferred)
    .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
    .slice(0, limit);
}

// Data source for the timeline view: given a batch of session_ids (the home page's recent session list, usually a
// few dozen), take each session's most recent perSessionLimit events in descending id order, in one query with a
// window function (not one SQL statement per session_id). Which time bucket each event falls into is computed
// entirely by the caller (the /api/timeline route in server.js) with JS Date; strftime()/datetime() are not used
// here. events.ts is local time written by Python's time.strftime("%Y-%m-%dT%H:%M:%S%z"), and %z gives an offset
// without a colon (for example "+0800", not "+08:00"). SQLite's date functions only accept ISO8601 offsets with a
// colon, and silently fail to parse this format and return NULL (verified with sqlite_version 3.53.4). JS's Date
// constructor is lenient with this format, so time bucketing can only be done in JS.
function timelineEvents({ sessionIds = [], perSessionLimit = 800 } = {}) {
  if (!sessionIds.length) return [];
  return withDb((db) => {
    const placeholders = sessionIds.map(() => "?").join(",");
    const sql = `
      SELECT id, ts, session_id, risk, decision, source, tool_name, matched_rule
      FROM (
        SELECT id, ts, session_id, risk, decision, source, tool_name, matched_rule,
               ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY id DESC) AS rn
        FROM events
        WHERE session_id IN (${placeholders})
      )
      WHERE rn <= ?
      ORDER BY id ASC`;
    return db.prepare(sql).all(...sessionIds, perSessionLimit);
  }, []);
}

// A single session's most recent limit full events (in chronological order), for the flow view. queryEvents()
// with a limit takes the earliest ones, but a long session needs the latest operations, so take them in
// descending order and flip them back.
function sessionEventsTail(sessionId, limit = 3000) {
  return withDb((db) => {
    const rows = db
      .prepare(
        `SELECT id, ts, source, tool_name, cwd, risk, matched_rule, decision, detail
         FROM events WHERE session_id = ? ORDER BY id DESC LIMIT ?`
      )
      .all(sessionId, limit);
    return rows.reverse();
  }, []);
}

// "Total audit events" drill-down: grouped by tool/source, listing which sessions produced each group.
function eventTypeBreakdown(limit = 500) {
  return withDb((db) => {
    const rows = db
      .prepare(
        `SELECT source, tool_name, session_id, COUNT(*) AS n
         FROM events
         GROUP BY source, tool_name, session_id
         ORDER BY n DESC`
      )
      .all();
    const byType = new Map();
    for (const r of rows) {
      const key = `${r.source}::${r.tool_name || ""}`;
      if (!byType.has(key)) {
        byType.set(key, { source: r.source, toolName: r.tool_name, total: 0, sessions: [] });
      }
      const entry = byType.get(key);
      entry.total += r.n;
      if (r.session_id) entry.sessions.push({ sessionId: r.session_id, count: r.n });
    }
    return [...byType.values()].sort((a, b) => b.total - a.total).slice(0, limit);
  }, []);
}

// "Blocked high-risk operations" drill-down: which commands/operations were stopped.
function blockedDetails(limit = 200) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT id, ts, session_id, cwd, tool_name, matched_rule, detail
         FROM events WHERE decision = 'blocked'
         ORDER BY id DESC LIMIT ?`
      )
      .all(limit);
  }, []);
}

module.exports = {
  listSessions,
  queryEvents,
  stats,
  dbPath,
  getTranscriptPath,
  fileOpsStats,
  fileOpDetails,
  installGroupNames,
  installStats,
  installDetails,
  githubOpsBreakdown,
  githubOpsEvents,
  sshOpsBreakdown,
  sshOpsEvents,
  downloadOpsBreakdown,
  downloadOpsEvents,
  fileSendOpsBreakdown,
  fileSendOpsEvents,
  dockerOpsBreakdown,
  dockerOpsEvents,
  archiveOpsBreakdown,
  archiveOpsEvents,
  netdiagOpsBreakdown,
  netdiagOpsEvents,
  reverseEngOpsBreakdown,
  reverseEngOpsEvents,
  procbgOpsBreakdown,
  procbgOpsEvents,
  sensitiveOpsBreakdown,
  sensitiveOpsEvents,
  sensitiveDataBreakdown,
  sensitiveDataEvents,
  advancedThreatBreakdown,
  advancedThreatEvents,
  workdirEscapeBreakdown,
  workdirEscapeEvents,
  screenshotStats,
  screenshotBreakdown,
  screenshotDetails,
  commandNetworkHosts,
  toolCallStats,
  toolCallBreakdown,
  mcpCallStats,
  mcpCallBreakdown,
  skillCallStats,
  skillCallBreakdown,
  subagentCallStats,
  subagentCallBreakdown,
  searchCallStats,
  searchCallBreakdown,
  todoCallStats,
  toolCallEvents,
  mcpCallEvents,
  skillCallEvents,
  subagentCallEvents,
  searchCallEvents,
  todoCallEvents,
  networkConnectEvents,
  eventTypeBreakdown,
  blockedDetails,
  timelineEvents,
  sessionEventsTail,
};
