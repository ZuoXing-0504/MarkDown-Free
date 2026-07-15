import { spawn } from "node:child_process";
import { access, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const installer = path.join(root, "release", "installer", `CleanMark-${packageJson.version}-Setup.exe`);
const installDir = path.join(process.env.RUNNER_TEMP || path.join(root, "test-results"), "cleanmark-installed");
const installedExecutable = path.join(installDir, "清墨.exe");
const uninstaller = path.join(installDir, "unins000.exe");
const e2eDirectory = path.join(root, "test-results", "md-workspace");
const conversionE2eDirectory = path.join(root, "test-results", "installed-conversion-e2e");
const smokeReportPath = path.join(root, "test-results", "installed-smoke-report.json");

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function runStage(name, executable, args, { environment = {}, timeoutMs = 180_000, successFile = null } = {}) {
  console.log(`::group::${name}`);
  try {
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd: root,
        stdio: "inherit",
        windowsHide: true,
        env: { ...process.env, ...environment },
      });
      let settled = false;
      let observedReport = null;
      let readingReport = false;
      const clearStageTimers = () => {
        clearTimeout(timer);
        if (reportTimer) clearInterval(reportTimer);
      };
      const readSuccessReport = async () => {
        try {
          const report = JSON.parse(await readFile(successFile, "utf8"));
          return typeof report?.passed === "boolean" ? report : null;
        } catch {
          return null;
        }
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        if (reportTimer) clearInterval(reportTimer);
        reject(new Error(`${name} 超过 ${Math.round(timeoutMs / 1000)} 秒限制。`));
      }, timeoutMs);
      const reportTimer = successFile ? setInterval(async () => {
        if (settled || readingReport || observedReport) return;
        readingReport = true;
        observedReport = await readSuccessReport();
        readingReport = false;
        if (observedReport) child.kill();
      }, 250) : null;
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearStageTimers();
        reject(error);
      });
      child.once("exit", async (code, signal) => {
        if (settled) return;
        settled = true;
        clearStageTimers();
        if (successFile) {
          const report = observedReport || await readSuccessReport();
          if (!report) reject(new Error(`${name} 未生成有效测试报告。`));
          else if (!report.passed) reject(new Error(`${name} 报告未通过：${JSON.stringify(report.errors || [])}`));
          else resolve(0);
        } else if (signal) reject(new Error(`${name} 被信号 ${signal} 终止。`));
        else resolve(code);
      });
    });
    if (exitCode !== 0) throw new Error(`${name} 退出码为 ${exitCode}。`);
  } finally {
    console.log("::endgroup::");
  }
}

async function waitForRemoval(targetPath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (await exists(targetPath)) {
    if (Date.now() >= deadline) throw new Error(`卸载后目录仍然存在：${targetPath}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

let validationError = null;
try {
  if (process.platform !== "win32") throw new Error("安装版验证仅支持 Windows。");
  if (!(await exists(installer))) throw new Error(`找不到安装器：${installer}`);
  if (await exists(installDir)) throw new Error(`隔离安装目录已存在：${installDir}`);
  await rm(smokeReportPath, { force: true });

  await runStage("安装清墨", installer, [
    "/VERYSILENT",
    "/SUPPRESSMSGBOXES",
    "/NORESTART",
    "/TASKS=",
    `/DIR=${installDir}`,
  ], { timeoutMs: 180_000 });
  if (!(await exists(installedExecutable))) throw new Error(`安装后找不到：${installedExecutable}`);

  await runStage("安装版冒烟测试", installedExecutable, ["--smoke-test"], {
    environment: { CLEANMARK_TEST_MODE: "smoke", CLEANMARK_SMOKE_REPORT: smokeReportPath },
    timeoutMs: 60_000,
    successFile: smokeReportPath,
  });
  await runStage("准备安装版 E2E 文件", process.execPath, [path.join(root, "scripts", "prepare-e2e.mjs")]);
  await runStage("安装版完整 E2E", installedExecutable, ["--e2e-test", `--e2e-dir=${e2eDirectory}`], {
    environment: { CLEANMARK_TEST_MODE: "e2e", CLEANMARK_E2E_DIR: e2eDirectory },
    timeoutMs: 180_000,
    successFile: path.join(e2eDirectory, "测试报告.json"),
  });
  await runStage("安装版文档转换 E2E", installedExecutable, ["--conversion-e2e-test", `--conversion-e2e-dir=${conversionE2eDirectory}`], {
    environment: { CLEANMARK_TEST_MODE: "conversion-e2e", CLEANMARK_CONVERSION_E2E_DIR: conversionE2eDirectory },
    timeoutMs: 360_000,
    successFile: path.join(conversionE2eDirectory, "测试报告.json"),
  });

  const report = JSON.parse(await readFile(path.join(e2eDirectory, "测试报告.json"), "utf8"));
  if (!report.passed) throw new Error(`安装版 E2E 报告未通过：${JSON.stringify(report.errors || [])}`);
  const conversionReport = JSON.parse(await readFile(path.join(conversionE2eDirectory, "测试报告.json"), "utf8"));
  if (!conversionReport.passed) throw new Error(`安装版转换 E2E 报告未通过：${JSON.stringify(conversionReport.errors || [])}`);
} catch (error) {
  validationError = error;
  console.error(`::error title=安装版验证失败::${error instanceof Error ? error.message : String(error)}`);
} finally {
  if (await exists(uninstaller)) {
    try {
      await runStage("卸载清墨", uninstaller, ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"], { timeoutMs: 180_000 });
      await waitForRemoval(installDir);
    } catch (error) {
      console.error(`::error title=安装版卸载失败::${error instanceof Error ? error.message : String(error)}`);
      if (!validationError) validationError = error;
    }
  }
}

if (validationError) throw validationError;
console.log(`INSTALL_E2E_OK CleanMark ${packageJson.version}`);
