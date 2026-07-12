import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { marked } from "marked";

const api = window.cleanmark;
const elements = {
  app: document.querySelector("#app"),
  editor: document.querySelector("#editor"),
  preview: document.querySelector("#preview"),
  title: document.querySelector("#title"),
  dirtyDot: document.querySelector("#dirty-dot"),
  status: document.querySelector("#status"),
  cursorStatus: document.querySelector("#cursor-status"),
  wordCount: document.querySelector("#word-count"),
  fileTree: document.querySelector("#file-tree"),
  fileFilter: document.querySelector("#file-filter"),
  folderName: document.querySelector("#folder-name"),
  autosave: document.querySelector("#autosave"),
  themeButton: document.querySelector("#theme-button"),
  findPanel: document.querySelector("#find-panel"),
  findInput: document.querySelector("#find-input"),
};

const state = {
  filePath: null,
  dirty: false,
  folder: null,
  view: localStorage.getItem("cleanmark.view") || "split",
  theme: localStorage.getItem("cleanmark.theme") || "system",
  autosave: localStorage.getItem("cleanmark.autosave") === "true",
  autosaveTimer: null,
  renderTimer: null,
  revision: 0,
  documentToken: 0,
  savedContent: "",
};

const welcomeDocument = `# 欢迎使用清墨

清墨是一款从零独立开发的轻量 Markdown 编辑器。

## 开始写作

- 使用 **Ctrl+O** 打开 Markdown 文件。
- 打开文件夹后，可在侧边栏浏览文档。
- 可在编辑、分屏和预览模式之间切换。
- 可在左下角启用自动保存。

> 本项目使用沙箱化的 Electron 渲染进程和受限文件系统桥接。

\`\`\`js
console.log("Markdown 已准备就绪。");
\`\`\`
`;

marked.setOptions({ gfm: true, breaks: false });

function baseName(filePath) {
  return filePath ? filePath.split(/[\\/]/).pop() : "未命名";
}

function setStatus(message, timeout = 2500) {
  elements.status.textContent = message;
  if (timeout) {
    window.setTimeout(() => {
      if (elements.status.textContent === message) elements.status.textContent = "就绪";
    }, timeout);
  }
}

function reportError(error) {
  console.error(error);
  setStatus(error?.message || "操作失败。", 5000);
}

function setDirty(dirty) {
  state.dirty = dirty;
  elements.dirtyDot.hidden = !dirty;
  api.setDirty(dirty);
}

function updateTitle() {
  const title = baseName(state.filePath);
  elements.title.textContent = title;
  api.setTitle(title);
}

function countWords(text) {
  const latinWords = text.match(/[A-Za-z0-9_]+(?:['-][A-Za-z0-9_]+)*/g) || [];
  const cjkCharacters = text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || [];
  return latinWords.length + cjkCharacters.length;
}

function updateCursorStatus() {
  const beforeCursor = elements.editor.value.slice(0, elements.editor.selectionStart);
  const lines = beforeCursor.split("\n");
  elements.cursorStatus.textContent = `第 ${lines.length} 行，第 ${lines.at(-1).length + 1} 列`;
}

function renderMarkdown() {
  const markdown = elements.editor.value;
  const rendered = marked.parse(markdown);
  elements.preview.innerHTML = DOMPurify.sanitize(rendered, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ["target", "rel"],
  });
  addHeadingAnchors();
  resolvePreviewImages();
  elements.preview.querySelectorAll("pre code").forEach((block) => hljs.highlightElement(block));
  elements.wordCount.textContent = `${countWords(markdown)} 字词`;
  state.renderTimer = null;
}

function addHeadingAnchors() {
  const usedIds = new Map();
  elements.preview.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((heading) => {
    const baseId =
      heading.textContent
        .trim()
        .toLowerCase()
        .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
        .replace(/\s+/g, "-") || "section";
    const count = usedIds.get(baseId) || 0;
    usedIds.set(baseId, count + 1);
    heading.id = count ? `${baseId}-${count}` : baseId;
  });
}

function resolvePreviewImages() {
  if (!state.filePath) return;
  const documentUrl = new URL(`file:///${state.filePath.replaceAll("\\", "/")}`);
  elements.preview.querySelectorAll("img[src]").forEach((image) => {
    const source = image.getAttribute("src");
    if (!source || /^(?:[a-z]+:|#|\/\/)/i.test(source)) return;
    image.src = new URL(source, documentUrl).href;
  });
}

function scheduleRender() {
  if (state.renderTimer) window.clearTimeout(state.renderTimer);
  state.renderTimer = window.setTimeout(renderMarkdown, 80);
}

function scheduleAutosave() {
  if (state.autosaveTimer) window.clearTimeout(state.autosaveTimer);
  if (!state.autosave || !state.filePath) return;
  const documentToken = state.documentToken;
  state.autosaveTimer = window.setTimeout(() => {
    if (documentToken === state.documentToken) saveDocument(false);
  }, 900);
}

function handleEditorInput() {
  state.revision += 1;
  setDirty(elements.editor.value !== state.savedContent);
  scheduleRender();
  scheduleAutosave();
}

function resetDocumentState() {
  if (state.autosaveTimer) window.clearTimeout(state.autosaveTimer);
  state.autosaveTimer = null;
  state.documentToken += 1;
  state.revision = 0;
}

async function confirmDiscard() {
  return !state.dirty || window.confirm("放弃当前文档中尚未保存的更改吗？");
}

function loadDocument(result) {
  resetDocumentState();
  state.filePath = result.filePath;
  elements.editor.value = result.content;
  state.savedContent = result.content;
  setDirty(false);
  updateTitle();
  renderMarkdown();
  updateCursorStatus();
  highlightActiveFile();
  elements.editor.focus();
  setStatus(`已打开 ${baseName(result.filePath)}`);
}

async function newDocument() {
  if (!(await confirmDiscard())) return;
  resetDocumentState();
  state.filePath = null;
  elements.editor.value = "";
  state.savedContent = "";
  setDirty(false);
  updateTitle();
  renderMarkdown();
  highlightActiveFile();
  elements.editor.focus();
  setStatus("已新建文档");
}

async function openFile() {
  if (!(await confirmDiscard())) return;
  try {
    const result = await api.openFile();
    if (result) loadDocument(result);
  } catch (error) {
    reportError(error);
  }
}

async function openPath(filePath) {
  if (filePath === state.filePath || !(await confirmDiscard())) return;
  try {
    loadDocument(await api.readFile(filePath));
  } catch (error) {
    reportError(error);
  }
}

async function saveDocument(saveAs = false) {
  const documentToken = state.documentToken;
  const revision = state.revision;
  const content = elements.editor.value;
  const originalPath = state.filePath;
  try {
    const result = await api.saveFile(saveAs ? null : originalPath, content);
    if (!result) return false;
    if (documentToken !== state.documentToken) return true;
    state.filePath = result.filePath;
    state.savedContent = content;
    setDirty(elements.editor.value !== state.savedContent);
    updateTitle();
    highlightActiveFile();
    setStatus(`已保存 ${baseName(result.filePath)}`);
    return true;
  } catch (error) {
    reportError(error);
    return false;
  }
}

function treeNode(node, filter) {
  if (node.type === "file") {
    if (filter && !node.name.toLowerCase().includes(filter)) return null;
    const button = document.createElement("div");
    button.className = "tree-file";
    button.dataset.path = node.path;
    button.title = node.path;
    button.textContent = node.name;
    button.tabIndex = 0;
    button.addEventListener("click", () => openPath(node.path));
    button.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") openPath(node.path);
    });
    return button;
  }

  const children = node.children.map((child) => treeNode(child, filter)).filter(Boolean);
  if (!children.length) return null;
  const details = document.createElement("details");
  details.className = "tree-folder";
  details.open = Boolean(filter);
  const summary = document.createElement("summary");
  summary.textContent = node.name;
  summary.title = node.path;
  const container = document.createElement("div");
  container.className = "tree-children";
  container.append(...children);
  details.append(summary, container);
  return details;
}

function renderTree() {
  if (!state.folder) return;
  const filter = elements.fileFilter.value.trim().toLowerCase();
  const root = {
    type: "folder",
    name: state.folder.name,
    path: state.folder.rootPath,
    children: state.folder.children,
  };
  const rendered = treeNode(root, filter);
  elements.fileTree.replaceChildren();
  if (rendered) {
    rendered.open = true;
    elements.fileTree.append(rendered);
  } else {
    const empty = document.createElement("div");
    empty.className = "empty-state compact";
    empty.textContent = "没有匹配的 Markdown 文件。";
    elements.fileTree.append(empty);
  }
  highlightActiveFile();
}

function highlightActiveFile() {
  elements.fileTree.querySelectorAll(".tree-file").forEach((item) => {
    item.classList.toggle("active", item.dataset.path === state.filePath);
  });
}

async function openFolder() {
  try {
    const result = await api.openFolder();
    if (!result) return;
    state.folder = result;
    elements.folderName.textContent = result.name;
    elements.fileFilter.value = "";
    renderTree();
    setStatus(result.truncated ? "文件夹已打开；文件列表最多显示 2,000 项。" : "文件夹已打开");
  } catch (error) {
    reportError(error);
  }
}

function setView(view) {
  if (!new Set(["editor", "split", "preview"]).has(view)) return;
  state.view = view;
  elements.app.dataset.view = view;
  document.querySelectorAll("[data-view-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.viewMode === view);
  });
  localStorage.setItem("cleanmark.view", view);
}

function applyTheme() {
  if (state.theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = state.theme;
  const themeNames = { system: "跟随系统", light: "浅色", dark: "深色" };
  elements.themeButton.textContent = `主题：${themeNames[state.theme]}`;
  localStorage.setItem("cleanmark.theme", state.theme);
}

function cycleTheme() {
  const themes = ["system", "light", "dark"];
  state.theme = themes[(themes.indexOf(state.theme) + 1) % themes.length];
  applyTheme();
}

function replaceSelection(prefix, suffix = prefix, placeholder = "text") {
  const editor = elements.editor;
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const selected = editor.value.slice(start, end) || placeholder;
  editor.setRangeText(`${prefix}${selected}${suffix}`, start, end, "select");
  editor.selectionStart = start + prefix.length;
  editor.selectionEnd = start + prefix.length + selected.length;
  editor.focus();
  handleEditorInput();
}

function prefixLines(prefix) {
  const editor = elements.editor;
  const start = editor.value.lastIndexOf("\n", editor.selectionStart - 1) + 1;
  const nextLine = editor.value.indexOf("\n", editor.selectionEnd);
  const end = nextLine === -1 ? editor.value.length : nextLine;
  const selected = editor.value.slice(start, end);
  const replaced = selected
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
  editor.setRangeText(replaced, start, end, "select");
  editor.focus();
  handleEditorInput();
}

function formatSelection(format) {
  const actions = {
    bold: () => replaceSelection("**", "**", "粗体文本"),
    italic: () => replaceSelection("_", "_", "斜体文本"),
    heading: () => prefixLines("## "),
    link: () => replaceSelection("[", "](https://example.com)", "链接文本"),
    code: () => replaceSelection("`", "`", "代码"),
    list: () => prefixLines("- "),
    quote: () => prefixLines("> "),
  };
  actions[format]?.();
}

function runHistoryCommand(command) {
  elements.editor.focus({ preventScroll: true });
  document.execCommand(command);
  window.setTimeout(() => {
    updateCursorStatus();
    scheduleRender();
  }, 0);
}

function showFind() {
  elements.findPanel.hidden = false;
  elements.findInput.focus();
  elements.findInput.select();
}

function findNext() {
  const query = elements.findInput.value;
  if (!query) return;
  const text = elements.editor.value.toLowerCase();
  const normalized = query.toLowerCase();
  let index = text.indexOf(normalized, elements.editor.selectionEnd);
  if (index === -1) index = text.indexOf(normalized);
  if (index === -1) {
    setStatus("未找到匹配内容");
    return;
  }
  setView("editor");
  elements.editor.focus();
  elements.editor.setSelectionRange(index, index + query.length);
  updateCursorStatus();
}

function handleCommand(command) {
  const actions = {
    new: newDocument,
    "open-file": openFile,
    "open-folder": openFolder,
    save: () => saveDocument(false),
    "save-as": () => saveDocument(true),
    find: showFind,
    "view-editor": () => setView("editor"),
    "view-split": () => setView("split"),
    "view-preview": () => setView("preview"),
  };
  actions[command]?.();
}

elements.editor.addEventListener("input", handleEditorInput);
elements.editor.addEventListener("click", updateCursorStatus);
elements.editor.addEventListener("keyup", updateCursorStatus);
elements.editor.addEventListener("keydown", (event) => {
  if (event.key === "Tab") {
    event.preventDefault();
    elements.editor.setRangeText("  ", elements.editor.selectionStart, elements.editor.selectionEnd, "end");
    handleEditorInput();
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
    event.preventDefault();
    formatSelection("bold");
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "i") {
    event.preventDefault();
    formatSelection("italic");
  }
});

elements.preview.addEventListener("click", (event) => {
  const link = event.target.closest("a[href]");
  if (!link) return;
  const href = link.getAttribute("href");
  if (href?.startsWith("#")) return;
  event.preventDefault();
  if (/^(?:https?:|mailto:)/i.test(href)) api.openExternal(link.href).catch(reportError);
  else setStatus("暂不支持从预览中打开本地链接。", 3500);
});

document.querySelector("#new-button").addEventListener("click", newDocument);
document.querySelector("#open-button").addEventListener("click", openFile);
document.querySelector("#save-button").addEventListener("click", () => saveDocument(false));
document.querySelector("#folder-button").addEventListener("click", openFolder);
document.querySelector("#theme-button").addEventListener("click", cycleTheme);
document.querySelector("#undo-button").addEventListener("mousedown", (event) => event.preventDefault());
document.querySelector("#redo-button").addEventListener("mousedown", (event) => event.preventDefault());
document.querySelector("#undo-button").addEventListener("click", () => runHistoryCommand("undo"));
document.querySelector("#redo-button").addEventListener("click", () => runHistoryCommand("redo"));
document.querySelector("#find-next").addEventListener("click", findNext);
document.querySelector("#find-close").addEventListener("click", () => {
  elements.findPanel.hidden = true;
  elements.editor.focus();
});
elements.findInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") findNext();
  if (event.key === "Escape") elements.findPanel.hidden = true;
});
elements.fileFilter.addEventListener("input", renderTree);
elements.autosave.addEventListener("change", () => {
  state.autosave = elements.autosave.checked;
  localStorage.setItem("cleanmark.autosave", String(state.autosave));
  if (state.autosave) scheduleAutosave();
});
document.querySelectorAll("[data-format]").forEach((button) => {
  button.addEventListener("click", () => formatSelection(button.dataset.format));
});
document.querySelectorAll("[data-view-mode]").forEach((button) => {
  button.addEventListener("click", () => setView(button.dataset.viewMode));
});

document.addEventListener("dragover", (event) => event.preventDefault());
document.addEventListener("drop", async (event) => {
  event.preventDefault();
  const file = event.dataTransfer.files[0];
  if (!file || !(await confirmDiscard())) return;
  try {
    const filePath = api.pathForDroppedFile(file);
    if (filePath) loadDocument(await api.readFile(filePath));
  } catch (error) {
    reportError(error);
  }
});

api.onCommand(handleCommand);
api.onSaveBeforeClose(async () => api.finishClose(await saveDocument(false)));
api.onE2eRun(async ({ directory }) => {
  const result = { passed: false, assertions: {}, errors: [] };
  const fixturePath = `${directory}\\01-完整语法.md`;
  const savedAsPath = `${directory}\\02-另存为.md`;
  const autosavePath = `${directory}\\03-自动保存.md`;
  const racePath = `${directory}\\04-保存竞态.md`;

  const assert = (name, condition, detail) => {
    result.assertions[name] = Boolean(condition);
    if (!condition) result.errors.push(`${name}: ${detail}`);
  };

  try {
    loadDocument(await api.readFile(fixturePath));
    assert("打开真实文件", state.filePath === fixturePath, state.filePath);
    assert("中文标题", elements.title.textContent === "01-完整语法.md", elements.title.textContent);
    assert("一级标题渲染", elements.preview.querySelector("h1")?.textContent === "清墨完整流程测试", elements.preview.innerHTML);
    assert("粗体渲染", elements.preview.querySelector("strong")?.textContent === "粗体", "缺少 strong");
    assert("斜体渲染", elements.preview.querySelector("em")?.textContent === "斜体", "缺少 em");
    assert("任务列表渲染", elements.preview.querySelectorAll('input[type="checkbox"]').length === 2, "任务列表数量错误");
    assert("表格渲染", elements.preview.querySelectorAll("table tbody tr").length === 2, "表格行数错误");
    assert("代码高亮", Boolean(elements.preview.querySelector("pre code.hljs")), "代码块未高亮");
    assert("相对图片解析", elements.preview.querySelector("img")?.src.includes("assets/test-image.svg"), elements.preview.querySelector("img")?.src);
    assert("危险脚本清洗", !elements.preview.querySelector("script") && !window.__e2eUnsafe, "script 未清洗");
    const anchor = [...elements.preview.querySelectorAll('a[href^="#"]')].find(
      (link) => decodeURIComponent(link.getAttribute("href")) === "#章节二",
    );
    assert("锚点保留", Boolean(anchor && elements.preview.querySelector("#章节二")), anchor?.getAttribute("href"));

    elements.editor.value += "\n\n## 编辑后保存\n\n这是实际写入磁盘的中文内容。";
    handleEditorInput();
    assert("编辑后脏状态", state.dirty, "编辑后未标脏");
    assert("覆盖保存", await saveDocument(false), "保存返回失败");
    const overwritten = await api.readFile(fixturePath);
    assert("覆盖保存落盘", overwritten.content.includes("这是实际写入磁盘的中文内容。"), "磁盘内容未更新");
    assert("保存后清脏", !state.dirty, "保存后仍为脏状态");

    const saveAsResult = await api.saveFile(savedAsPath, `${elements.editor.value}\n\n另存为流程通过。`);
    loadDocument(await api.readFile(saveAsResult.filePath));
    assert("另存为落盘", state.filePath === savedAsPath && elements.editor.value.includes("另存为流程通过。"), state.filePath);

    loadDocument(await api.readFile(fixturePath));
    assert("重新打开一致", elements.editor.value === overwritten.content, "重开内容不一致");

    state.folder = await api.scanFolderForTest(directory);
    elements.folderName.textContent = state.folder.name;
    renderTree();
    assert("目录树列出文件", elements.fileTree.querySelectorAll(".tree-file").length >= 4, "目录树文件不足");
    elements.fileFilter.value = "另存为";
    renderTree();
    assert("目录筛选", elements.fileTree.querySelectorAll(".tree-file").length === 1, "筛选结果错误");
    elements.fileFilter.value = "";

    loadDocument(await api.readFile(autosavePath));
    state.autosave = true;
    elements.autosave.checked = true;
    elements.editor.value += "\n自动保存实际写入。";
    handleEditorInput();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const autosaved = await api.readFile(autosavePath);
    assert("自动保存落盘", autosaved.content.includes("自动保存实际写入。") && !state.dirty, "自动保存失败");

    loadDocument(await api.readFile(racePath));
    elements.editor.value += "\n第一次保存";
    handleEditorInput();
    const delayedSave = saveDocument(false);
    elements.editor.value += "\n保存期间继续输入";
    handleEditorInput();
    await delayedSave;
    assert("保存竞态保留脏状态", state.dirty, "保存期间输入被错误标记为已保存");
    await saveDocument(false);
    const raceSaved = await api.readFile(racePath);
    assert("保存竞态最终落盘", raceSaved.content.includes("保存期间继续输入"), "最终内容未落盘");

    elements.editor.focus();
    elements.editor.setSelectionRange(elements.editor.value.length, elements.editor.value.length);
    document.execCommand("insertText", false, "\n撤销重做测试");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert("编辑历史产生", elements.editor.value.includes("撤销重做测试") && state.dirty, "没有产生可撤销编辑");
    document.querySelector("#undo-button").click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert("撤销前一步", !elements.editor.value.includes("撤销重做测试") && !state.dirty, "撤销失败或脏状态错误");
    document.querySelector("#redo-button").click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert("重做后一步", elements.editor.value.includes("撤销重做测试") && state.dirty, "重做失败或脏状态错误");
    document.querySelector("#undo-button").click();
    await new Promise((resolve) => setTimeout(resolve, 50));

    elements.editor.value = "格式测试 查找目标\n第二行";
    elements.editor.setSelectionRange(0, 4);
    formatSelection("bold");
    assert("粗体工具栏", elements.editor.value.startsWith("**格式测试**"), elements.editor.value);
    elements.findInput.value = "查找目标";
    findNext();
    assert("文档查找", elements.editor.value.slice(elements.editor.selectionStart, elements.editor.selectionEnd) === "查找目标", "查找选区错误");
    elements.editor.setSelectionRange(elements.editor.value.length, elements.editor.value.length);
    updateCursorStatus();
    assert("光标统计", elements.cursorStatus.textContent.includes("第 2 行"), elements.cursorStatus.textContent);
    renderMarkdown();
    assert("字词统计", Number.parseInt(elements.wordCount.textContent, 10) > 0, elements.wordCount.textContent);

    setView("editor");
    assert("编辑视图", elements.app.dataset.view === "editor" && getComputedStyle(document.querySelector(".preview-pane")).display === "none", "编辑视图错误");
    setView("preview");
    assert("预览视图", elements.app.dataset.view === "preview" && getComputedStyle(document.querySelector(".editor-pane")).display === "none", "预览视图错误");
    setView("split");
    assert("分屏视图", elements.app.dataset.view === "split", "分屏视图错误");

    const originalTheme = state.theme;
    cycleTheme();
    assert("主题切换", state.theme !== originalTheme, "主题未切换");

    result.passed = result.errors.length === 0;
  } catch (error) {
    result.errors.push(error?.stack || String(error));
  }
  api.reportE2e(result);
});

elements.editor.value = welcomeDocument;
elements.autosave.checked = state.autosave;
setView(state.view);
applyTheme();
updateTitle();
renderMarkdown();
updateCursorStatus();
setDirty(false);
