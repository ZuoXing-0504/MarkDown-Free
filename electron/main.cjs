"use strict";

const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require("electron");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const dns = require("node:dns/promises");
const https = require("node:https");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const iconv = require("iconv-lite");

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdown", ".mkd", ".txt"]);
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_CONVERSION_BYTES = 100 * 1024 * 1024;
const MAX_TREE_FILES = 2000;
const MAX_REMOTE_IMAGE_BYTES = 10 * 1024 * 1024;
const REMOTE_IMAGE_TIMEOUT_MS = 15_000;
const RECOVERY_FILE = "recovery-draft.json";
const ALLOWED_REMOTE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);
const CONVERSION_INPUT_TYPES = new Set(["md", "docx", "doc", "pdf", "pptx", "ppt"]);
const CONVERSION_TARGET_TYPES = new Set(["md", "docx", "pdf", "pptx"]);
const CONVERSION_OCR_LANGUAGES = new Set(["chi_sim", "eng"]);
const blockedRemoteAddresses = new net.BlockList();
for (const [network, prefix, type] of [
  ["0.0.0.0", 8, "ipv4"],
  ["10.0.0.0", 8, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["169.254.0.0", 16, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.0.0.0", 24, "ipv4"],
  ["192.0.2.0", 24, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["198.18.0.0", 15, "ipv4"],
  ["198.51.100.0", 24, "ipv4"],
  ["203.0.113.0", 24, "ipv4"],
  ["224.0.0.0", 4, "ipv4"],
  ["240.0.0.0", 4, "ipv4"],
  ["::", 128, "ipv6"],
  ["::1", 128, "ipv6"],
  ["64:ff9b:1::", 48, "ipv6"],
  ["100::", 64, "ipv6"],
  ["2001:db8::", 32, "ipv6"],
  ["2001:10::", 28, "ipv6"],
  ["2001:20::", 28, "ipv6"],
  ["2002::", 16, "ipv6"],
  ["fc00::", 7, "ipv6"],
  ["fe80::", 10, "ipv6"],
  ["fec0::", 10, "ipv6"],
  ["ff00::", 8, "ipv6"],
]) {
  blockedRemoteAddresses.addSubnet(network, prefix, type);
}
const windowState = new WeakMap();
const conversionJobs = new Map();
const conversionAccess = new Map();
let recoveryQueue = Promise.resolve();
let conversionModulePromise = null;
function commandLineSwitch(name) {
  const argument = process.argv.find((value) => value === `--${name}` || value.startsWith(`--${name}=`));
  if (argument) return argument === `--${name}` ? "" : argument.slice(name.length + 3);
  return app.commandLine.hasSwitch(name) ? app.commandLine.getSwitchValue(name) : null;
}

const testMode = process.env.CLEANMARK_TEST_MODE || "";
const smokeTest = testMode === "smoke" || commandLineSwitch("smoke-test") !== null;
const e2eTest = testMode === "e2e" || commandLineSwitch("e2e-test") !== null;
const conversionE2eTest = testMode === "conversion-e2e" || commandLineSwitch("conversion-e2e-test") !== null;
const e2eDirectoryValue = process.env.CLEANMARK_E2E_DIR || commandLineSwitch("e2e-dir");
const e2eDirectory = e2eDirectoryValue ? path.resolve(e2eDirectoryValue) : null;
const conversionE2eDirectoryValue = process.env.CLEANMARK_CONVERSION_E2E_DIR || commandLineSwitch("conversion-e2e-dir");
const conversionE2eDirectory = conversionE2eDirectoryValue ? path.resolve(conversionE2eDirectoryValue) : null;
const smokeReportPath = process.env.CLEANMARK_SMOKE_REPORT ? path.resolve(process.env.CLEANMARK_SMOKE_REPORT) : null;

if (smokeTest || e2eTest || conversionE2eTest) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.setPath("userData", path.join(os.tmpdir(), `cleanmark-test-${process.pid}`));
}

const gotSingleInstanceLock = smokeTest || e2eTest || conversionE2eTest || app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) app.quit();

let testTimeout = null;

function exitTest(code) {
  if (testTimeout) {
    clearTimeout(testTimeout);
    testTimeout = null;
  }
  process.exit(code);
}

if (smokeTest || e2eTest || conversionE2eTest) {
  const timeout = conversionE2eTest ? 240_000 : e2eTest ? 120_000 : 30_000;
  testTimeout = setTimeout(() => {
    const label = conversionE2eTest ? "CONVERSION_E2E" : e2eTest ? "E2E" : "SMOKE";
    console.error(`${label}_FAILED Timed out after ${timeout}ms.`);
    exitTest(1);
  }, timeout);
}

function stateFor(window) {
  if (!windowState.has(window)) {
    windowState.set(window, { dirty: false, allowClose: false, closePromptOpen: false });
  }
  return windowState.get(window);
}

function conversionModule() {
  conversionModulePromise ||= import(pathToFileURL(path.join(__dirname, "conversion", "index.mjs")).href);
  return conversionModulePromise;
}

function conversionPathKey(filePath) {
  return path.resolve(filePath).toLowerCase();
}

function conversionAccessFor(sender) {
  if (!conversionAccess.has(sender.id)) conversionAccess.set(sender.id, { inputs: new Set(), outputs: new Set(), results: new Set() });
  return conversionAccess.get(sender.id);
}

function ocrDirectory() {
  return path.join(app.getPath("userData"), "conversion-tools", "ocr");
}

function conversionType(filePath) {
  const extension = path.extname(filePath || "").toLowerCase();
  if (extension === ".md" || extension === ".markdown") return "md";
  return extension.slice(1);
}

function validateConversionPayload(payload) {
  if (!payload || typeof payload !== "object") throw new Error("转换任务无效。");
  if (typeof payload.jobId !== "string" || !/^[a-zA-Z0-9-]{8,80}$/.test(payload.jobId)) throw new Error("转换任务编号无效。");
  if (!payload.source || !["editor", "file"].includes(payload.source.kind)) throw new Error("转换来源无效。");
  if (!CONVERSION_TARGET_TYPES.has(payload.target)) throw new Error("转换目标格式无效。");
  if (!["editable", "visual"].includes(payload.mode)) throw new Error("转换模式无效。");
  if (typeof payload.outputPath !== "string" || payload.outputPath.includes("\0") || !path.isAbsolute(payload.outputPath)) {
    throw new Error("转换输出路径无效。");
  }
  const expectedExtension = payload.target === "md" ? ".md" : `.${payload.target}`;
  if (path.extname(payload.outputPath).toLowerCase() !== expectedExtension) throw new Error(`输出文件必须使用 ${expectedExtension} 扩展名。`);

  let source;
  if (payload.source.kind === "editor") {
    if (typeof payload.source.content !== "string") throw new Error("当前文档内容无效。");
    if (Buffer.byteLength(payload.source.content, "utf8") > MAX_CONVERSION_BYTES) throw new Error("当前文档超过 100 MB 转换限制。");
    if (payload.target === "md") throw new Error("当前 Markdown 文档无需转换为 Markdown。");
    if (payload.source.filePath != null && (
      typeof payload.source.filePath !== "string"
      || payload.source.filePath.includes("\0")
      || !path.isAbsolute(payload.source.filePath)
    )) throw new Error("当前文档基准路径无效。");
    source = {
      kind: "editor",
      content: payload.source.content,
      filePath: payload.source.filePath ? path.resolve(payload.source.filePath) : null,
    };
  } else {
    if (typeof payload.source.filePath !== "string" || payload.source.filePath.includes("\0") || !path.isAbsolute(payload.source.filePath)) {
      throw new Error("转换来源路径无效。");
    }
    const filePath = path.resolve(payload.source.filePath);
    if (!CONVERSION_INPUT_TYPES.has(conversionType(filePath))) throw new Error("不支持该来源文件格式。");
    if (filePath.toLowerCase() === path.resolve(payload.outputPath).toLowerCase()) throw new Error("输出路径不能覆盖来源文件。");
    source = { kind: "file", filePath };
  }

  const requestedLanguages = payload.options?.ocrLanguages ?? ["chi_sim", "eng"];
  if (!Array.isArray(requestedLanguages) || requestedLanguages.some((language) => !CONVERSION_OCR_LANGUAGES.has(language))) {
    throw new Error("OCR 语言选项无效。");
  }
  const ocrLanguages = [...new Set(requestedLanguages)];
  if (payload.options?.ocr && !ocrLanguages.length) throw new Error("请至少选择一种 OCR 语言。");
  return {
    jobId: payload.jobId,
    source,
    target: payload.target,
    mode: payload.mode,
    outputPath: path.resolve(payload.outputPath),
    options: {
      includeRemoteImages: Boolean(payload.options?.includeRemoteImages),
      ocr: Boolean(payload.options?.ocr),
      ocrLanguages,
    },
  };
}

function fingerprint(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function detectTextEncoding(buffer) {
  if (buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    return { encoding: "utf8", bom: true, offset: 3 };
  }
  if (buffer.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) {
    return { encoding: "utf16le", bom: true, offset: 2 };
  }
  if (buffer.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) {
    return { encoding: "utf16be", bom: true, offset: 2 };
  }
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  if (sample.length >= 4) {
    let evenZeros = 0;
    let oddZeros = 0;
    for (let index = 0; index < sample.length; index += 1) {
      if (sample[index] !== 0) continue;
      if (index % 2 === 0) evenZeros += 1;
      else oddZeros += 1;
    }
    const pairs = Math.max(1, Math.floor(sample.length / 2));
    if (oddZeros / pairs > 0.3 && evenZeros / pairs < 0.05) {
      return { encoding: "utf16le", bom: false, offset: 0 };
    }
    if (evenZeros / pairs > 0.3 && oddZeros / pairs < 0.05) {
      return { encoding: "utf16be", bom: false, offset: 0 };
    }
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return { encoding: "utf8", bom: false, offset: 0, uncertain: false };
  } catch {
    return { encoding: "gb18030", bom: false, offset: 0, uncertain: true };
  }
}

function isProbablyBinary(buffer, encoding) {
  if (encoding === "utf16le" || encoding === "utf16be") return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (sample.includes(0)) return true;
  let controls = 0;
  for (const byte of sample) {
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) controls += 1;
  }
  return sample.length > 0 && controls / sample.length > 0.02;
}

function decodeText(buffer) {
  const detected = detectTextEncoding(buffer);
  if (isProbablyBinary(buffer.subarray(detected.offset), detected.encoding)) {
    throw new Error("所选文件看起来是二进制文件，已阻止以避免损坏内容。");
  }
  const decoded = iconv.decode(buffer.subarray(detected.offset), detected.encoding);
  const eol = decoded.includes("\r\n") ? "crlf" : decoded.includes("\r") ? "cr" : "lf";
  return {
    content: decoded.replace(/\r\n?/g, "\n"),
    encoding: detected.encoding,
    bom: detected.bom,
    eol,
    encodingUncertain: Boolean(detected.uncertain),
  };
}

function encodeText(content, encoding = "utf8", bom = false, eol = "lf") {
  const newline = eol === "crlf" ? "\r\n" : eol === "cr" ? "\r" : "\n";
  const normalized = content.replace(/\r\n?/g, "\n").replace(/\n/g, newline);
  const encoded = iconv.encode(normalized, encoding);
  if (!bom) return encoded;
  const prefixes = {
    utf8: Buffer.from([0xef, 0xbb, 0xbf]),
    utf16le: Buffer.from([0xff, 0xfe]),
    utf16be: Buffer.from([0xfe, 0xff]),
  };
  return prefixes[encoding] ? Buffer.concat([prefixes[encoding], encoded]) : encoded;
}

async function currentFingerprint(filePath) {
  try {
    return fingerprint(await fs.readFile(filePath));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWrite(filePath, data, { checkExpected = false, expectedFingerprint = null } = {}) {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    if (checkExpected) {
      const current = await currentFingerprint(filePath);
      if (current !== expectedFingerprint) {
        await fs.rm(temporaryPath, { force: true });
        return { conflict: true, currentFingerprint: current, missing: current === null };
      }
    }
    await fs.rename(temporaryPath, filePath);
    let directoryHandle;
    try {
      directoryHandle = await fs.open(directory, "r");
      await directoryHandle.sync();
    } catch {
      // Directory fsync is not supported on every Windows filesystem.
    } finally {
      if (directoryHandle) await directoryHandle.close().catch(() => {});
    }
    return { conflict: false };
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

function recoveryPath() {
  return path.join(app.getPath("userData"), RECOVERY_FILE);
}

function serializeRecovery(operation) {
  const result = recoveryQueue.then(operation);
  recoveryQueue = result.catch(() => {});
  return result;
}

function isPrivateAddress(address) {
  const normalized = String(address).replace(/^\[|\]$/g, "");
  const family = net.isIP(normalized);
  if (!family) return true;
  return blockedRemoteAddresses.check(normalized, family === 4 ? "ipv4" : "ipv6");
}

async function validateRemoteImageUrl(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || (parsed.port && parsed.port !== "443")) {
    throw new Error("仅支持标准 HTTPS 远程图片。");
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  const literalFamily = net.isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("已阻止本机、局域网或保留地址中的远程图片。");
  }
  return { parsed, address: addresses[0].address, family: addresses[0].family };
}

async function fetchRemoteImage(value, redirects = 0) {
  if (redirects > 3) throw new Error("远程图片重定向次数过多。");
  const { parsed, address, family } = await validateRemoteImageUrl(value);
  let request;
  let response;
  const timeout = setTimeout(() => {
    const error = new Error("远程图片加载超时。");
    if (response) response.destroy(error);
    else if (request) request.destroy(error);
  }, REMOTE_IMAGE_TIMEOUT_MS);
  try {
    response = await new Promise((resolve, reject) => {
      request = https.get(parsed, {
        family,
        headers: { Accept: "image/png,image/jpeg,image/gif,image/webp,image/avif" },
        lookup: (_hostname, options, callback) => {
          if (options?.all) callback(null, [{ address, family }]);
          else callback(null, address, family);
        },
      }, resolve);
      request.on("error", reject);
    });
    if (response.statusCode >= 300 && response.statusCode < 400) {
      const location = response.headers.location;
      response.resume();
      if (!location) throw new Error("远程图片重定向无效。");
      return fetchRemoteImage(new URL(location, parsed).toString(), redirects + 1);
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      response.resume();
      throw new Error(`远程图片加载失败（HTTP ${response.statusCode}）。`);
    }
    const mediaType = (response.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
    if (!ALLOWED_REMOTE_IMAGE_TYPES.has(mediaType)) {
      response.resume();
      throw new Error("远程地址返回的不是受支持的位图格式。");
    }
    const declaredLength = Number(response.headers["content-length"] || 0);
    if (declaredLength > MAX_REMOTE_IMAGE_BYTES) {
      response.resume();
      throw new Error("远程图片超过 10 MB。");
    }
    const chunks = [];
    let total = 0;
    for await (const chunk of response) {
      total += chunk.length;
      if (total > MAX_REMOTE_IMAGE_BYTES) throw new Error("远程图片超过 10 MB。");
      chunks.push(Buffer.from(chunk));
    }
    return `data:${mediaType};base64,${Buffer.concat(chunks).toString("base64")}`;
  } finally {
    clearTimeout(timeout);
    if (response && !response.complete && !response.destroyed) response.destroy();
  }
}

function sendCommand(command) {
  const window = BrowserWindow.getFocusedWindow();
  if (window) window.webContents.send("app:command", command);
}

function markdownPathFromArgs(argumentsList) {
  return argumentsList.find((argument) => {
    if (!argument || argument.startsWith("--")) return false;
    return MARKDOWN_EXTENSIONS.has(path.extname(argument).toLowerCase());
  });
}

function openPathInWindow(window, filePath) {
  if (!window || !filePath) return;
  window.webContents.send("app:open-path", path.resolve(filePath));
  if (window.isMinimized()) window.restore();
  window.focus();
}

function buildMenu() {
  const template = [
    {
      label: "文件",
      submenu: [
        { label: "新建", accelerator: "CmdOrCtrl+N", click: () => sendCommand("new") },
        { label: "打开文件...", accelerator: "CmdOrCtrl+O", click: () => sendCommand("open-file") },
        { label: "打开文件夹...", accelerator: "CmdOrCtrl+Shift+O", click: () => sendCommand("open-folder") },
        { type: "separator" },
        { label: "保存", accelerator: "CmdOrCtrl+S", click: () => sendCommand("save") },
        { label: "另存为...", accelerator: "CmdOrCtrl+Shift+S", click: () => sendCommand("save-as") },
        { label: "文档转换...", accelerator: "CmdOrCtrl+Alt+C", click: () => sendCommand("convert") },
        { type: "separator" },
        { label: "退出", role: "quit" },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { label: "撤销", role: "undo", accelerator: "CmdOrCtrl+Z" },
        { label: "重做", role: "redo", accelerator: "CmdOrCtrl+Y" },
        { type: "separator" },
        { label: "剪切", role: "cut" },
        { label: "复制", role: "copy" },
        { label: "粘贴", role: "paste" },
        { label: "全选", role: "selectAll" },
        { type: "separator" },
        { label: "查找", accelerator: "CmdOrCtrl+F", click: () => sendCommand("find") },
      ],
    },
    {
      label: "视图",
      submenu: [
        { label: "仅编辑器", accelerator: "CmdOrCtrl+1", click: () => sendCommand("view-editor") },
        { label: "分屏", accelerator: "CmdOrCtrl+2", click: () => sendCommand("view-split") },
        { label: "仅预览", accelerator: "CmdOrCtrl+3", click: () => sendCommand("view-preview") },
        { type: "separator" },
        { label: "重新加载", accelerator: "CmdOrCtrl+R", click: () => sendCommand("reload") },
        { label: "开发者工具", role: "toggleDevTools" },
        { type: "separator" },
        { label: "重置缩放", role: "resetZoom" },
        { label: "放大", role: "zoomIn" },
        { label: "缩小", role: "zoomOut" },
        { label: "切换全屏", role: "togglefullscreen" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function readTextFile(filePath) {
  if (typeof filePath !== "string" || !filePath) throw new Error("请选择一个文件。");
  const stats = await fs.stat(filePath);
  if (!stats.isFile()) throw new Error("所选路径不是文件。");
  if (stats.size > MAX_FILE_BYTES) throw new Error("暂不支持大于 20 MB 的文件。");
  const buffer = await fs.readFile(filePath);
  return { filePath, fileUrl: pathToFileURL(filePath).href, ...decodeText(buffer), fingerprint: fingerprint(buffer) };
}

async function scanDirectory(directory, state, depth = 0) {
  if (depth > 12 || state.files >= MAX_TREE_FILES) return [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });

  const nodes = [];
  for (const entry of entries) {
    if (state.files >= MAX_TREE_FILES) break;
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const children = await scanDirectory(entryPath, state, depth + 1);
      if (children.length) nodes.push({ type: "folder", name: entry.name, path: entryPath, children });
    } else if (entry.isFile() && MARKDOWN_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      state.files += 1;
      nodes.push({ type: "file", name: entry.name, path: entryPath });
    }
  }
  return nodes;
}

function registerIpc() {
  ipcMain.handle("app:get-initial-open-path", (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return null;
    const state = stateFor(window);
    const initialPath = state.initialPath || null;
    state.initialPath = null;
    return initialPath;
  });

  ipcMain.handle("dialog:open-file", async (event) => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: "打开 Markdown 文件",
      properties: ["openFile"],
      filters: [
        { name: "Markdown 和文本", extensions: ["md", "markdown", "mdown", "mkd", "txt"] },
        { name: "所有文件", extensions: ["*"] },
      ],
    });
    return result.canceled ? null : readTextFile(result.filePaths[0]);
  });

  ipcMain.handle("dialog:open-folder", async (event) => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: "打开文件夹",
      properties: ["openDirectory"],
    });
    if (result.canceled) return null;
    const rootPath = result.filePaths[0];
    const state = { files: 0 };
    return {
      rootPath,
      name: path.basename(rootPath),
      children: await scanDirectory(rootPath, state),
      truncated: state.files >= MAX_TREE_FILES,
    };
  });

  ipcMain.handle("test:scan-folder", async (_event, rootPath) => {
    if (!e2eTest) throw new Error("测试接口仅在端到端测试中可用。");
    const state = { files: 0 };
    return {
      rootPath,
      name: path.basename(rootPath),
      children: await scanDirectory(rootPath, state),
      truncated: state.files >= MAX_TREE_FILES,
    };
  });

  ipcMain.handle("file:read", (_event, filePath) => readTextFile(filePath));

  ipcMain.handle("file:save", async (event, payload) => {
    if (!payload || typeof payload.content !== "string") throw new Error("保存请求无效。");
    if (Buffer.byteLength(payload.content, "utf8") > MAX_FILE_BYTES) {
      throw new Error("暂不支持大于 20 MB 的文档。");
    }

    let filePath = payload.filePath;
    if (!filePath) {
      const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
        title: "保存 Markdown 文件",
        defaultPath: "未命名.md",
        filters: [
          { name: "Markdown 文档", extensions: ["md"] },
          { name: "文本文档", extensions: ["txt"] },
        ],
      });
      if (result.canceled) return null;
      filePath = result.filePath;
    }

    const data = encodeText(payload.content, payload.encoding, payload.bom, payload.eol);
    if (data.length > MAX_FILE_BYTES) throw new Error("保存后的文档编码结果超过 20 MB。");
    const hasExpectedFingerprint = Object.prototype.hasOwnProperty.call(payload, "expectedFingerprint");
    const shouldCheck = hasExpectedFingerprint || typeof payload.baseFingerprint === "string";
    const expectedFingerprint = hasExpectedFingerprint ? payload.expectedFingerprint : payload.baseFingerprint;
    const writeResult = await atomicWrite(filePath, data, { checkExpected: shouldCheck, expectedFingerprint: expectedFingerprint ?? null });
    if (writeResult.conflict) return { conflict: true, filePath, ...writeResult };
    return {
      filePath,
      fileUrl: pathToFileURL(filePath).href,
      fingerprint: fingerprint(data),
      encoding: payload.encoding || "utf8",
      encodingUncertain: false,
      bom: Boolean(payload.bom),
      eol: payload.eol || "lf",
    };
  });

  ipcMain.handle("recovery:get", () => serializeRecovery(async () => {
      try {
        const value = JSON.parse(await fs.readFile(recoveryPath(), "utf8"));
        return value && typeof value.content === "string" ? value : null;
      } catch (error) {
        if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
        throw error;
      }
    }));

  ipcMain.handle("recovery:write", (_event, draft) => serializeRecovery(async () => {
    if (!draft || typeof draft.content !== "string") throw new Error("恢复草稿无效。");
    if (Buffer.byteLength(draft.content, "utf8") > MAX_FILE_BYTES) throw new Error("恢复草稿超过 20 MB。");
    await fs.mkdir(path.dirname(recoveryPath()), { recursive: true });
    await atomicWrite(recoveryPath(), Buffer.from(`${JSON.stringify({
      filePath: typeof draft.filePath === "string" ? draft.filePath : null,
      fileUrl: typeof draft.fileUrl === "string" ? draft.fileUrl : null,
      content: draft.content,
      encoding: draft.encoding || "utf8",
      encodingUncertain: Boolean(draft.encodingUncertain),
      bom: Boolean(draft.bom),
      eol: draft.eol || "lf",
      fingerprint: typeof draft.fingerprint === "string" ? draft.fingerprint : null,
      savedAt: new Date().toISOString(),
    })}\n`, "utf8"));
    return true;
  }));

  ipcMain.handle("recovery:clear", () => serializeRecovery(async () => {
    await fs.rm(recoveryPath(), { force: true });
    return true;
  }));

  ipcMain.handle("remote-image:load", async (_event, url) => ({ dataUrl: await fetchRemoteImage(url) }));

  ipcMain.handle("test:write-external", async (_event, filePath, content) => {
    if (!e2eTest) throw new Error("测试接口仅在端到端测试中可用。");
    await fs.writeFile(filePath, content, "utf8");
    return true;
  });

  ipcMain.handle("test:list-directory", async (_event, directory) => {
    if (!e2eTest) throw new Error("测试接口仅在端到端测试中可用。");
    return fs.readdir(directory);
  });

  ipcMain.handle("shell:open-external", async (_event, url) => {
    const parsed = new URL(url);
    if (!new Set(["http:", "https:", "mailto:"]).has(parsed.protocol)) {
      throw new Error("不支持此外部链接协议。");
    }
    await shell.openExternal(parsed.toString());
  });

  ipcMain.handle("conversion:get-capabilities", async () => {
    const conversion = await conversionModule();
    const [capabilities, ocr] = await Promise.all([
      conversion.detectCapabilities(),
      conversion.getOcrStatus(ocrDirectory()),
    ]);
    return {
      capabilities: {
        office: {
          word: { available: capabilities.office.word.available, version: capabilities.office.word.version },
          powerPoint: { available: capabilities.office.powerPoint.available, version: capabilities.office.powerPoint.version },
        },
        libreOffice: { available: capabilities.libreOffice.available, version: capabilities.libreOffice.version },
        pandoc: { available: capabilities.pandoc.available, version: capabilities.pandoc.version },
      },
      ocr,
      formats: {
        inputs: ["md", "docx", "doc", "pdf", "pptx", "ppt"],
        targets: ["md", "docx", "pdf", "pptx"],
      },
      limits: { maxBytes: MAX_FILE_BYTES * 5, maxPages: 500, maxOcrPages: 200 },
    };
  });

  ipcMain.handle("conversion:choose-input", async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(window, {
      title: "选择要转换的文档",
      properties: ["openFile"],
      filters: [
        { name: "支持的文档", extensions: ["md", "markdown", "docx", "doc", "pdf", "pptx", "ppt"] },
        { name: "Markdown", extensions: ["md", "markdown"] },
        { name: "Word", extensions: ["docx", "doc"] },
        { name: "PDF", extensions: ["pdf"] },
        { name: "PowerPoint", extensions: ["pptx", "ppt"] },
      ],
    });
    if (result.canceled) return null;
    const filePath = path.resolve(result.filePaths[0]);
    conversionAccessFor(event.sender).inputs.add(conversionPathKey(filePath));
    return filePath;
  });

  ipcMain.handle("conversion:choose-output", async (event, payload) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const target = ["md", "docx", "pdf", "pptx"].includes(payload?.target) ? payload.target : null;
    if (!target) throw new Error("转换目标格式无效。");
    const extension = target === "md" ? "md" : target;
    const baseName = String(payload?.baseName || "转换结果").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
    const result = await dialog.showSaveDialog(window, {
      title: "保存转换结果",
      defaultPath: `${baseName}.${extension}`,
      filters: [{ name: target === "md" ? "Markdown" : target.toUpperCase(), extensions: [extension] }],
    });
    if (result.canceled) return null;
    const filePath = path.resolve(result.filePath);
    conversionAccessFor(event.sender).outputs.add(conversionPathKey(filePath));
    return filePath;
  });

  ipcMain.handle("conversion:start", async (event, payload) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) throw new Error("转换窗口无效。");
    const request = validateConversionPayload(payload);
    const access = conversionAccessFor(event.sender);
    if (!conversionE2eTest && request.source.kind === "file" && !access.inputs.has(conversionPathKey(request.source.filePath))) {
      throw new Error("转换来源未经过文件选择确认。");
    }
    if (!conversionE2eTest && !access.outputs.has(conversionPathKey(request.outputPath))) {
      throw new Error("转换输出路径未经过保存位置确认。");
    }
    if (conversionJobs.has(request.jobId)) throw new Error("转换任务编号重复。");
    if ([...conversionJobs.values()].some((job) => job.senderId === event.sender.id)) throw new Error("当前窗口已有转换任务正在运行。");
    const conversion = await conversionModule();
    if (request.options.ocr) {
      const ocrStatus = await conversion.getOcrStatus(ocrDirectory());
      const missing = request.options.ocrLanguages.filter((language) => !ocrStatus[language]?.valid);
      if (missing.length) throw new Error("所选 OCR 语言包尚未安装或校验失败。");
    }
    const assetPath = request.target === "md"
      ? path.join(path.dirname(request.outputPath), `${path.basename(request.outputPath, path.extname(request.outputPath))}_assets`)
      : null;
    const outputExists = await fs.stat(request.outputPath).then(() => true, () => false);
    const assetsExist = assetPath ? await fs.stat(assetPath).then(() => true, () => false) : false;
    if (outputExists || assetsExist) {
      const overwrite = await dialog.showMessageBox(window, {
        type: "warning",
        title: "覆盖转换结果",
        message: outputExists ? `文件已存在：${path.basename(request.outputPath)}` : "转换资源目录已存在",
        detail: assetsExist
          ? `继续将替换现有文件及资源目录 ${path.basename(assetPath)}。原始来源文件不会被修改。`
          : "继续将替换现有文件。原始来源文件不会被修改。",
        buttons: ["覆盖", "取消"],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (overwrite.response !== 0) return { canceled: true };
    }
    const controller = new AbortController();
    conversionJobs.set(request.jobId, { controller, senderId: event.sender.id });
    const sendProgress = (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send("conversion:progress", { jobId: request.jobId, ...progress });
    };
    try {
      const result = await conversion.convertDocument(request, {
        signal: controller.signal,
        progress: sendProgress,
        ocrDataPath: ocrDirectory(),
        remoteImageLoader: (url) => fetchRemoteImage(url).then((dataUrl) => ({ dataUrl })),
      });
      sendProgress({ stage: "done", progress: 1, message: "转换完成。" });
      access.results.add(conversionPathKey(result.outputPath));
      return { canceled: false, ...result };
    } finally {
      conversionJobs.delete(request.jobId);
    }
  });

  ipcMain.handle("conversion:cancel", (event, jobId) => {
    const job = conversionJobs.get(jobId);
    if (!job || job.senderId !== event.sender.id) return false;
    job.controller.abort();
    return true;
  });

  ipcMain.handle("conversion:download-ocr-language", async (event, language) => {
    const conversion = await conversionModule();
    const filePath = await conversion.downloadOcrLanguage(language, ocrDirectory(), (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send("conversion:component-progress", { language, ...progress });
    });
    return { filePath, status: await conversion.getOcrStatus(ocrDirectory()) };
  });

  ipcMain.handle("conversion:open-component-page", async (_event, component) => {
    const conversion = await conversionModule();
    const url = conversion.componentPages[component];
    if (!url) throw new Error("未知的转换组件。");
    await shell.openExternal(url);
  });

  ipcMain.handle("conversion:open-result", async (event, filePath) => {
    if (typeof filePath !== "string" || !path.isAbsolute(filePath)) throw new Error("结果路径无效。");
    if (!conversionAccessFor(event.sender).results.has(conversionPathKey(filePath))) throw new Error("该路径不是当前窗口生成的转换结果。");
    const error = await shell.openPath(filePath);
    if (error) throw new Error(error);
  });

  ipcMain.handle("conversion:show-result", (event, filePath) => {
    if (typeof filePath !== "string" || !path.isAbsolute(filePath)) throw new Error("结果路径无效。");
    if (!conversionAccessFor(event.sender).results.has(conversionPathKey(filePath))) throw new Error("该路径不是当前窗口生成的转换结果。");
    shell.showItemInFolder(filePath);
  });

  ipcMain.on("window:set-dirty", (event, dirty) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window) stateFor(window).dirty = Boolean(dirty);
  });

  ipcMain.on("window:set-title", (event, title) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window) window.setTitle(`${String(title || "未命名")} - 清墨`);
  });

  ipcMain.on("window:finish-close", (event, saved) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || !saved) return;
    const state = stateFor(window);
    state.dirty = false;
    state.allowClose = true;
    window.close();
  });

  ipcMain.on("window:reload", (event, filePath) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return;
    stateFor(window).initialPath = typeof filePath === "string" && filePath ? path.resolve(filePath) : null;
    window.webContents.reload();
  });
}

async function runConversionE2e(window) {
  if (!conversionE2eDirectory) throw new Error("缺少 --conversion-e2e-dir 参数。");
  await fs.rm(conversionE2eDirectory, { recursive: true, force: true });
  await fs.mkdir(path.join(conversionE2eDirectory, "assets"), { recursive: true });
  const sourcePath = path.join(conversionE2eDirectory, "00-转换源.md");
  const imagePath = path.join(conversionE2eDirectory, "assets", "test-image.svg");
  const markdown = `# 清墨转换测试

这是一段包含 **粗体**、[链接](https://github.com/ZuoXing-0504/MarkDown-Free) 和中文的正文。

## 数据表

| 项目 | 状态 |
| --- | --- |
| Markdown | 完成 |
| 文档转换 | 测试中 |

- 列表一
- 列表二

\`\`\`js
console.log("CleanMark 0.4.0");
\`\`\`

![清墨测试图片](assets/test-image.svg)
`;
  await fs.writeFile(sourcePath, markdown, "utf8");
  await fs.writeFile(imagePath, `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="240" viewBox="0 0 480 240"><rect width="480" height="240" rx="24" fill="#17324d"/><path d="M65 55h90v130H65z" fill="#54b7ad"/><path d="M90 85h150v18H90zm0 42h300v14H90zm0 35h240v14H90z" fill="#fff"/><text x="260" y="103" fill="#fff" font-size="30" font-family="Segoe UI, sans-serif">清墨 CleanMark</text></svg>`, "utf8");
  const outputs = {
    pdf: path.join(conversionE2eDirectory, "01-Markdown转PDF.pdf"),
    docx: path.join(conversionE2eDirectory, "02-Markdown转Word.docx"),
    pptx: path.join(conversionE2eDirectory, "03-Markdown转PPT.pptx"),
    docxMarkdown: path.join(conversionE2eDirectory, "04-Word转Markdown.md"),
    pdfMarkdown: path.join(conversionE2eDirectory, "05-PDF转Markdown.md"),
    docxPdf: path.join(conversionE2eDirectory, "06-Word转PDF.pdf"),
    docxPptx: path.join(conversionE2eDirectory, "07-Word转PPT.pptx"),
    pdfDocx: path.join(conversionE2eDirectory, "08-PDF转Word.docx"),
    pdfPptx: path.join(conversionE2eDirectory, "09-PDF转PPT.pptx"),
    pptxMarkdown: path.join(conversionE2eDirectory, "10-PPT转Markdown.md"),
    pptxDocx: path.join(conversionE2eDirectory, "11-PPT转Word.docx"),
    pptxPdf: path.join(conversionE2eDirectory, "12-PPT转PDF.pdf"),
    visualPdfDocx: path.join(conversionE2eDirectory, "13-PDF视觉保真转Word.docx"),
    visualPdfPptx: path.join(conversionE2eDirectory, "14-PDF视觉保真转PPT.pptx"),
  };
  const rendererResult = await window.webContents.executeJavaScript(`(async () => {
    const api = window.cleanmark;
    const convertButton = document.querySelector("#convert-button");
    const dialog = document.querySelector("#conversion-dialog");
    convertButton.click();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const modalOpen = dialog.open;
    document.querySelector("#conversion-close").click();
    const run = (source, target, outputPath, mode = "editable") => api.startConversion({
      jobId: crypto.randomUUID(),
      source,
      target,
      mode,
      outputPath,
      options: { includeRemoteImages: false, ocr: false, ocrLanguages: ["chi_sim", "eng"] }
    });
    const editorSource = { kind: "editor", content: ${JSON.stringify(markdown)}, filePath: ${JSON.stringify(sourcePath)} };
    const pdf = await run(editorSource, "pdf", ${JSON.stringify(outputs.pdf)});
    const docx = await run(editorSource, "docx", ${JSON.stringify(outputs.docx)});
    const pptx = await run(editorSource, "pptx", ${JSON.stringify(outputs.pptx)});
    const docxMarkdown = await run({ kind: "file", filePath: ${JSON.stringify(outputs.docx)} }, "md", ${JSON.stringify(outputs.docxMarkdown)});
    const pdfMarkdown = await run({ kind: "file", filePath: ${JSON.stringify(outputs.pdf)} }, "md", ${JSON.stringify(outputs.pdfMarkdown)});
    const docxPdf = await run({ kind: "file", filePath: ${JSON.stringify(outputs.docx)} }, "pdf", ${JSON.stringify(outputs.docxPdf)});
    const docxPptx = await run({ kind: "file", filePath: ${JSON.stringify(outputs.docx)} }, "pptx", ${JSON.stringify(outputs.docxPptx)});
    const pdfDocx = await run({ kind: "file", filePath: ${JSON.stringify(outputs.pdf)} }, "docx", ${JSON.stringify(outputs.pdfDocx)});
    const pdfPptx = await run({ kind: "file", filePath: ${JSON.stringify(outputs.pdf)} }, "pptx", ${JSON.stringify(outputs.pdfPptx)});
    const pptxMarkdown = await run({ kind: "file", filePath: ${JSON.stringify(outputs.pptx)} }, "md", ${JSON.stringify(outputs.pptxMarkdown)});
    const pptxDocx = await run({ kind: "file", filePath: ${JSON.stringify(outputs.pptx)} }, "docx", ${JSON.stringify(outputs.pptxDocx)});
    const pptxPdf = await run({ kind: "file", filePath: ${JSON.stringify(outputs.pptx)} }, "pdf", ${JSON.stringify(outputs.pptxPdf)});
    const visualPdfDocx = await run({ kind: "file", filePath: ${JSON.stringify(outputs.pdf)} }, "docx", ${JSON.stringify(outputs.visualPdfDocx)}, "visual");
    const visualPdfPptx = await run({ kind: "file", filePath: ${JSON.stringify(outputs.pdf)} }, "pptx", ${JSON.stringify(outputs.visualPdfPptx)}, "visual");
    return {
      hasConversionApi: Boolean(api.startConversion && api.cancelConversion && api.getConversionCapabilities),
      hasConversionUi: Boolean(convertButton && dialog),
      modalOpen,
      results: {
        pdf, docx, pptx, docxMarkdown, pdfMarkdown,
        docxPdf, docxPptx, pdfDocx, pdfPptx,
        pptxMarkdown, pptxDocx, pptxPdf,
        visualPdfDocx, visualPdfPptx
      }
    };
  })()`);

  const readOutputs = await Promise.all(Object.entries(outputs).map(async ([name, filePath]) => [
    name,
    await fs.readFile(filePath, filePath.endsWith(".md") ? "utf8" : null),
  ]));
  const outputData = Object.fromEntries(readOutputs);
  const { default: JSZip } = await import("jszip");
  const zipFiles = Object.entries(outputs).filter(([, filePath]) => /\.(?:docx|pptx)$/i.test(filePath));
  const zipResults = Object.fromEntries(await Promise.all(zipFiles.map(async ([name]) => [name, await JSZip.loadAsync(outputData[name])])));
  const docxAssets = `${outputs.docxMarkdown.slice(0, -3)}_assets`;
  const assetFiles = await fs.readdir(docxAssets).catch(() => []);
  const directoryEntries = await fs.readdir(conversionE2eDirectory);
  const assertions = {
    "转换中心界面可打开": rendererResult.hasConversionUi && rendererResult.modalOpen,
    "受限转换 API 可用": rendererResult.hasConversionApi,
    "Markdown 转 PDF": outputData.pdf.subarray(0, 5).toString("ascii") === "%PDF-" && outputData.pdf.length > 1000,
    "Markdown 转 DOCX": Boolean(zipResults.docx.file("word/document.xml")) && outputData.docx.length > 1000,
    "Markdown 转 PPTX": Boolean(zipResults.pptx.file("ppt/presentation.xml")) && outputData.pptx.length > 1000,
    "DOCX 转 Markdown": /清墨转换测试/.test(outputData.docxMarkdown) && /数据表/.test(outputData.docxMarkdown),
    "DOCX 图片资源落盘": assetFiles.some((name) => /^image-\d+\./.test(name)),
    "PDF 转 Markdown": /第 1 页/.test(outputData.pdfMarkdown) && outputData.pdfMarkdown.length > 30,
    "DOCX 转 PDF": outputData.docxPdf.subarray(0, 5).toString("ascii") === "%PDF-",
    "DOCX 转 PPTX": Boolean(zipResults.docxPptx.file("ppt/presentation.xml")),
    "PDF 转 DOCX": Boolean(zipResults.pdfDocx.file("word/document.xml")),
    "PDF 转 PPTX": Boolean(zipResults.pdfPptx.file("ppt/presentation.xml")),
    "PPTX 转 Markdown": /幻灯片 1/.test(outputData.pptxMarkdown) && outputData.pptxMarkdown.length > 30,
    "PPTX 转 DOCX": Boolean(zipResults.pptxDocx.file("word/document.xml")),
    "PPTX 转 PDF": outputData.pptxPdf.subarray(0, 5).toString("ascii") === "%PDF-",
    "PDF 视觉转 DOCX": Boolean(zipResults.visualPdfDocx.file("word/document.xml")),
    "PDF 视觉转 PPTX": Boolean(zipResults.visualPdfPptx.file("ppt/presentation.xml")),
    "转换结果报告完整": Object.values(rendererResult.results).every((result) => result && result.canceled === false && result.outputPath && result.sha256),
    "临时与备份文件清理": !directoryEntries.some((name) => /\.tmp|cleanmark-backup/i.test(name)),
  };
  const errors = Object.entries(assertions).filter(([, passed]) => !passed).map(([name]) => name);
  return { passed: errors.length === 0, assertions, errors, outputs, rendererResult };
}

function createWindow(initialPath = null) {
  const window = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 840,
    minHeight: 560,
    show: !smokeTest && !e2eTest && !conversionE2eTest,
    backgroundColor: "#f6f7f9",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  const state = stateFor(window);
  state.initialPath = initialPath ? path.resolve(initialPath) : null;
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.once("destroyed", () => conversionAccess.delete(window.webContents.id));
  if (smokeTest || e2eTest || conversionE2eTest) {
    window.webContents.on("render-process-gone", (_event, details) => {
      console.error(`RENDER_PROCESS_GONE ${JSON.stringify(details)}`);
    });
    window.webContents.on("console-message", (_event, details) => {
      if (details.level === "error") console.error(`RENDERER_CONSOLE ${details.message}`);
    });
  }

  window.on("close", async (event) => {
    const state = stateFor(window);
    if (state.allowClose || !state.dirty) return;
    event.preventDefault();
    if (state.closePromptOpen) return;
    state.closePromptOpen = true;

    const result = await dialog.showMessageBox(window, {
      type: "question",
      title: "存在未保存的更改",
      message: "关闭前要保存更改吗？",
      detail: "如果不保存，当前更改将会丢失。",
      buttons: ["保存", "不保存", "取消"],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    state.closePromptOpen = false;

    if (result.response === 0) {
      window.webContents.send("app:save-before-close");
    } else if (result.response === 1) {
      await fs.rm(recoveryPath(), { force: true }).catch(() => {});
      state.allowClose = true;
      window.close();
    }
  });

  if (smokeTest) {
    window.webContents.once("did-finish-load", async () => {
      let temporaryDirectory;
      let exitCode = 1;
      try {
        temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "cleanmark-smoke-"));
        const fixturePath = path.join(temporaryDirectory, "fixture.md");
        await fs.writeFile(fixturePath, "# IPC fixture", "utf8");

        const result = await window.webContents.executeJavaScript(`(async () => {
          const fixture = await window.cleanmark.readFile(${JSON.stringify(fixturePath)});
          await window.cleanmark.saveFile(fixture.filePath, "# Updated by IPC");
          const editor = document.querySelector("#editor");
          const repositoryLink = [...document.querySelectorAll("#preview a")].find(
            (link) => link.href === "https://github.com/ZuoXing-0504/MarkDown-Free"
          );
          editor.value = "# Rendered heading\\n\\n<script>window.__unsafe = true</script>";
          editor.dispatchEvent(new Event("input", { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 150));
          return {
            hasApi: Boolean(window.cleanmark),
            hasEditor: Boolean(editor),
            hasPreview: Boolean(document.querySelector("#preview")),
            renderedHeading: document.querySelector("#preview h1")?.textContent,
            scriptRemoved: !document.querySelector("#preview script") && !window.__unsafe,
            fixtureContent: fixture.content,
            repositoryLink: Boolean(repositoryLink),
            title: document.title
          };
        })()`);
        const savedContent = await fs.readFile(fixturePath, "utf8");
        if (
          !result.hasApi ||
          !result.hasEditor ||
          !result.hasPreview ||
          result.fixtureContent !== "# IPC fixture" ||
          !result.repositoryLink ||
          savedContent !== "# Updated by IPC" ||
          result.renderedHeading !== "Rendered heading" ||
          !result.scriptRemoved
        ) {
          throw new Error(`Smoke assertions failed: ${JSON.stringify(result)}`);
        }
        console.log(`SMOKE_OK ${JSON.stringify(result)}`);
        exitCode = 0;
      } catch (error) {
        console.error(error);
      } finally {
        if (temporaryDirectory) {
          try {
            fsSync.rmSync(temporaryDirectory, { recursive: true, force: true });
          } catch (error) {
            console.error(`SMOKE_CLEANUP_FAILED ${error.stack || error}`);
            exitCode = 1;
          }
        }
        if (smokeReportPath) {
          try {
            fsSync.mkdirSync(path.dirname(smokeReportPath), { recursive: true });
            fsSync.writeFileSync(smokeReportPath, `${JSON.stringify({ passed: exitCode === 0, exitCode }, null, 2)}\n`, "utf8");
          } catch (error) {
            console.error(`SMOKE_REPORT_FAILED ${error.stack || error}`);
            exitCode = 1;
          }
        }
        console.log(`SMOKE_EXIT ${exitCode}`);
        exitTest(exitCode);
      }
    });
    window.webContents.once("did-fail-load", (_event, code, description) => {
      console.error(`SMOKE_LOAD_FAILED ${code} ${description}`);
      exitTest(1);
    });
  }


  if (e2eTest) {
    window.webContents.once("did-finish-load", async () => {
      if (!e2eDirectory) {
        console.error("E2E_FAILED Missing --e2e-dir argument.");
        exitTest(1);
        return;
      }
      window.webContents.send("app:e2e-run", { directory: e2eDirectory });
    });
  }

  if (conversionE2eTest) {
    window.webContents.once("did-finish-load", async () => {
      try {
        const result = await runConversionE2e(window);
        await fs.writeFile(path.join(conversionE2eDirectory, "测试报告.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
        console.log(`${result.passed ? "CONVERSION_E2E_OK" : "CONVERSION_E2E_FAILED"} ${JSON.stringify(result)}`);
        exitTest(result.passed ? 0 : 1);
      } catch (error) {
        console.error(`CONVERSION_E2E_FAILED ${error.stack || error}`);
        exitTest(1);
      }
    });
  }

  window.loadFile(path.join(__dirname, "..", "dist", "index.html")).catch((error) => {
    console.error(`WINDOW_LOAD_FAILED ${error.stack || error}`);
    if (smokeTest || e2eTest) exitTest(1);
  });
}

app.whenReady().then(() => {
  registerIpc();
  ipcMain.on("app:e2e-result", async (_event, result) => {
    if (!e2eTest) return;
    const passed = Boolean(result?.passed);
    if (e2eDirectory) {
      await fs.writeFile(path.join(e2eDirectory, "测试报告.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
    }
    console.log(`${passed ? "E2E_OK" : "E2E_FAILED"} ${JSON.stringify(result)}`);
    exitTest(passed ? 0 : 1);
  });
  buildMenu();
  const initialPath = markdownPathFromArgs(process.argv.slice(1));
  createWindow(initialPath);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("second-instance", (_event, commandLine) => {
  const window = BrowserWindow.getAllWindows()[0];
  openPathInWindow(window, markdownPathFromArgs(commandLine.slice(1)));
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
