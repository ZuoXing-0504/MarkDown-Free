"use strict";

const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require("electron");
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
const MAX_TREE_FILES = 2000;
const MAX_REMOTE_IMAGE_BYTES = 10 * 1024 * 1024;
const REMOTE_IMAGE_TIMEOUT_MS = 15_000;
const RECOVERY_FILE = "recovery-draft.json";
const ALLOWED_REMOTE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);
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
let recoveryQueue = Promise.resolve();
const smokeTest = process.argv.includes("--smoke-test");
const e2eTest = process.argv.includes("--e2e-test");
const e2eDirectoryArgument = process.argv.find((argument) => argument.startsWith("--e2e-dir="));
const e2eDirectory = e2eDirectoryArgument ? path.resolve(e2eDirectoryArgument.slice("--e2e-dir=".length)) : null;

if (smokeTest || e2eTest) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.setPath("userData", path.join(os.tmpdir(), `cleanmark-test-${process.pid}`));
}

const gotSingleInstanceLock = smokeTest || e2eTest || app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) app.quit();

if (smokeTest || e2eTest) {
  const timeout = e2eTest ? 120_000 : 30_000;
  setTimeout(() => {
    console.error(`${e2eTest ? "E2E" : "SMOKE"}_FAILED Timed out after ${timeout}ms.`);
    app.exit(1);
  }, timeout);
}

function stateFor(window) {
  if (!windowState.has(window)) {
    windowState.set(window, { dirty: false, allowClose: false, closePromptOpen: false });
  }
  return windowState.get(window);
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

function createWindow(initialPath = null) {
  const window = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 840,
    minHeight: 560,
    show: !smokeTest && !e2eTest,
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
        app.exit(0);
      } catch (error) {
        console.error(error);
        app.exit(1);
      } finally {
        if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
      }
    });
    window.webContents.once("did-fail-load", (_event, code, description) => {
      console.error(`SMOKE_LOAD_FAILED ${code} ${description}`);
      app.exit(1);
    });
  }


  if (e2eTest) {
    window.webContents.once("did-finish-load", async () => {
      if (!e2eDirectory) {
        console.error("E2E_FAILED Missing --e2e-dir argument.");
        app.exit(1);
        return;
      }
      window.webContents.send("app:e2e-run", { directory: e2eDirectory });
    });
  }

  window.loadFile(path.join(__dirname, "..", "dist", "index.html"));
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
    app.exit(passed ? 0 : 1);
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
