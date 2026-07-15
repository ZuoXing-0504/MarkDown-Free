import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCanvas, DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createWorker } from "tesseract.js";
import { markdownToModel, modelToHtml } from "./model.mjs";

const MAX_CANVAS_PIXELS = 16 * 1024 * 1024;
const MAX_CANVAS_DIMENSION = 4096;
const MAX_VISUAL_OUTPUT_BYTES = 512 * 1024 * 1024;

if (!globalThis.DOMMatrix) globalThis.DOMMatrix = DOMMatrix;
if (!globalThis.ImageData) globalThis.ImageData = ImageData;
if (!globalThis.Path2D) globalThis.Path2D = Path2D;

function assertNotCancelled(signal) {
  if (signal?.aborted) throw new Error("转换已取消。");
}

async function loadPdf(filePath) {
  const data = new Uint8Array(await readFile(filePath));
  return getDocument({
    data,
    useSystemFonts: true,
    isEvalSupported: false,
    maxImageSize: 32 * 1024 * 1024,
    canvasMaxAreaInBytes: 64 * 1024 * 1024,
  }).promise;
}

function safeViewport(page, desiredScale) {
  const base = page.getViewport({ scale: 1 });
  const dimensionScale = Math.min(MAX_CANVAS_DIMENSION / base.width, MAX_CANVAS_DIMENSION / base.height);
  const pixelScale = Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, base.width * base.height));
  const scale = Math.min(desiredScale, dimensionScale, pixelScale);
  if (!Number.isFinite(scale) || scale <= 0) throw new Error("PDF 页面尺寸无效。");
  return page.getViewport({ scale });
}

export async function renderPdfPages(filePath, options = {}) {
  const pdf = await loadPdf(filePath);
  const pageCount = pdf.numPages;
  if (pageCount > 500) {
    await pdf.destroy();
    throw new Error("PDF 超过 500 页限制。");
  }
  const pages = [];
  let totalBytes = 0;
  try {
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      assertNotCancelled(options.signal);
      options.progress?.({ stage: "render", current: pageNumber, total: pageCount, message: `正在渲染第 ${pageNumber} 页…` });
      const page = await pdf.getPage(pageNumber);
      try {
        const viewport = safeViewport(page, options.scale || 1.6);
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const context = canvas.getContext("2d");
        await page.render({ canvasContext: context, viewport }).promise;
        const rendered = canvas.toBuffer("image/png");
        totalBytes += rendered.length;
        if (totalBytes > MAX_VISUAL_OUTPUT_BYTES) throw new Error("视觉保真页面数据超过 512 MB 安全限制，请拆分文档后重试。");
        pages.push(rendered);
      } finally {
        page.cleanup();
      }
    }
    return pages;
  } finally {
    await pdf.destroy();
  }
}

function textFromItems(items) {
  const lines = [];
  let current = "";
  for (const item of items) {
    if (!item?.str) continue;
    current += `${current && !/^\s/.test(item.str) ? " " : ""}${item.str}`;
    if (item.hasEOL) {
      if (current.trim()) lines.push(current.trim());
      current = "";
    }
  }
  if (current.trim()) lines.push(current.trim());
  return lines.join("\n");
}

async function createOcrWorker(options) {
  const languages = options.ocrLanguages?.length ? options.ocrLanguages : ["chi_sim", "eng"];
  return createWorker(languages.join("+"), 1, {
    langPath: options.ocrDataPath,
    gzip: true,
    cacheMethod: "none",
    logger: (message) => {
      if (typeof message.progress === "number") options.progress?.({ stage: "ocr", progress: message.progress, message: `OCR：${message.status || "识别中"}` });
    },
  });
}

export async function pdfToModel(filePath, options = {}) {
  const pdf = await loadPdf(filePath);
  const pageCount = pdf.numPages;
  if (pageCount > 500) {
    await pdf.destroy();
    throw new Error("PDF 超过 500 页限制。");
  }
  const markdown = [];
  const warnings = ["PDF 缺少稳定的语义结构，表格、双栏和复杂布局属于尽力恢复。"];
  let worker = null;
  let ocrPages = 0;
  try {
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      assertNotCancelled(options.signal);
      options.progress?.({ stage: "extract", current: pageNumber, total: pageCount, message: `正在提取第 ${pageNumber} 页…` });
      const page = await pdf.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        let text = textFromItems(content.items);
        if (text.replace(/\s/g, "").length < 12 && options.ocr) {
          if (ocrPages >= 200) throw new Error("OCR 超过 200 页限制。");
          worker ||= await createOcrWorker(options);
          const viewport = safeViewport(page, 2);
          const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
          await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
          const result = await worker.recognize(canvas.toBuffer("image/png"));
          text = result.data.text.trim();
          ocrPages += 1;
        }
        if (!text.trim()) {
          text = "_（本页未提取到文字）_";
          warnings.push(`第 ${pageNumber} 页未提取到可编辑文字，建议使用视觉保真模式${options.ocr ? "或检查 OCR 语言包" : "或启用 OCR"}。`);
        }
        markdown.push(`## 第 ${pageNumber} 页`, "", text, "");
        if (pageNumber < pageCount) markdown.push("---", "");
      } finally {
        page.cleanup();
      }
    }
  } finally {
    if (worker) await worker.terminate();
    await pdf.destroy();
  }
  return markdownToModel(markdown.join("\n"), {
    type: "pdf",
    filePath,
    title: path.basename(filePath, path.extname(filePath)),
    warnings,
    metadata: { pages: pageCount, ocrPages },
  });
}

export async function modelToPdf(model, outputPath, options = {}) {
  const electron = await import("electron");
  const BrowserWindow = electron.BrowserWindow || electron.default?.BrowserWindow;
  if (!BrowserWindow) throw new Error("生成 PDF 需要在清墨 Electron 应用中运行。");
  const html = await modelToHtml(model, options);
  const htmlPath = path.join(options.workDirectory, "document.html");
  await writeFile(htmlPath, html, "utf8");
  const window = new BrowserWindow({
    show: false,
    width: 1240,
    height: 1754,
    webPreferences: {
      javascript: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  try {
    await window.loadFile(htmlPath);
    assertNotCancelled(options.signal);
    options.progress?.({ stage: "generate", message: "正在生成 PDF…" });
    const data = await window.webContents.printToPDF({
      pageSize: "A4",
      printBackground: true,
      margins: { top: 0.25, bottom: 0.25, left: 0.2, right: 0.2 },
      preferCSSPageSize: true,
    });
    await writeFile(outputPath, data);
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
}
