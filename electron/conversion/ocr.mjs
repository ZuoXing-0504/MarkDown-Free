import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, rename, rm, stat } from "node:fs/promises";
import https from "node:https";
import path from "node:path";

const MAX_LANGUAGE_BYTES = 30 * 1024 * 1024;
const ALLOWED_HOSTS = new Set(["cdn.jsdelivr.net", "fastly.jsdelivr.net"]);

export const OCR_MANIFEST = {
  eng: {
    label: "English",
    fileName: "eng.traineddata.gz",
    url: "https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0/eng.traineddata.gz",
    sha256: "ED350F3752F81EE8F38769EDC14D92D997DABABE23B565C59879372CC46A2468",
    size: 10923060,
  },
  chi_sim: {
    label: "简体中文",
    fileName: "chi_sim.traineddata.gz",
    url: "https://cdn.jsdelivr.net/npm/@tesseract.js-data/chi_sim@1.0.0/4.0.0/chi_sim.traineddata.gz",
    sha256: "59388039851E4D1293D729C183FD8C1FA9BBBB959EED996E945024671E68C1D6",
    size: 20159757,
  },
};

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function fileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex").toUpperCase()));
  });
}

async function download(urlValue, destination, progress, redirects = 0) {
  if (redirects > 4) throw new Error("OCR 语言包重定向次数过多。");
  const url = new URL(urlValue);
  if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname)) throw new Error("OCR 语言包下载地址无效。");
  await new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { "User-Agent": "CleanMark/0.4.0" } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400) {
        const location = response.headers.location;
        response.resume();
        if (!location) return reject(new Error("OCR 语言包重定向无效。"));
        download(new URL(location, url).toString(), destination, progress, redirects + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`OCR 语言包下载失败（HTTP ${response.statusCode}）。`));
        return;
      }
      const expected = Number(response.headers["content-length"] || 0);
      if (expected > MAX_LANGUAGE_BYTES) {
        response.resume();
        reject(new Error("OCR 语言包超过大小限制。"));
        return;
      }
      import("node:fs").then(({ createWriteStream }) => {
        const output = createWriteStream(destination, { flags: "wx" });
        let downloaded = 0;
        response.on("data", (chunk) => {
          downloaded += chunk.length;
          if (downloaded > MAX_LANGUAGE_BYTES) request.destroy(new Error("OCR 语言包超过大小限制。"));
          progress?.({ downloaded, total: expected || null });
        });
        response.pipe(output);
        output.once("finish", () => output.close(resolve));
        output.once("error", reject);
        response.once("error", reject);
      }, reject);
    });
    request.setTimeout(30_000, () => request.destroy(new Error("OCR 语言包下载超时。")));
    request.once("error", reject);
  });
}

export async function getOcrStatus(directory) {
  const status = {};
  for (const [language, manifest] of Object.entries(OCR_MANIFEST)) {
    const filePath = path.join(directory, manifest.fileName);
    const installed = await exists(filePath);
    let valid = false;
    if (installed) {
      try {
        const stats = await stat(filePath);
        valid = stats.isFile() && stats.size === manifest.size && await fileHash(filePath) === manifest.sha256;
      } catch {
        valid = false;
      }
    }
    status[language] = {
      label: manifest.label,
      installed,
      size: manifest.size,
      valid,
    };
  }
  return status;
}

export async function downloadOcrLanguage(language, directory, progress) {
  const manifest = OCR_MANIFEST[language];
  if (!manifest) throw new Error("不支持该 OCR 语言包。");
  await mkdir(directory, { recursive: true });
  const targetPath = path.join(directory, manifest.fileName);
  if (await exists(targetPath) && await fileHash(targetPath) === manifest.sha256) return targetPath;
  const temporaryPath = path.join(directory, `.${manifest.fileName}.${randomUUID()}.tmp`);
  try {
    await download(manifest.url, temporaryPath, progress);
    const stats = await stat(temporaryPath);
    if (stats.size !== manifest.size) throw new Error("OCR 语言包大小校验失败。");
    const digest = await fileHash(temporaryPath);
    if (digest !== manifest.sha256) throw new Error("OCR 语言包 SHA-256 校验失败。");
    await rm(targetPath, { force: true });
    await rename(temporaryPath, targetPath);
    return targetPath;
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}
