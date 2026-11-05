#!/usr/bin/env node
// npm-install-audit: look before you run.
// Usage: node audit.js [--json] [--version] ./some-repo
// Read only, no network, no dependencies. A clean result is not proof of safety.
const fs = require("fs");
const path = require("path");

if (process.argv.includes("--version")) { console.log("npm-install-audit 1.3.2"); process.exit(0); }

const args = process.argv.slice(2);
const jsonMode = args.includes("--json");
const targetArg = args.find((a) => !a.startsWith("-")) || ".";

let root;
try {
  root = path.resolve(targetArg);
  if (!fs.statSync(root).isDirectory()) throw new Error("not a directory");
} catch (e) {
  if (jsonMode) {
    process.stdout.write(JSON.stringify({ error: "Cannot read directory: " + targetArg }) + "\n");
  } else {
    console.error("Cannot read directory: " + targetArg);
  }
  process.exit(2);
}

const HOOKS = ["preinstall", "install", "postinstall", "prepare"];
const SKIP_DIRS = new Set([".git", "node_modules"]);

const RISKY = [
  [/child_process|execSync|execFileSync|spawnSync|\bspawn\(/, "runs shell commands"],
  [/\beval\(|new Function\(/, "evaluates code at runtime"],
  [/\batob\(|Buffer\.from\([^)]*base64/, "decodes base64 at runtime"],
  [/(curl|wget)\s[^\n]*\|\s*(sh|bash)/, "pipes a download into a shell"],
  [
    /Login Data|keystore|wallet\.dat|\.ssh[\/\\]|id_rsa|\.aws[\/\\]credentials|Local Storage[\/\\]leveldb/i,
    "touches key, wallet or browser data paths",
  ],
];

const NON_REGISTRY_DEP = [
  [/^git\+https?:\/\//i,  "git URL dependency (bypasses npm registry)"],
  [/^git\+ssh:\/\//i,     "git+ssh URL dependency (bypasses npm registry)"],
  [/^git(\+file)?:\/\//i, "git:// URL dependency (bypasses npm registry)"],
  [/^github:/i,           "GitHub shorthand dependency (bypasses npm registry)"],
  [/^bitbucket:/i,        "Bitbucket shorthand dependency (bypasses npm registry)"],
  [/^gitlab:/i,           "GitLab shorthand dependency (bypasses npm registry)"],
  [/^https?:\/\/.*\.(tgz|tar\.gz)(#.*)?$/i, "tarball URL dependency (bypasses npm registry)"],
  [/^https?:\/\//i,       "URL dependency (bypasses npm registry)"],
  [/^file:/i,             "local file: dependency (install-time arbitrary path)"],
  [/^link:/i,             "local link: dependency (install-time arbitrary path)"],
  // npm reads a bare "user/repo" (optionally "#ref") as a GitHub repo
  [/^[A-Za-z0-9][\w.-]*\/[\w.-]+(#\S*)?$/, "bare user/repo GitHub dependency (bypasses npm registry)"],
];

const SOURCE_EXT = /\.(js|cjs|mjs|jsx|ts|mts|cts|tsx|sh)$/;

const GIT_CONFIG_RISKY = [
  [/^\s*hookspath\s*=/i, "core.hooksPath points git hooks to another folder"],
  [/^\s*fsmonitor\s*=/i, "core.fsmonitor runs a program on git status"],
  [/^\s*(sshcommand|pager|editor|askpass)\s*=/i, "sets a program that git runs for you"],
  [/^\s*[\w.-]+\s*=\s*!/, "defines an alias or helper that runs a shell command"],
  [/^\s*(clean|smudge|process|textconv)\s*=/i, "defines a filter or diff driver that runs a program"],
];

const findingsList = [];

const flag = (file, msg) => {
  const rel = path.relative(root, file);
  findingsList.push({ file: rel, rule: msg, message: rel + ": " + msg });
  if (!jsonMode) {
    console.log("! " + rel + ": " + msg);
  }
};

function checkPackage(file) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    flag(file, "package.json could not be parsed, read it by hand");
    return;
  }

  for (const h of HOOKS) {
    if (pkg.scripts && pkg.scripts[h]) {
      flag(file, h + " hook runs: " + pkg.scripts[h]);
    }
  }

  const depFields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
  for (const field of depFields) {
    const deps = pkg[field];
    if (!deps || typeof deps !== "object") continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec !== "string") continue;
      for (const [re, why] of NON_REGISTRY_DEP) {
        if (re.test(spec)) {
          flag(file, `"${name}": "${spec}" — ${why}`);
          break;
        }
      }
    }
  }
}

function checkSource(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const [re, why] of RISKY) {
    if (re.test(text)) flag(file, why);
  }
  if (!/\.min\.js$/.test(file)) {
    const blob = text.match(/[A-Za-z0-9+\/=]{300,}/);
    if (blob) flag(file, "long encoded string (" + blob[0].length + " chars)");
  }
}

const OFFICIAL_REGISTRY = /^https?:\/\/registry\.(npmjs\.org|yarnpkg\.com)\/?$/i;

function checkRegistryConfig(file) {
  let text = "";
  try { if (fs.statSync(file).size < 2e5) text = fs.readFileSync(file, "utf8"); } catch { return; }
  const yarn = /\.yarnrc\.yml$/.test(file);
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (yarn ? /^npmAuth(Token|Ident)\s*:/.test(line) : /(^|:)_(authToken|auth|password)\s*=/.test(line)) {
      flag(file, "ships a registry auth token, so the install can fetch packages the public registry does not show (token not printed)");
      continue;
    }
    const m = yarn
      ? line.match(/^npmRegistryServer\s*:\s*["']?([^"'\s]+)/)
      : line.match(/^(@[\w.-]+:)?registry\s*[=\s]\s*["']?([^"'\s]+)/);
    if (!m) continue;
    const url = yarn ? m[1] : m[2];
    const scope = yarn ? "" : (m[1] || "").slice(0, -1);
    if (!OFFICIAL_REGISTRY.test(url)) {
      flag(file, (scope ? scope + " packages install" : "installs come") + " from another registry: " + url);
    }
  }
}

function checkGit(dir) {
  const gitDir = path.join(dir, ".git");
  let st;
  try { st = fs.statSync(gitDir); } catch { return; }
  if (!st.isDirectory()) return;

  const hooksDir = path.join(gitDir, "hooks");
  let hooks = [];
  try { hooks = fs.readdirSync(hooksDir, { withFileTypes: true }); } catch {}
  for (const h of hooks) {
    if (!h.isFile() || h.name.endsWith(".sample")) continue;
    const p = path.join(hooksDir, h.name);
    let text = "";
    try { if (fs.statSync(p).size < 2e6) text = fs.readFileSync(p, "utf8"); } catch {}
    let msg = "active git hook, runs automatically on git commands";
    if (/(curl|wget)\s[^\n]*\|\s*(sh|bash|cmd)|\|\s*(sh|bash)\b/.test(text)) msg += ", downloads and runs code";
    flag(p, msg);
  }

  let config = "";
  try { config = fs.readFileSync(path.join(gitDir, "config"), "utf8"); } catch {}
  for (const line of config.split(/\r?\n/)) {
    for (const [re, why] of GIT_CONFIG_RISKY) {
      if (re.test(line)) { flag(path.join(gitDir, "config"), why + ": " + line.trim()); break; }
    }
  }
}

function checkEditorConfig(dir) {
  const tasks = path.join(dir, ".vscode", "tasks.json");
  let text = "";
  try { text = fs.readFileSync(tasks, "utf8"); } catch { return; }
  if (/"runOn"\s*:\s*"folderOpen"/.test(text)) flag(tasks, "VS Code task runs when the folder is opened");
}

function walk(dir, depth) {
  if (depth > 8) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) { walk(p, depth + 1); continue; }
    if (!e.isFile()) continue;
    if (e.name === "package.json") { checkPackage(p); continue; }
    if (e.name === ".npmrc" || e.name === ".yarnrc" || e.name === ".yarnrc.yml") { checkRegistryConfig(p); continue; }
    if (SOURCE_EXT.test(e.name)) {
      let size = 0;
      try { size = fs.statSync(p).size; } catch { continue; }
      if (size < 2e6) checkSource(p);
    }
  }
}

checkGit(root);
checkEditorConfig(root);
walk(root, 0);

if (jsonMode) {
  process.stdout.write(JSON.stringify(findingsList, null, 2) + "\n");
  process.exit(findingsList.length ? 1 : 0);
} else {
  const findings = findingsList.length;
  if (findings) {
    console.log("\n" + findings + " finding(s). Read them before you run npm install or any git command.");
    console.log("Tip: git -c core.hooksPath=/dev/null <command> runs git without repo hooks.");
    process.exit(1);
  }
  console.log("No obvious install hooks or risky patterns found. Still read the code.");
}
