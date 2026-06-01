import fs from "fs";
import path from "path";
import assert from "assert";
import childProcess from "child_process";

const ROOT = __dirname;

assert(fs.existsSync(path.join(ROOT, "minimal.env")), "minimal.env not found");
assert(fs.existsSync(path.join(ROOT, "node_modules")), "postinstall script not ran");

const n8nPkgDir = path.join(ROOT, "node_modules", "n8n");
const n8nPkg = JSON.parse(fs.readFileSync(path.join(n8nPkgDir, "package.json"), "utf8")) as {
  bin?: string | Record<string, string>;
};
const n8nRel = typeof n8nPkg.bin === "string" ? n8nPkg.bin : n8nPkg.bin?.n8n;
assert(n8nRel, "n8n package.json missing bin entry");
const n8nCli = path.join(n8nPkgDir, n8nRel);
assert(fs.existsSync(n8nCli), "n8n CLI entry not found");

function parseMinimalEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

const hooksFile = path.join(ROOT, "hooks.js");

assert(fs.existsSync(hooksFile), "hooks.js not found — run npm run build or bundle hooks.ts");

const env: Record<string, string> = {
  ...process.env,
  N8N_USER_FOLDER: ROOT,
  // Relative path: n8n splits EXTERNAL_HOOK_FILES on ":" (breaks "D:\..." on Windows).
  EXTERNAL_HOOK_FILES: "hooks.js",
  ...parseMinimalEnv(fs.readFileSync(path.join(ROOT, "minimal.env"), "utf8")),
};

if (process.platform === "win32") {
  // Unix fork()-based native runner; Windows needs the external task-runner path.
  env.N8N_NATIVE_PYTHON_RUNNER = "false";
}

// When stdout/stderr are redirected (CI smoke test), inherit breaks on Windows Git Bash.
const logToPipe = !process.stdout.isTTY;
const proc = childProcess.spawn(process.execPath, [n8nCli], {
  env,
  cwd: ROOT,
  stdio: logToPipe ? ["ignore", "pipe", "pipe"] : "inherit",
});

if (logToPipe) {
  proc.stdout?.pipe(process.stdout);
  proc.stderr?.pipe(process.stderr);
}

proc.on("error", (err) => {
  console.error(`failed to spawn n8n: ${err.message}`);
  process.exit(1);
});

proc.on("close", (code) => {
  if (code !== 0) {
    console.error(`n8n exited with code ${code}`);
    process.exit(code);
  } else {
    console.log("n8n exited with code 0");
    process.exit(0);
  }
});

process.on("SIGINT", () => {
  proc.kill("SIGINT");
});
process.on("SIGTERM", () => {
  proc.kill("SIGTERM");
});
process.on("SIGQUIT", () => {
  proc.kill("SIGQUIT");
});
