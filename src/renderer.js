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
  encodingStatus: document.querySelector("#encoding-status"),
  conversionDialog: document.querySelector("#conversion-dialog"),
  conversionSourceEditor: document.querySelector("#conversion-source-editor"),
  conversionSourceFile: document.querySelector("#conversion-source-file"),
  conversionCurrentDetail: document.querySelector("#conversion-current-detail"),
  conversionFileRow: document.querySelector("#conversion-file-row"),
  conversionInputPath: document.querySelector("#conversion-input-path"),
  conversionSourceNotice: document.querySelector("#conversion-source-notice"),
  conversionTarget: document.querySelector("#conversion-target"),
  conversionRemoteRow: document.querySelector("#conversion-remote-row"),
  conversionRemoteImages: document.querySelector("#conversion-remote-images"),
  conversionOcrRow: document.querySelector("#conversion-ocr-row"),
  conversionOcr: document.querySelector("#conversion-ocr"),
  conversionOcrLanguages: document.querySelector("#conversion-ocr-languages"),
  conversionOcrChiSim: document.querySelector("#conversion-ocr-chi-sim"),
  conversionOcrEng: document.querySelector("#conversion-ocr-eng"),
  conversionOcrChiSimStatus: document.querySelector("#conversion-ocr-chi-sim-status"),
  conversionOcrEngStatus: document.querySelector("#conversion-ocr-eng-status"),
  conversionComponentProgress: document.querySelector("#conversion-component-progress"),
  conversionOutputPath: document.querySelector("#conversion-output-path"),
  conversionCapabilities: document.querySelector("#conversion-capabilities"),
  conversionProgressPanel: document.querySelector("#conversion-progress-panel"),
  conversionProgress: document.querySelector("#conversion-progress"),
  conversionProgressMessage: document.querySelector("#conversion-progress-message"),
  conversionProgressPercent: document.querySelector("#conversion-progress-percent"),
  conversionReport: document.querySelector("#conversion-report"),
  conversionReportTitle: document.querySelector("#conversion-report-title"),
  conversionReportSummary: document.querySelector("#conversion-report-summary"),
  conversionReportBadge: document.querySelector("#conversion-report-badge"),
  conversionReportWarnings: document.querySelector("#conversion-report-warnings"),
  conversionResultActions: document.querySelector("#conversion-result-actions"),
  conversionOpenMarkdown: document.querySelector("#conversion-open-markdown"),
  conversionValidation: document.querySelector("#conversion-validation"),
  conversionStart: document.querySelector("#conversion-start"),
  conversionCancel: document.querySelector("#conversion-cancel"),
  conversionClose: document.querySelector("#conversion-close"),
  conversionCloseIcon: document.querySelector("#conversion-close-icon"),
};

const state = {
  filePath: null,
  fileUrl: null,
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
  fingerprint: null,
  encoding: "utf8",
  encodingUncertain: false,
  encodingConfirmed: true,
  bom: false,
  eol: "lf",
  recoveryTimer: null,
};
let saveQueue = Promise.resolve();
const conversionState = {
  capabilities: null,
  inputPath: null,
  outputPath: null,
  jobId: null,
  running: false,
  result: null,
  downloadingLanguage: null,
};

const welcomeDocument = `# 欢迎使用清墨

清墨是一款从零独立开发的轻量 Markdown 编辑器。

## 开始写作

- 使用 **Ctrl+O** 打开 Markdown 文件。
- 打开文件夹后，可在侧边栏浏览文档。
- 可在编辑、分屏和预览模式之间切换。
- 可在左下角启用自动保存。

> 本项目使用沙箱化的 Electron 渲染进程和受限文件系统桥接。

## 支持清墨

如果清墨对你有帮助，欢迎访问 [GitHub 项目仓库](https://github.com/ZuoXing-0504/MarkDown-Free) 并点亮 Star，感谢你的支持。

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
  const sanitized = DOMPurify.sanitize(rendered, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ["target", "rel"],
    FORBID_ATTR: ["style", "srcset", "poster", "background"],
    FORBID_TAGS: ["style", "link", "source", "picture", "video", "audio"],
  });
  const template = document.createElement("template");
  template.innerHTML = sanitized;
  template.content.querySelectorAll('img[src]').forEach((image) => {
    const source = image.getAttribute("src");
    if (!source) return;
    const remoteSource = /^https?:\/\//i.test(source) ? source : source.startsWith("//") ? `https:${source}` : null;
    if (remoteSource) {
      const button = document.createElement("button");
      button.className = "remote-image-button";
      button.type = "button";
      button.dataset.remoteImage = remoteSource;
      button.dataset.remoteAlt = image.getAttribute("alt") || "远程图片";
      button.textContent = "远程图片已阻止，点击后安全加载";
      image.replaceWith(button);
      return;
    }
    if (/^data:image\/(?:png|jpeg|gif|webp|avif);/i.test(source)) return;
    if (/^(?:[a-z][a-z0-9+.-]*:|#|\\\\|\/)/i.test(source)) {
      const blocked = document.createElement("span");
      blocked.className = "blocked-image-label";
      blocked.textContent = "已阻止不安全的图片地址";
      image.replaceWith(blocked);
      return;
    }
    if (state.fileUrl) image.setAttribute("src", new URL(source.replaceAll("\\", "/"), state.fileUrl).href);
    else image.removeAttribute("src");
  });
  elements.preview.replaceChildren(template.content);
  addHeadingAnchors();
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

function scheduleRecovery() {
  if (state.recoveryTimer) window.clearTimeout(state.recoveryTimer);
  if (!state.dirty) return;
  const documentToken = state.documentToken;
  state.recoveryTimer = window.setTimeout(() => {
    if (documentToken !== state.documentToken || !state.dirty) return;
    api.writeRecovery({
      filePath: state.filePath,
      fileUrl: state.fileUrl,
      content: elements.editor.value,
      encoding: state.encoding,
      encodingUncertain: state.encodingUncertain,
      bom: state.bom,
      eol: state.eol,
      fingerprint: state.fingerprint,
    }).catch(reportError);
  }, 500);
}

function handleEditorInput() {
  state.revision += 1;
  setDirty(elements.editor.value !== state.savedContent);
  scheduleRender();
  scheduleAutosave();
  scheduleRecovery();
}

function resetDocumentState() {
  if (state.autosaveTimer) window.clearTimeout(state.autosaveTimer);
  state.autosaveTimer = null;
  state.documentToken += 1;
  state.revision = 0;
  if (state.recoveryTimer) window.clearTimeout(state.recoveryTimer);
  state.recoveryTimer = null;
}

async function confirmDiscard() {
  if (!state.dirty) return true;
  if (!window.confirm("放弃当前文档中尚未保存的更改吗？")) return false;
  return true;
}

function loadDocument(result) {
  resetDocumentState();
  state.filePath = result.filePath;
  state.fileUrl = result.fileUrl || null;
  elements.editor.value = result.content;
  state.savedContent = result.content;
  state.fingerprint = result.fingerprint || null;
  state.encoding = result.encoding || "utf8";
  state.encodingUncertain = Boolean(result.encodingUncertain);
  state.encodingConfirmed = !state.encodingUncertain;
  state.bom = Boolean(result.bom);
  state.eol = result.eol || "lf";
  const encodingNames = { utf8: "UTF-8", utf16le: "UTF-16 LE", utf16be: "UTF-16 BE", gb18030: "GB18030" };
  elements.encodingStatus.textContent = `${encodingNames[state.encoding] || state.encoding}${state.encodingUncertain ? "（推测）" : ""} · ${state.eol.toUpperCase()}`;
  setDirty(false);
  updateTitle();
  renderMarkdown();
  updateCursorStatus();
  highlightActiveFile();
  elements.editor.focus();
  setStatus(`已打开 ${baseName(result.filePath)}`);
}

async function newDocument() {
  const clearRecovery = state.dirty;
  if (!(await confirmDiscard())) return;
  resetDocumentState();
  state.filePath = null;
  state.fileUrl = null;
  elements.editor.value = "";
  state.savedContent = "";
  state.fingerprint = null;
  state.encoding = "utf8";
  state.encodingUncertain = false;
  state.encodingConfirmed = true;
  state.bom = false;
  state.eol = "lf";
  elements.encodingStatus.textContent = "UTF-8 · LF";
  setDirty(false);
  if (clearRecovery) await api.clearRecovery();
  updateTitle();
  renderMarkdown();
  highlightActiveFile();
  elements.editor.focus();
  setStatus("已新建文档");
}

async function replaceDocumentAfterDiscard(readDocument) {
  const clearRecovery = state.dirty;
  if (!(await confirmDiscard())) return;
  try {
    const result = await readDocument();
    if (result) {
      loadDocument(result);
      if (clearRecovery) await api.clearRecovery();
    }
  } catch (error) {
    reportError(error);
  }
}

async function openFile() {
  await replaceDocumentAfterDiscard(() => api.openFile());
}

async function openPath(filePath) {
  if (filePath === state.filePath) return;
  await replaceDocumentAfterDiscard(() => api.readFile(filePath));
}

function saveDocument(saveAs = false) {
  const request = {
    saveAs,
    documentToken: state.documentToken,
    content: elements.editor.value,
    originalPath: state.filePath,
    encoding: state.encoding,
    encodingUncertain: state.encodingUncertain,
    bom: state.bom,
    eol: state.eol,
  };
  const result = saveQueue.then(() => performSaveDocument(request));
  saveQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function performSaveDocument(request) {
  if (request.documentToken !== state.documentToken) return false;
  if (request.encodingUncertain && !state.encodingConfirmed) {
    const confirmed = window.confirm(
      "当前文件编码只能推测为 GB18030。若原文件实际使用其他编码，保存可能改变内容。是否继续保存？",
    );
    if (!confirmed) {
      setStatus("已取消保存；请先确认文件编码。", 4500);
      return false;
    }
    state.encodingConfirmed = true;
  }
  try {
    const options = {
      encoding: request.saveAs ? "utf8" : request.encoding,
      bom: request.saveAs ? false : request.bom,
      eol: request.saveAs ? "lf" : request.eol,
    };
    if (!request.saveAs && request.originalPath) options.expectedFingerprint = state.fingerprint;
    let result = await api.saveFile(request.saveAs ? null : request.originalPath, request.content, options);
    if (!result) return false;
    while (result.conflict) {
      const overwrite = window.confirm(
        result.missing
          ? "该文件已被其他程序删除。是否重新创建并覆盖保存？"
          : "该文件已被其他程序修改。继续会覆盖外部更改，是否仍要保存？",
      );
      if (!overwrite) {
        setStatus("已取消保存，外部更改未被覆盖。", 4500);
        return false;
      }
      result = await api.saveFile(request.saveAs ? null : request.originalPath, request.content, {
        ...options,
        expectedFingerprint: result.currentFingerprint ?? null,
      });
      if (!result) return false;
    }
    if (request.documentToken !== state.documentToken) return false;
    state.filePath = result.filePath;
    state.fileUrl = result.fileUrl || null;
    state.savedContent = request.content;
    state.fingerprint = result.fingerprint;
    state.encoding = result.encoding;
    state.encodingUncertain = false;
    state.encodingConfirmed = true;
    state.bom = result.bom;
    state.eol = result.eol;
    setDirty(elements.editor.value !== state.savedContent);
    if (!state.dirty) await api.clearRecovery();
    updateTitle();
    highlightActiveFile();
    setStatus(state.dirty ? `已保存 ${baseName(result.filePath)}，仍有未保存更改` : `已保存 ${baseName(result.filePath)}`);
    return !state.dirty;
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

function conversionSourceKind() {
  return elements.conversionSourceFile.checked ? "file" : "editor";
}

function conversionMode() {
  return document.querySelector('input[name="conversion-mode"]:checked')?.value === "visual" ? "visual" : "editable";
}

function conversionExtensionType(filePath) {
  const extension = (filePath?.match(/\.([^.\\/]+)$/)?.[1] || "").toLowerCase();
  if (["md", "markdown"].includes(extension)) return "md";
  if (["doc", "docx", "pdf", "ppt", "pptx"].includes(extension)) return extension;
  return null;
}

function normalizedConversionSourceType() {
  const type = conversionSourceKind() === "editor" ? "md" : conversionExtensionType(conversionState.inputPath);
  if (type === "doc") return "docx";
  if (type === "ppt") return "pptx";
  return type;
}

function conversionBaseName(filePath) {
  return baseName(filePath).replace(/\.(?:markdown|md|docx?|pdf|pptx?)$/i, "") || "转换结果";
}

function unresolvedRelativeImages(markdown) {
  const matches = [];
  for (const match of String(markdown || "").matchAll(/!\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g)) {
    const source = match[1];
    if (!/^(?:data:|https?:|\/\/|file:|#|[a-zA-Z]:[\\/]|[\\/])/i.test(source)) matches.push(source);
  }
  return [...new Set(matches)].slice(0, 8);
}

function selectedOcrLanguages() {
  return [
    elements.conversionOcrChiSim.checked ? "chi_sim" : null,
    elements.conversionOcrEng.checked ? "eng" : null,
  ].filter(Boolean);
}

function ocrLanguageReady(language) {
  return Boolean(conversionState.capabilities?.ocr?.[language]?.valid);
}

function setConversionSourceNotice() {
  let message = "";
  const sourceType = conversionExtensionType(conversionState.inputPath);
  if (conversionSourceKind() === "editor" && !state.filePath) {
    const images = unresolvedRelativeImages(elements.editor.value);
    if (images.length) message = `未命名文档含有无法确定基准目录的相对图片：${images.join("、")}`;
  } else if (["doc", "ppt"].includes(sourceType)) {
    const capabilities = conversionState.capabilities?.capabilities;
    const officeAvailable = sourceType === "doc"
      ? capabilities?.office?.word?.available
      : capabilities?.office?.powerPoint?.available;
    if (!officeAvailable && !capabilities?.libreOffice?.available) {
      message = `旧版 .${sourceType} 文件需要 Microsoft Office 或 LibreOffice 才能读取。`;
    }
  }
  elements.conversionSourceNotice.textContent = message;
  elements.conversionSourceNotice.hidden = !message;
}

function updateOcrLanguageStatus() {
  for (const [language, statusElement] of [
    ["chi_sim", elements.conversionOcrChiSimStatus],
    ["eng", elements.conversionOcrEngStatus],
  ]) {
    const status = conversionState.capabilities?.ocr?.[language];
    statusElement.textContent = status?.valid ? "已安装并校验" : status?.installed ? "校验失败，需重新下载" : "未安装";
    statusElement.className = `component-status ${status?.valid ? "available" : "unavailable"}`;
    const button = document.querySelector(`[data-ocr-download="${language}"]`);
    button.hidden = Boolean(status?.valid);
    button.textContent = status?.installed ? "重新下载" : "下载语言包";
    button.disabled = conversionState.downloadingLanguage !== null;
  }
}

function capabilityItem(name, description, available, component = null) {
  const item = document.createElement("div");
  item.className = "capability-item";
  const label = document.createElement("span");
  label.textContent = name;
  const value = document.createElement("span");
  value.className = `component-status ${available ? "available" : "unavailable"}`;
  value.textContent = description;
  item.append(label, value);
  if (!available && component) {
    const button = document.createElement("button");
    button.className = "text-action";
    button.type = "button";
    button.dataset.component = component;
    button.textContent = "官方下载";
    item.append(button);
  }
  return item;
}

function renderConversionCapabilities() {
  const capabilities = conversionState.capabilities?.capabilities;
  if (!capabilities) {
    elements.conversionCapabilities.replaceChildren(capabilityItem("转换组件", "检测失败，可使用内置转换器", false));
    updateOcrLanguageStatus();
    return;
  }
  const officeParts = [];
  if (capabilities.office.word.available) officeParts.push("Word");
  if (capabilities.office.powerPoint.available) officeParts.push("PowerPoint");
  elements.conversionCapabilities.replaceChildren(
    capabilityItem("Microsoft Office", officeParts.length ? `${officeParts.join("、")} 可用` : "未检测到", officeParts.length > 0, "office"),
    capabilityItem("LibreOffice", capabilities.libreOffice.available ? capabilities.libreOffice.version || "可用" : "未安装", capabilities.libreOffice.available, "libreOffice"),
    capabilityItem("Pandoc", capabilities.pandoc.available ? capabilities.pandoc.version || "可用" : "未安装", capabilities.pandoc.available, "pandoc"),
    capabilityItem("清墨内置转换器", "可用", true),
  );
  updateOcrLanguageStatus();
}

async function refreshConversionCapabilities(force = true) {
  if (!force && conversionState.capabilities) {
    renderConversionCapabilities();
    return;
  }
  elements.conversionCapabilities.replaceChildren(capabilityItem("转换组件", "正在检测…", false));
  try {
    conversionState.capabilities = await api.getConversionCapabilities();
    renderConversionCapabilities();
  } catch (error) {
    conversionState.capabilities = null;
    renderConversionCapabilities();
    elements.conversionValidation.textContent = `转换能力检测失败：${error.message}`;
  }
  updateConversionOptions(false);
}

function ensureAvailableTarget() {
  const sourceType = normalizedConversionSourceType();
  for (const option of elements.conversionTarget.options) option.disabled = Boolean(sourceType && option.value === sourceType);
  if (elements.conversionTarget.selectedOptions[0]?.disabled) {
    const next = [...elements.conversionTarget.options].find((option) => !option.disabled);
    if (next) elements.conversionTarget.value = next.value;
  }
}

function updateConversionOptions(resetOutput = true) {
  const fileSource = conversionSourceKind() === "file";
  elements.conversionFileRow.hidden = !fileSource;
  elements.conversionCurrentDetail.textContent = state.filePath
    ? `${baseName(state.filePath)}${state.dirty ? "（含未保存更改）" : ""}`
    : `未命名文档${state.dirty ? "（含未保存更改）" : ""}`;
  ensureAvailableTarget();
  const sourceType = normalizedConversionSourceType();
  elements.conversionRemoteRow.hidden = sourceType !== "md";
  const ocrApplicable = sourceType === "pdf" && conversionMode() === "editable";
  elements.conversionOcrRow.hidden = !ocrApplicable;
  if (!ocrApplicable) elements.conversionOcr.checked = false;
  elements.conversionOcrLanguages.hidden = !elements.conversionOcr.checked || !ocrApplicable;
  if (resetOutput) {
    conversionState.outputPath = null;
    elements.conversionOutputPath.value = "";
  }
  setConversionSourceNotice();
  validateConversion();
}

function conversionValidationMessage() {
  const sourceType = normalizedConversionSourceType();
  if (conversionSourceKind() === "file" && !conversionState.inputPath) return "请选择要转换的外部文档。";
  if (conversionSourceKind() === "file" && !sourceType) return "不支持所选来源文件格式。";
  if (conversionSourceKind() === "editor" && new Blob([elements.editor.value]).size > 100 * 1024 * 1024) return "当前文档超过 100 MB 转换限制。";
  const originalType = conversionExtensionType(conversionState.inputPath);
  if (["doc", "ppt"].includes(originalType)) {
    const capabilities = conversionState.capabilities?.capabilities;
    const officeAvailable = originalType === "doc" ? capabilities?.office?.word?.available : capabilities?.office?.powerPoint?.available;
    if (!officeAvailable && !capabilities?.libreOffice?.available) return `读取 .${originalType} 文件需要安装 Microsoft Office 或 LibreOffice。`;
  }
  if (sourceType === elements.conversionTarget.value) return "来源和目标格式相同，无需转换。";
  if (!conversionState.outputPath) return "请选择转换结果保存位置。";
  if (elements.conversionOcr.checked) {
    const languages = selectedOcrLanguages();
    if (!languages.length) return "请至少选择一种 OCR 语言。";
    const missing = languages.filter((language) => !ocrLanguageReady(language));
    if (missing.length) return "请先下载并校验所选 OCR 语言包。";
  }
  return "";
}

function validateConversion() {
  const message = conversionValidationMessage();
  elements.conversionValidation.textContent = message;
  elements.conversionStart.disabled = Boolean(message) || conversionState.running;
  return !message;
}

async function chooseConversionInput() {
  try {
    const filePath = await api.chooseConversionInput();
    if (!filePath) return;
    conversionState.inputPath = filePath;
    elements.conversionInputPath.value = filePath;
    elements.conversionSourceFile.checked = true;
    updateConversionOptions(true);
  } catch (error) {
    elements.conversionValidation.textContent = error.message || "选择来源文件失败。";
  }
}

async function chooseConversionOutput() {
  try {
    const sourcePath = conversionSourceKind() === "file" ? conversionState.inputPath : state.filePath;
    const outputPath = await api.chooseConversionOutput(elements.conversionTarget.value, `${conversionBaseName(sourcePath)}-转换`);
    if (!outputPath) return;
    conversionState.outputPath = outputPath;
    elements.conversionOutputPath.value = outputPath;
    validateConversion();
  } catch (error) {
    elements.conversionValidation.textContent = error.message || "选择保存位置失败。";
  }
}

function resetConversionProgress() {
  elements.conversionProgressPanel.hidden = true;
  elements.conversionProgress.value = 0;
  elements.conversionProgressMessage.textContent = "准备转换…";
  elements.conversionProgressPercent.textContent = "0%";
  document.querySelectorAll("#conversion-progress-stages span").forEach((stage) => stage.classList.remove("active", "complete"));
}

function resetConversionReport() {
  conversionState.result = null;
  elements.conversionReport.hidden = true;
  elements.conversionReport.classList.remove("success", "error");
  elements.conversionReportWarnings.hidden = true;
  elements.conversionReportWarnings.replaceChildren();
  elements.conversionResultActions.hidden = true;
}

function setConversionBusy(running) {
  conversionState.running = running;
  for (const control of elements.conversionDialog.querySelectorAll("input, select, button")) control.disabled = running;
  elements.conversionCancel.hidden = !running;
  elements.conversionCancel.disabled = !running;
  elements.conversionClose.hidden = running;
  elements.conversionStart.hidden = running;
  if (!running) {
    for (const control of elements.conversionDialog.querySelectorAll("input, select, button")) control.disabled = false;
    elements.conversionClose.hidden = false;
    elements.conversionStart.hidden = false;
    elements.conversionClose.disabled = false;
    elements.conversionCloseIcon.disabled = false;
    document.querySelectorAll("[data-ocr-download]").forEach((button) => { button.disabled = false; });
    validateConversion();
  }
}

function canonicalProgressStage(stage) {
  if (["render", "external"].includes(stage)) return stage === "render" ? "extract" : "generate";
  if (stage === "done") return "cleanup";
  return stage;
}

function normalizedProgress(payload) {
  if (payload.stage === "done") return 1;
  if (typeof payload.progress === "number") {
    if (payload.stage === "ocr") return 0.35 + payload.progress * 0.38;
    return Math.max(0, Math.min(1, payload.progress));
  }
  const ratio = payload.total ? Math.max(0, Math.min(1, Number(payload.current || 0) / payload.total)) : 0;
  return ({
    analyze: 0.03,
    extract: 0.1 + ratio * 0.38,
    render: 0.12 + ratio * 0.58,
    external: 0.55,
    generate: 0.78,
    save: 0.94,
    cleanup: 0.98,
  })[payload.stage] ?? elements.conversionProgress.value;
}

function updateConversionProgress(payload) {
  if (!conversionState.running || payload.jobId !== conversionState.jobId) return;
  elements.conversionProgressPanel.hidden = false;
  const value = normalizedProgress(payload);
  elements.conversionProgress.value = value;
  elements.conversionProgressMessage.textContent = payload.message || "正在转换…";
  elements.conversionProgressPercent.textContent = `${Math.round(value * 100)}%`;
  const stages = ["analyze", "extract", "ocr", "generate", "save", "cleanup"];
  const current = canonicalProgressStage(payload.stage);
  const currentIndex = stages.indexOf(current);
  document.querySelectorAll("#conversion-progress-stages span").forEach((element) => {
    const index = stages.indexOf(element.dataset.stage);
    element.classList.toggle("active", index === currentIndex);
    element.classList.toggle("complete", currentIndex >= 0 && index < currentIndex);
  });
}

function showConversionReport({ result = null, error = null, canceled = false }) {
  elements.conversionReport.hidden = false;
  elements.conversionReport.classList.toggle("success", Boolean(result));
  elements.conversionReport.classList.toggle("error", !result);
  elements.conversionReportTitle.textContent = result ? "转换完成" : canceled ? "转换已取消" : "转换失败";
  elements.conversionReportBadge.textContent = result ? "完成" : canceled ? "已取消" : "失败";
  if (result) {
    elements.conversionProgress.value = 1;
    elements.conversionProgressPercent.textContent = "100%";
    elements.conversionProgressMessage.textContent = "转换完成。";
    document.querySelectorAll("#conversion-progress-stages span").forEach((stage) => {
      stage.classList.remove("active");
      stage.classList.add("complete");
    });
    const seconds = (result.durationMs / 1000).toFixed(result.durationMs >= 10_000 ? 0 : 1);
    elements.conversionReportSummary.textContent = `已通过 ${result.engine} 生成 ${baseName(result.outputPath)}，耗时 ${seconds} 秒。`;
    conversionState.result = result;
    const warnings = result.warnings || [];
    if (warnings.length) {
      const title = document.createElement("strong");
      title.textContent = `转换报告：${warnings.length} 项降级或提示`;
      const list = document.createElement("ul");
      for (const warning of warnings) {
        const item = document.createElement("li");
        item.textContent = warning;
        list.append(item);
      }
      elements.conversionReportWarnings.replaceChildren(title, list);
      elements.conversionReportWarnings.hidden = false;
    }
    elements.conversionResultActions.hidden = false;
    elements.conversionOpenMarkdown.hidden = elements.conversionTarget.value !== "md";
  } else {
    elements.conversionReportSummary.textContent = canceled ? "来源文件未修改，临时文件已清理。" : error?.message || "转换过程中发生未知错误。";
    elements.conversionResultActions.hidden = true;
  }
}

async function startConversion() {
  if (!validateConversion()) return;
  if (conversionSourceKind() === "editor" && !state.filePath) {
    const images = unresolvedRelativeImages(elements.editor.value);
    if (images.length && !window.confirm(`未命名文档中的以下相对图片无法解析：\n\n${images.join("\n")}\n\n是否继续转换并在报告中保留缺失提示？`)) return;
  }
  resetConversionReport();
  resetConversionProgress();
  conversionState.jobId = window.crypto.randomUUID();
  elements.conversionProgressPanel.hidden = false;
  setConversionBusy(true);
  const request = {
    jobId: conversionState.jobId,
    source: conversionSourceKind() === "editor"
      ? { kind: "editor", content: elements.editor.value, filePath: state.filePath }
      : { kind: "file", filePath: conversionState.inputPath },
    target: elements.conversionTarget.value,
    mode: conversionMode(),
    outputPath: conversionState.outputPath,
    options: {
      includeRemoteImages: elements.conversionRemoteImages.checked,
      ocr: elements.conversionOcr.checked,
      ocrLanguages: selectedOcrLanguages(),
    },
  };
  try {
    const result = await api.startConversion(request);
    if (result?.canceled) showConversionReport({ canceled: true });
    else showConversionReport({ result });
  } catch (error) {
    const canceled = /取消/.test(error?.message || "");
    showConversionReport({ error, canceled });
  } finally {
    conversionState.jobId = null;
    setConversionBusy(false);
  }
}

async function cancelConversion() {
  if (!conversionState.running || !conversionState.jobId) return;
  elements.conversionCancel.disabled = true;
  elements.conversionProgressMessage.textContent = "正在取消并清理临时文件…";
  try {
    await api.cancelConversion(conversionState.jobId);
  } catch (error) {
    elements.conversionProgressMessage.textContent = error.message || "取消转换失败。";
  }
}

async function downloadOcrLanguage(language) {
  if (conversionState.downloadingLanguage) return;
  conversionState.downloadingLanguage = language;
  elements.conversionComponentProgress.hidden = false;
  elements.conversionComponentProgress.textContent = `正在下载 ${language === "chi_sim" ? "简体中文" : "English"} OCR 语言包…`;
  updateOcrLanguageStatus();
  try {
    const result = await api.downloadOcrLanguage(language);
    if (conversionState.capabilities) conversionState.capabilities.ocr = result.status;
    elements.conversionComponentProgress.textContent = "语言包已下载，并通过 SHA-256 校验。";
  } catch (error) {
    elements.conversionComponentProgress.textContent = error.message || "OCR 语言包下载失败。";
  } finally {
    conversionState.downloadingLanguage = null;
    updateOcrLanguageStatus();
    validateConversion();
  }
}

function closeConversionCenter() {
  if (!conversionState.running && elements.conversionDialog.open) elements.conversionDialog.close();
}

async function openConversionCenter() {
  if (!elements.conversionDialog.open) elements.conversionDialog.showModal();
  if (conversionState.running) return;
  conversionState.inputPath = null;
  conversionState.outputPath = null;
  elements.conversionInputPath.value = "";
  elements.conversionOutputPath.value = "";
  elements.conversionSourceEditor.checked = true;
  elements.conversionTarget.value = "pdf";
  document.querySelector("#conversion-mode-editable").checked = true;
  elements.conversionRemoteImages.checked = false;
  elements.conversionOcr.checked = false;
  resetConversionProgress();
  resetConversionReport();
  updateConversionOptions(false);
  await refreshConversionCapabilities(false);
}

function handleCommand(command) {
  const actions = {
    new: newDocument,
    "open-file": openFile,
    "open-folder": openFolder,
    save: () => saveDocument(false),
    "save-as": () => saveDocument(true),
    convert: openConversionCenter,
    find: showFind,
    "view-editor": () => setView("editor"),
    "view-split": () => setView("split"),
    "view-preview": () => setView("preview"),
    reload: reloadWindow,
  };
  actions[command]?.();
}

async function reloadWindow() {
  const clearRecovery = state.dirty;
  if (!(await confirmDiscard())) return;
  try {
    if (clearRecovery) await api.clearRecovery();
    api.reload(state.filePath);
  } catch (error) {
    reportError(error);
  }
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
  const remoteImageButton = event.target.closest("[data-remote-image]");
  if (remoteImageButton) {
    remoteImageButton.disabled = true;
    remoteImageButton.textContent = "正在安全加载远程图片…";
    api.loadRemoteImage(remoteImageButton.dataset.remoteImage)
      .then(({ dataUrl }) => {
        if (!/^data:image\/(?:png|jpeg|gif|webp|avif);base64,/i.test(dataUrl || "")) {
          throw new Error("远程图片响应无效。");
        }
        const image = document.createElement("img");
        image.src = dataUrl;
        image.alt = remoteImageButton.dataset.remoteAlt || "远程图片";
        remoteImageButton.replaceWith(image);
      })
      .catch((error) => {
        remoteImageButton.disabled = false;
        remoteImageButton.textContent = "远程图片加载失败，点击重试";
        reportError(error);
      });
    return;
  }
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
document.querySelector("#convert-button").addEventListener("click", openConversionCenter);
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

elements.conversionSourceEditor.addEventListener("change", () => updateConversionOptions(true));
elements.conversionSourceFile.addEventListener("change", () => updateConversionOptions(true));
document.querySelector("#conversion-input-button").addEventListener("click", chooseConversionInput);
document.querySelector("#conversion-output-button").addEventListener("click", chooseConversionOutput);
elements.conversionTarget.addEventListener("change", () => updateConversionOptions(true));
document.querySelectorAll('input[name="conversion-mode"]').forEach((input) => input.addEventListener("change", () => updateConversionOptions(false)));
elements.conversionRemoteImages.addEventListener("change", validateConversion);
elements.conversionOcr.addEventListener("change", () => updateConversionOptions(false));
elements.conversionOcrChiSim.addEventListener("change", validateConversion);
elements.conversionOcrEng.addEventListener("change", validateConversion);
document.querySelectorAll("[data-ocr-download]").forEach((button) => {
  button.addEventListener("click", () => downloadOcrLanguage(button.dataset.ocrDownload));
});
document.querySelector("#conversion-refresh-capabilities").addEventListener("click", () => refreshConversionCapabilities(true));
elements.conversionCapabilities.addEventListener("click", (event) => {
  const button = event.target.closest("[data-component]");
  if (button) api.openConversionComponentPage(button.dataset.component).catch(reportError);
});
elements.conversionStart.addEventListener("click", startConversion);
elements.conversionCancel.addEventListener("click", cancelConversion);
elements.conversionClose.addEventListener("click", closeConversionCenter);
elements.conversionCloseIcon.addEventListener("click", closeConversionCenter);
elements.conversionDialog.addEventListener("cancel", (event) => {
  if (conversionState.running) event.preventDefault();
});
document.querySelector("#conversion-open-result").addEventListener("click", () => {
  if (conversionState.result?.outputPath) api.openConversionResult(conversionState.result.outputPath).catch(reportError);
});
document.querySelector("#conversion-show-result").addEventListener("click", () => {
  if (conversionState.result?.outputPath) api.showConversionResult(conversionState.result.outputPath).catch(reportError);
});
elements.conversionOpenMarkdown.addEventListener("click", async () => {
  if (!conversionState.result?.outputPath) return;
  await replaceDocumentAfterDiscard(() => api.readFile(conversionState.result.outputPath));
  closeConversionCenter();
});

document.addEventListener("dragover", (event) => event.preventDefault());
document.addEventListener("drop", async (event) => {
  event.preventDefault();
  const file = event.dataTransfer.files[0];
  if (!file) return;
  await replaceDocumentAfterDiscard(() => {
    const filePath = api.pathForDroppedFile(file);
    return filePath ? api.readFile(filePath) : null;
  });
});

api.onCommand(handleCommand);
api.onSaveBeforeClose(async () => api.finishClose(await saveDocument(false)));
api.onOpenPath((filePath) => openPath(filePath));
api.onConversionProgress(updateConversionProgress);
api.onConversionComponentProgress((progress) => {
  if (!conversionState.downloadingLanguage || progress.language !== conversionState.downloadingLanguage) return;
  const percent = progress.total ? Math.round((progress.downloaded / progress.total) * 100) : null;
  elements.conversionComponentProgress.hidden = false;
  elements.conversionComponentProgress.textContent = percent === null
    ? `已下载 ${(progress.downloaded / 1024 / 1024).toFixed(1)} MB…`
    : `正在下载并校验语言包：${percent}%`;
});
api.onE2eRun(async ({ directory }) => {
  const result = { passed: false, assertions: {}, errors: [] };
  const fixturePath = `${directory}\\01-完整语法.md`;
  const savedAsPath = `${directory}\\02-另存为.md`;
  const autosavePath = `${directory}\\03-自动保存.md`;
  const racePath = `${directory}\\04-保存竞态.md`;
  const conflictPath = `${directory}\\08-外部冲突.md`;
  const utf16Path = `${directory}\\06-UTF16LE-CRLF.md`;
  const gb18030Path = `${directory}\\07-GB18030.md`;
  const binaryPath = `${directory}\\09-二进制.bin`;

  const assert = (name, condition, detail) => {
    result.assertions[name] = Boolean(condition);
    if (!condition) result.errors.push(`${name}: ${detail}`);
  };
  const cancelPendingRecovery = () => {
    if (!state.recoveryTimer) return;
    window.clearTimeout(state.recoveryTimer);
    state.recoveryTimer = null;
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
    const highlightedToken = elements.preview.querySelector("pre code.hljs .hljs-keyword, pre code.hljs .hljs-string");
    assert("代码高亮", Boolean(highlightedToken) && getComputedStyle(highlightedToken).color !== getComputedStyle(elements.preview.querySelector("pre code")).color, "代码块缺少实际着色");
    assert("相对图片解析", elements.preview.querySelector("img")?.src.includes("assets/test-image.svg"), elements.preview.querySelector("img")?.src);
    assert("危险脚本清洗", !elements.preview.querySelector("script") && !window.__e2eUnsafe, "script 未清洗");
    const anchor = [...elements.preview.querySelectorAll('a[href^="#"]')].find(
      (link) => decodeURIComponent(link.getAttribute("href")) === "#章节二",
    );
    assert("锚点保留", Boolean(anchor && elements.preview.querySelector("#章节二")), anchor?.getAttribute("href"));
    elements.editor.value += "\n\n![远程](https://example.invalid/tracker.png)";
    renderMarkdown();
    assert("远程图片默认阻止", !elements.preview.querySelector('img[src^="https:"]') && Boolean(elements.preview.querySelector("[data-remote-image]")), "远程图片被静默加载");
    elements.editor.value = '<img src="data:image/png;base64,AA==" srcset="https://example.invalid/tracker.png 2x" style="background-image:url(https://example.invalid/css.png)"><picture><source srcset="https://example.invalid/source.png"><img src="//example.invalid/unc.png"></picture>';
    renderMarkdown();
    assert("远程资源旁路清理", !elements.preview.querySelector("[srcset], [style], source, picture") && elements.preview.querySelectorAll("[data-remote-image]").length === 1, elements.preview.innerHTML);
    let privateImageBlocked = true;
    for (const privateUrl of [
      "https://127.0.0.1/private.png",
      "https://192.0.2.1/reserved.png",
      "https://[::ffff:127.0.0.1]/mapped-private.png",
      "https://[2001:db8::1]/reserved.png",
    ]) {
      try {
        await api.loadRemoteImage(privateUrl);
        privateImageBlocked = false;
      } catch {
        // 预期：本机、私网、文档示例和 IPv4 映射 IPv6 地址均被拒绝。
      }
    }
    assert("远程图片私网阻止", privateImageBlocked, "私网地址未被阻止");
    loadDocument(await api.readFile(fixturePath));

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
    const delayedSaveResult = await delayedSave;
    assert("保存竞态不放行关闭", delayedSaveResult === false, "保存旧快照不应被视为当前文档已保存");
    assert("保存竞态保留脏状态", state.dirty, "保存期间输入被错误标记为已保存");
    await saveDocument(false);
    const raceSaved = await api.readFile(racePath);
    assert("保存竞态最终落盘", raceSaved.content.includes("保存期间继续输入"), "最终内容未落盘");

    await api.saveFile(conflictPath, "# 原始内容");
    loadDocument(await api.readFile(conflictPath));
    elements.editor.value = "# 清墨中的更改";
    handleEditorInput();
    await api.writeExternalForTest(conflictPath, "# 外部程序的更改");
    const conflict = await api.saveFile(conflictPath, elements.editor.value, {
      baseFingerprint: state.fingerprint,
      encoding: state.encoding,
      bom: state.bom,
      eol: state.eol,
    });
    assert("外部修改冲突检测", conflict.conflict === true, JSON.stringify(conflict));
    assert("冲突不覆盖外部内容", (await api.readFile(conflictPath)).content === "# 外部程序的更改", "外部内容已被覆盖");

    loadDocument(await api.readFile(utf16Path));
    assert("UTF-16 LE 识别", state.encoding === "utf16le" && state.bom && state.eol === "crlf", `${state.encoding}/${state.bom}/${state.eol}`);
    elements.editor.value += "\n新增中文。";
    handleEditorInput();
    await saveDocument(false);
    const utf16Reloaded = await api.readFile(utf16Path);
    assert("UTF-16 与 CRLF 保留", utf16Reloaded.encoding === "utf16le" && utf16Reloaded.bom && utf16Reloaded.eol === "crlf" && utf16Reloaded.content.includes("新增中文。"), JSON.stringify(utf16Reloaded));

    loadDocument(await api.readFile(gb18030Path));
    assert("GB18030 识别", state.encoding === "gb18030" && state.encodingUncertain && state.eol === "crlf", `${state.encoding}/${state.encodingUncertain}/${state.eol}`);
    state.encodingConfirmed = true;
    elements.editor.value += "\n新增内容。";
    handleEditorInput();
    await saveDocument(false);
    const gbReloaded = await api.readFile(gb18030Path);
    assert("GB18030 与 CRLF 保留", gbReloaded.encoding === "gb18030" && gbReloaded.eol === "crlf" && gbReloaded.content.includes("新增内容。"), JSON.stringify(gbReloaded));

    let binaryBlocked = false;
    try {
      await api.readFile(binaryPath);
    } catch {
      binaryBlocked = true;
    }
    assert("二进制文件阻止", binaryBlocked, "二进制文件被当作文本打开");

    const directoryEntries = await api.listDirectoryForTest(directory);
    assert("原子保存临时文件清理", !directoryEntries.some((name) => name.endsWith(".tmp")), directoryEntries.join(", "));

    await api.writeRecovery({ filePath: null, content: "# 未命名恢复草稿", encoding: "utf8", bom: false, eol: "lf" });
    const recoveredDraft = await api.getRecovery();
    assert("未命名草稿恢复读取", recoveredDraft?.content === "# 未命名恢复草稿" && recoveredDraft.filePath === null, JSON.stringify(recoveredDraft));

    const startupFile = await api.readFile(fixturePath);
    const originalConfirm = window.confirm;
    try {
      window.confirm = () => true;
      await chooseStartupDocument(startupFile, recoveredDraft);
      assert("启动时选择恢复草稿", elements.editor.value === "# 未命名恢复草稿" && state.dirty, elements.editor.value);
      await api.writeRecovery({ filePath: null, content: "# 再次恢复草稿", encoding: "utf8", bom: false, eol: "lf" });
      window.confirm = () => false;
      await chooseStartupDocument(startupFile, await api.getRecovery());
      assert("启动时选择指定文件", state.filePath === fixturePath && !state.dirty && (await api.getRecovery()) === null, state.filePath);
    } finally {
      window.confirm = originalConfirm;
    }

    const queuedWrite = api.writeRecovery({ filePath: null, content: "# 即将清除的草稿", encoding: "utf8", bom: false, eol: "lf" });
    const queuedClear = api.clearRecovery();
    await Promise.all([queuedWrite, queuedClear]);
    assert("恢复写入清除串行", (await api.getRecovery()) === null, "清除后草稿被旧写入重新创建");

    await api.writeRecovery({ filePath: null, content: "# 打开失败前的恢复草稿", encoding: "utf8", bom: false, eol: "lf" });
    try {
      window.confirm = () => true;
      elements.editor.value = "# 放弃后打开失败仍需保留恢复草稿";
      handleEditorInput();
      cancelPendingRecovery();
      await replaceDocumentAfterDiscard(async () => {
        throw new Error("模拟打开失败");
      });
      const preservedDraft = await api.getRecovery();
      assert("打开失败不清恢复草稿", preservedDraft?.content === "# 打开失败前的恢复草稿", JSON.stringify(preservedDraft));
    } finally {
      window.confirm = originalConfirm;
    }

    try {
      window.confirm = () => false;
      elements.editor.value = "# 重新加载前未保存";
      handleEditorInput();
      cancelPendingRecovery();
      await reloadWindow();
      assert("取消重新加载保留文档", elements.editor.value === "# 重新加载前未保存" && state.dirty, "取消后文档被重新加载或清脏");
    } finally {
      window.confirm = originalConfirm;
    }

    await api.clearRecovery();
    assert("恢复草稿明确清除", (await api.getRecovery()) === null, "恢复草稿仍然存在");
    loadDocument(await api.readFile(gb18030Path));

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

function applyRecoveryDraft(draft) {
  resetDocumentState();
  state.filePath = draft.filePath || null;
  state.fileUrl = draft.fileUrl || null;
  state.encoding = draft.encoding || "utf8";
  state.encodingUncertain = Boolean(draft.encodingUncertain);
  state.encodingConfirmed = !state.encodingUncertain;
  state.bom = Boolean(draft.bom);
  state.eol = draft.eol || "lf";
  state.fingerprint = draft.fingerprint || null;
  state.savedContent = "";
  elements.editor.value = draft.content;
  updateTitle();
  renderMarkdown();
  updateCursorStatus();
  setDirty(true);
  setStatus("已恢复未保存草稿", 4500);
}

async function restoreRecovery(draft = null) {
  try {
    const recoveryDraft = draft || await api.getRecovery();
    if (!recoveryDraft) return false;
    if (!window.confirm(`发现 ${recoveryDraft.savedAt ? new Date(recoveryDraft.savedAt).toLocaleString() : "上次"} 的未保存草稿，是否恢复？`)) {
      await api.clearRecovery();
      return false;
    }
    applyRecoveryDraft(recoveryDraft);
    return true;
  } catch (error) {
    reportError(error);
    return false;
  }
}

async function chooseStartupDocument(initialResult, draft) {
  if (initialResult && draft) {
    const recover = window.confirm(
      `发现 ${draft.savedAt ? new Date(draft.savedAt).toLocaleString() : "上次"} 的未保存草稿。\n\n确定：恢复草稿\n取消：打开 ${baseName(initialResult.filePath)} 并放弃草稿`,
    );
    if (recover) {
      applyRecoveryDraft(draft);
      return "recovery";
    }
    loadDocument(initialResult);
    await api.clearRecovery();
    return "initial";
  }
  if (initialResult) {
    loadDocument(initialResult);
    return "initial";
  }
  if (draft) return (await restoreRecovery(draft)) ? "recovery" : "welcome";
  return "welcome";
}

async function initialize() {
  elements.editor.value = welcomeDocument;
  elements.autosave.checked = state.autosave;
  setView(state.view);
  applyTheme();
  updateTitle();
  renderMarkdown();
  updateCursorStatus();
  setDirty(false);

  const initialPath = await api.getInitialOpenPath();
  const draftPromise = api.getRecovery();
  let initialResult = null;
  if (initialPath) {
    try {
      initialResult = await api.readFile(initialPath);
    } catch (error) {
      reportError(error);
    }
  }
  await chooseStartupDocument(initialResult, await draftPromise);
}

initialize().catch(reportError);
