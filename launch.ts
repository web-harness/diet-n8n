import fs from "fs";
import path from "path";
import assert from "assert";
import childProcess from "child_process";

const ROOT = __dirname;

assert(fs.existsSync(path.join(ROOT, "minimal.env")), "minimal.env not found");
assert(fs.existsSync(path.join(ROOT, "node_modules")), "postinstall script not ran");

const n8nBin = path.join(ROOT, "node_modules", "n8n", "bin", "n8n");

assert(fs.existsSync(n8nBin), "n8n binary not found");

const minimalEnv = fs.readFileSync(path.join(ROOT, "minimal.env"), "utf8");
const minimalEnvLines = minimalEnv.split("\n");
const minimalEnvLinesFiltered = minimalEnvLines.filter((line) => !line.startsWith("#") && line.trim() !== "");

const env = {
  ...process.env,
  N8N_USER_FOLDER: ROOT,
  ...Object.fromEntries(minimalEnvLinesFiltered.map((line) => line.split("="))),
};

const proc = childProcess.spawn(process.execPath, [n8nBin], {
  env,
  stdio: "inherit",
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
