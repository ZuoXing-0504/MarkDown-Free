import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const compiler = "C:/Program Files (x86)/Inno Setup 6/ISCC.exe";

await import("./prepare-inno.mjs");
const { stdout, stderr } = await execFileAsync(compiler, [
  `/DAppVersion=${packageJson.version}`,
  "installer/cleanmark.iss",
], { cwd: new URL("../", import.meta.url), windowsHide: true });

if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);
