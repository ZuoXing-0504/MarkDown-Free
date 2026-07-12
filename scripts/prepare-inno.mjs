import { access, copyFile, mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const outputDirectory = new URL("../installer/languages/", import.meta.url);
const destination = new URL("ChineseSimplified.isl", outputDirectory);
const sourceUrl =
  "https://raw.githubusercontent.com/kira-96/Inno-Setup-Chinese-Simplified-Translation/master/ChineseSimplified.isl";

await mkdir(outputDirectory, { recursive: true });

try {
  await access(destination);
  console.log(`Using bundled translation ${fileURLToPath(destination)}`);
  process.exit(0);
} catch {
  // Download only when a fresh checkout does not contain the bundled translation.
}

try {
  const response = await fetch(sourceUrl);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
} catch (error) {
  try {
    await execFileAsync("curl.exe", ["--fail", "--location", "--silent", "--show-error", sourceUrl, "--output", fileURLToPath(destination)]);
    console.log(`Downloaded translation with curl.exe after fetch failed: ${error.message}`);
  } catch (curlError) {
  const installedTranslation =
    "C:/Program Files (x86)/Inno Setup 6/Languages/ChineseSimplified.isl";
    try {
      await copyFile(installedTranslation, fileURLToPath(destination));
    } catch {
      throw new Error(`无法准备简体中文语言文件：fetch=${error.message}; curl=${curlError.message}`);
    }
  }
}

console.log(`Prepared ${fileURLToPath(destination)}`);
