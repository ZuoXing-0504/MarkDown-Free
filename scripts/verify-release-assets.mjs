import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const outputDirectory = path.join(root, "release", "installer");
const englishName = `CleanMark-${packageJson.version}-Setup.exe`;
const chineseName = `QingMo-${packageJson.version}-Setup.exe`;
const localChineseName = `清墨-${packageJson.version}-安装程序.exe`;
const englishPath = path.join(outputDirectory, englishName);
const chinesePath = path.join(outputDirectory, chineseName);
const localChinesePath = path.join(outputDirectory, localChineseName);
const checksumPath = path.join(outputDirectory, "SHA256SUMS.txt");

async function sha256(filePath) {
  await access(filePath);
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex").toUpperCase()));
  });
}

const englishHash = await sha256(englishPath);
const chineseHash = await sha256(chinesePath);
const localChineseHash = await sha256(localChinesePath);
if (englishHash !== chineseHash || englishHash !== localChineseHash) throw new Error("中英文安装器内容不一致。");

const expectedChecksum = `${englishHash}  ${englishName}\n${chineseHash}  ${chineseName}\n`;
const actualChecksum = (await readFile(checksumPath, "utf8")).replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
if (actualChecksum !== expectedChecksum) throw new Error("SHA256SUMS.txt 与安装器不一致。");

console.log(`RELEASE_ASSETS_OK ${englishHash}`);
