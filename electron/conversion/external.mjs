import { randomUUID } from "node:crypto";
import { access, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const officeScriptPath = fileURLToPath(new URL("./office-convert.ps1", import.meta.url));
const officeScript = officeScriptPath.includes("app.asar")
  ? officeScriptPath.replace("app.asar", "app.asar.unpacked")
  : officeScriptPath;

async function processIdFromFile(filePath) {
  if (!filePath) return null;
  try {
    const value = Number.parseInt((await readFile(filePath, "utf8")).trim(), 10);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

async function terminateProcessTree(child, processIdFile) {
  const officeProcessId = await processIdFromFile(processIdFile);
  const processIds = new Set([officeProcessId, child.pid].filter((value) => Number.isSafeInteger(value) && value > 0));
  const failures = [];
  for (const processId of processIds) {
    try {
      process.kill(processId, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") failures.push(`PID ${processId}: ${error.message}`);
    }
  }
  for (let attempt = 0; attempt < 30 && processIds.size; attempt += 1) {
    await delay(100);
    for (const processId of [...processIds]) {
      try { process.kill(processId, 0); } catch { processIds.delete(processId); }
    }
  }
  for (const processId of processIds) failures.push(`PID ${processId} 未在 3 秒内退出`);
  return failures;
}

async function exists(filePath) {
  if (!filePath) return false;
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function commandFromWhere(name) {
  try {
    const { stdout } = await execFileAsync("where.exe", [name], { windowsHide: true, timeout: 5000 });
    return stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null;
  } catch {
    return null;
  }
}

async function appPath(name) {
  try {
    const key = `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${name}`;
    const { stdout } = await execFileAsync("reg.exe", ["query", key, "/ve"], { windowsHide: true, timeout: 5000 });
    const match = stdout.match(/REG_SZ\s+(.+)$/im);
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

async function firstExisting(candidates) {
  for (const candidate of candidates) if (candidate && await exists(candidate)) return candidate;
  return null;
}

async function versionOf(executable, args = ["--version"]) {
  try {
    const { stdout, stderr } = await execFileAsync(executable, args, { windowsHide: true, timeout: 8000 });
    return `${stdout}${stderr}`.split(/\r?\n/).find(Boolean)?.trim() || "已安装";
  } catch {
    return "已安装";
  }
}

export async function detectCapabilities() {
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const word = await firstExisting([await appPath("WINWORD.EXE"), path.join(programFiles, "Microsoft Office", "root", "Office16", "WINWORD.EXE")]);
  const powerPoint = await firstExisting([await appPath("POWERPNT.EXE"), path.join(programFiles, "Microsoft Office", "root", "Office16", "POWERPNT.EXE")]);
  const libreOffice = await firstExisting([
    await commandFromWhere("soffice.exe"),
    await appPath("soffice.exe"),
    path.join(programFiles, "LibreOffice", "program", "soffice.exe"),
    path.join(programFilesX86, "LibreOffice", "program", "soffice.exe"),
  ]);
  const pandoc = await firstExisting([
    await commandFromWhere("pandoc.exe"),
    await appPath("pandoc.exe"),
    path.join(localAppData, "Pandoc", "pandoc.exe"),
    path.join(programFiles, "Pandoc", "pandoc.exe"),
  ]);
  return {
    office: {
      word: { available: Boolean(word), path: word, version: word ? "Microsoft Word（COM）" : null },
      powerPoint: { available: Boolean(powerPoint), path: powerPoint, version: powerPoint ? "Microsoft PowerPoint（COM）" : null },
    },
    libreOffice: { available: Boolean(libreOffice), path: libreOffice, version: libreOffice ? await versionOf(libreOffice) : null },
    pandoc: { available: Boolean(pandoc), path: pandoc, version: pandoc ? await versionOf(pandoc) : null },
  };
}

export function runProcess(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let terminationPromise = null;
    const child = spawn(executable, args, {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      terminationPromise ||= terminateProcessTree(child, options.processIdFile);
    }, options.timeoutMs || 15 * 60 * 1000);
    const abort = () => { terminationPromise ||= terminateProcessTree(child, options.processIdFile); };
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("exit", async (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      const terminationFailures = terminationPromise ? await terminationPromise : [];
      const terminationDetail = terminationFailures.length ? `（清理失败：${terminationFailures.join("；")}）` : "";
      if (options.signal?.aborted) reject(new Error("转换已取消。"));
      else if (timedOut) reject(new Error(`外部转换程序运行超时。${terminationDetail}`));
      else if (signal) reject(new Error(`外部转换进程被终止：${signal}`));
      else if (code !== 0) reject(new Error(stderr.trim() || `外部转换进程退出码为 ${code}。`));
      else resolve();
    });
  });
}

export async function runOffice(action, inputPath, outputPath, options = {}) {
  options.progress?.({ stage: "external", message: "正在使用 Microsoft Office 转换…" });
  const processIdFile = path.join(os.tmpdir(), `cleanmark-office-${randomUUID()}.pid`);
  try {
    await runProcess("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-File", officeScript,
      "-Action", action,
      "-InputPath", inputPath,
      "-OutputPath", outputPath,
      "-ProcessIdPath", processIdFile,
    ], { ...options, processIdFile });
  } finally {
    await rm(processIdFile, { force: true }).catch(() => {});
  }
}

export async function runLibreOffice(executable, inputPath, outputDirectory, target, options = {}) {
  options.progress?.({ stage: "external", message: "正在使用 LibreOffice 转换…" });
  await runProcess(executable, ["--headless", "--convert-to", target, "--outdir", outputDirectory, inputPath], options);
  const expected = path.join(outputDirectory, `${path.basename(inputPath, path.extname(inputPath))}.${target.split(":", 1)[0]}`);
  if (!await exists(expected)) throw new Error("LibreOffice 未生成预期文件。");
  return expected;
}

export async function runPandoc(executable, args, options = {}) {
  options.progress?.({ stage: "external", message: "正在使用 Pandoc 转换…" });
  await runProcess(executable, args, options);
}

export async function sortedPngFiles(directory) {
  const entries = await readdir(directory);
  const files = [];
  for (const name of entries) {
    if (!/\.png$/i.test(name)) continue;
    const fullPath = path.join(directory, name);
    if ((await stat(fullPath)).isFile()) files.push(fullPath);
  }
  return files.sort((a, b) => Number(path.basename(a).match(/(\d+)/)?.[1]) - Number(path.basename(b).match(/(\d+)/)?.[1]));
}

export const componentPages = {
  libreOffice: "https://www.libreoffice.org/download/download-libreoffice/",
  pandoc: "https://pandoc.org/installing.html",
  office: "https://www.microsoft.com/microsoft-365",
};
