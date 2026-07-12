"use strict";

const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require("electron");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdown", ".mkd", ".txt"]);
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TREE_FILES = 2000;
const windowState = new WeakMap();
const smokeTest = process.argv.includes("--smoke-test");
const e2eTest = process.argv.includes("--e2e-test");
const e2eDirectoryArgument = process.argv.find((argument) => argument.startsWith("--e2e-dir="));
const e2eDirectory = e2eDirectoryArgument ? path.resolve(e2eDirectoryArgument.slice("--e2e-dir=".length)) : null;
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) app.quit();

if (smokeTest || e2eTest) {
  app.setPath("userData", path.join(os.tmpdir(), `cleanmark-test-${process.pid}`));
}

function stateFor(window) {
  if (!windowState.has(window)) {
    windowState.set(window, { dirty: false, allowClose: false, closePromptOpen: false });
  }
  return windowState.get(window);
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
        { label: "重新加载", role: "reload" },
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
  return { filePath, content: await fs.readFile(filePath, "utf8") };
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

    await fs.writeFile(filePath, payload.content, "utf8");
    return { filePath };
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

  stateFor(window);
  if (initialPath) {
    window.webContents.once("did-finish-load", () => openPathInWindow(window, initialPath));
  }
  window.loadFile(path.join(__dirname, "..", "dist", "index.html"));

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
