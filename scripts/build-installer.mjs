import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, readFile, writeFile } from "node:fs/promises";
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

const localInstallerName = `清墨-${packageJson.version}-安装程序.exe`;
const releaseInstallerName = `CleanMark-${packageJson.version}-Setup.exe`;
const localInstaller = new URL(`../release/installer/${localInstallerName}`, import.meta.url);
const releaseInstaller = new URL(`../release/installer/${releaseInstallerName}`, import.meta.url);
await copyFile(localInstaller, releaseInstaller);
const digest = createHash("sha256").update(await readFile(releaseInstaller)).digest("hex").toUpperCase();
await writeFile(
  new URL("../release/installer/SHA256SUMS.txt", import.meta.url),
  `${digest}  ${releaseInstallerName}\n${digest}  ${localInstallerName}\n`,
  "utf8",
);
console.log(`Prepared ${releaseInstallerName} and SHA256SUMS.txt (${digest}).`);
