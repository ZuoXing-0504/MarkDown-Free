import { randomUUID, createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile, copyFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import iconv from "iconv-lite";
import { docxToModel, modelToDocxBuffer, pageImagesToDocxBuffer } from "./docx.mjs";
import { componentPages, detectCapabilities, runLibreOffice, runOffice, runPandoc } from "./external.mjs";
import { markdownToModel, materializeMarkdownImages, modelToMarkdown } from "./model.mjs";
import { modelToPdf, pdfToModel, renderPdfPages } from "./pdf.mjs";
import { modelToPptx, pageImagesToPptx, pptxToModel } from "./pptx.mjs";
export { downloadOcrLanguage, getOcrStatus, OCR_MANIFEST } from "./ocr.mjs";

const MAX_INPUT_BYTES = 100 * 1024 * 1024;
const SUPPORTED_INPUTS = new Set(["md", "docx", "doc", "pdf", "pptx", "ppt"]);
const SUPPORTED_TARGETS = new Set(["md", "docx", "pdf", "pptx"]);
const SUPPORTED_OCR_LANGUAGES = new Set(["chi_sim", "eng"]);

function extensionType(filePath) {
  const extension = path.extname(filePath || "").toLowerCase();
  if (extension === ".md" || extension === ".markdown") return "md";
  return extension.slice(1);
}

function outputExtension(target) {
  return target === "md" ? ".md" : `.${target}`;
}

async function exists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

function assertNotCancelled(signal) {
  if (signal?.aborted) throw new Error("转换已取消。");
}

function decodeMarkdown(buffer) {
  if (buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) return buffer.subarray(3).toString("utf8");
  if (buffer.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) return buffer.subarray(2).toString("utf16le");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return iconv.decode(buffer, "gb18030");
  }
}

async function replaceOutputAtomically(stagedPath, finalPath, stagedAssetDirectory = null, finalAssetDirectory = null) {
  const fileBackup = `${finalPath}.cleanmark-backup-${randomUUID()}`;
  const assetBackup = finalAssetDirectory ? `${finalAssetDirectory}.cleanmark-backup-${randomUUID()}` : null;
  const hadFile = await exists(finalPath);
  const hadAssets = finalAssetDirectory ? await exists(finalAssetDirectory) : false;
  let fileBackedUp = false;
  let assetsBackedUp = false;
  let fileCommitted = false;
  let assetsCommitted = false;
  try {
    if (hadFile) {
      await rename(finalPath, fileBackup);
      fileBackedUp = true;
    }
    if (hadAssets) {
      await rename(finalAssetDirectory, assetBackup);
      assetsBackedUp = true;
    }
    if (stagedAssetDirectory) {
      await rename(stagedAssetDirectory, finalAssetDirectory);
      assetsCommitted = true;
    }
    await rename(stagedPath, finalPath);
    fileCommitted = true;
  } catch (error) {
    if (fileCommitted) await rm(finalPath, { force: true }).catch(() => {});
    if (assetsCommitted) await rm(finalAssetDirectory, { recursive: true, force: true }).catch(() => {});
    if (fileBackedUp) await rename(fileBackup, finalPath).catch(() => {});
    if (assetsBackedUp) await rename(assetBackup, finalAssetDirectory).catch(() => {});
    throw error;
  }
  if (fileBackedUp) await rm(fileBackup, { force: true }).catch(() => {});
  if (assetsBackedUp) await rm(assetBackup, { recursive: true, force: true }).catch(() => {});
}

function visualModelFromPages(pageImages, source) {
  const markdown = [];
  for (let index = 0; index < pageImages.length; index += 1) {
    markdown.push(`## 第 ${index + 1} 页`, "", `![第 ${index + 1} 页](data:image/png;base64,${Buffer.from(pageImages[index]).toString("base64")})`, "");
    if (index < pageImages.length - 1) markdown.push("---", "");
  }
  return markdownToModel(markdown.join("\n"), { ...source, warnings: ["视觉保真模式将页面保存为图片，文字不可直接编辑。"] });
}

async function convertLegacyInput(sourceType, filePath, capabilities, workDirectory, context) {
  if (sourceType === "doc") {
    const modernPath = path.join(workDirectory, "legacy-source.docx");
    if (capabilities.office.word.available) {
      await runOffice("word-to-docx", filePath, modernPath, context);
      return { type: "docx", filePath: modernPath, engine: "Microsoft Word" };
    }
    if (capabilities.libreOffice.available) {
      const generated = await runLibreOffice(capabilities.libreOffice.path, filePath, workDirectory, "docx", context);
      return { type: "docx", filePath: generated, engine: "LibreOffice" };
    }
    throw new Error("读取 .doc 需要 Microsoft Word 或 LibreOffice。");
  }
  if (sourceType === "ppt") {
    const modernPath = path.join(workDirectory, "legacy-source.pptx");
    if (capabilities.office.powerPoint.available) {
      await runOffice("ppt-to-pptx", filePath, modernPath, context);
      return { type: "pptx", filePath: modernPath, engine: "Microsoft PowerPoint" };
    }
    if (capabilities.libreOffice.available) {
      const generated = await runLibreOffice(capabilities.libreOffice.path, filePath, workDirectory, "pptx", context);
      return { type: "pptx", filePath: generated, engine: "LibreOffice" };
    }
    throw new Error("读取 .ppt 需要 Microsoft PowerPoint 或 LibreOffice。");
  }
  return { type: sourceType, filePath, engine: null };
}

async function sourceToModel(source, capabilities, workDirectory, options, context) {
  if (source.kind === "editor") {
    return markdownToModel(source.content, {
      type: "md",
      filePath: source.filePath || null,
      baseDir: source.filePath ? path.dirname(source.filePath) : null,
      title: source.title || (source.filePath ? path.basename(source.filePath, path.extname(source.filePath)) : "未命名"),
    });
  }
  const originalType = extensionType(source.filePath);
  const modern = await convertLegacyInput(originalType, source.filePath, capabilities, workDirectory, context);
  if (modern.type === "md") {
    const content = decodeMarkdown(await readFile(modern.filePath));
    return markdownToModel(content, { type: "md", filePath: source.filePath, title: path.basename(source.filePath, path.extname(source.filePath)) });
  }
  if (modern.type === "docx") return docxToModel(modern.filePath);
  if (modern.type === "pptx") return pptxToModel(modern.filePath);
  if (modern.type === "pdf") return pdfToModel(modern.filePath, { ...options, ...context, ocrDataPath: context.ocrDataPath });
  throw new Error(`不支持的来源格式：${modern.type}`);
}

async function sourceAsMarkdownFile(source, workDirectory) {
  if (source.kind === "file") return source.filePath;
  const filePath = path.join(workDirectory, "editor-source.md");
  await writeFile(filePath, source.content, "utf8");
  return filePath;
}

async function sourceMarkdownHasRemoteImages(source) {
  const markdown = source.kind === "editor" ? source.content : decodeMarkdown(await readFile(source.filePath));
  return /!\[[^\]]*\]\(\s*<?(?:https?:)?\/\//i.test(markdown)
    || /<img\b[^>]*\bsrc\s*=\s*["']?\s*(?:https?:)?\/\//i.test(markdown);
}

async function tryDirectPdf(source, sourceType, stagedPath, capabilities, workDirectory, context, warnings) {
  if ((sourceType === "doc" || sourceType === "docx") && capabilities.office.word.available) {
    try {
      await runOffice("word-to-pdf", source.filePath, stagedPath, context);
      return "Microsoft Word";
    } catch (error) {
      warnings.push(`Word 直接导出失败，已降级：${error.message}`);
    }
  }
  if ((sourceType === "ppt" || sourceType === "pptx") && capabilities.office.powerPoint.available) {
    try {
      await runOffice("ppt-to-pdf", source.filePath, stagedPath, context);
      return "Microsoft PowerPoint";
    } catch (error) {
      warnings.push(`PowerPoint 直接导出失败，已降级：${error.message}`);
    }
  }
  if (["doc", "docx", "ppt", "pptx"].includes(sourceType) && capabilities.libreOffice.available) {
    try {
      const generated = await runLibreOffice(capabilities.libreOffice.path, source.filePath, workDirectory, "pdf", context);
      await copyFile(generated, stagedPath);
      return "LibreOffice";
    } catch (error) {
      warnings.push(`LibreOffice 直接导出失败，已降级：${error.message}`);
    }
  }
  return null;
}

async function sourceToPageImages(source, sourceType, capabilities, workDirectory, options, context, warnings) {
  let pdfPath;
  if (sourceType === "pdf" && source.kind === "file") pdfPath = source.filePath;
  else {
    pdfPath = path.join(workDirectory, "visual-source.pdf");
    const directEngine = source.kind === "file" ? await tryDirectPdf(source, sourceType, pdfPath, capabilities, workDirectory, context, warnings) : null;
    if (!directEngine) {
      const model = await sourceToModel(source, capabilities, workDirectory, options, context);
      warnings.push(...model.warnings);
      await modelToPdf(model, pdfPath, { ...options, ...context, workDirectory });
    }
  }
  return renderPdfPages(pdfPath, context);
}

async function writeMarkdownTarget(model, stagedPath, outputPath, workDirectory) {
  const finalAssetName = `${path.basename(outputPath, path.extname(outputPath))}_assets`;
  const workMarkdownPath = path.join(workDirectory, "result.md");
  const workAssetDirectory = await materializeMarkdownImages(model, workMarkdownPath, finalAssetName);
  await writeFile(stagedPath, modelToMarkdown(model), "utf8");
  return workAssetDirectory;
}

export async function convertDocument(request, context = {}) {
  const startedAt = Date.now();
  if (!request || typeof request !== "object") throw new Error("转换请求无效。");
  const source = request.source;
  const target = request.target;
  const mode = request.mode === "visual" ? "visual" : "editable";
  if (!source || !["editor", "file"].includes(source.kind)) throw new Error("转换来源无效。");
  if (!SUPPORTED_TARGETS.has(target)) throw new Error("转换目标格式无效。");
  if (source.kind === "editor") {
    if (typeof source.content !== "string") throw new Error("当前文档内容无效。");
    if (Buffer.byteLength(source.content, "utf8") > MAX_INPUT_BYTES) throw new Error("当前文档超过 100 MB 限制。");
    if (source.filePath && !path.isAbsolute(source.filePath)) throw new Error("当前文档基准路径无效。");
    if (target === "md") throw new Error("当前 Markdown 文档无需转换为 Markdown。");
  }
  if (source.kind === "file") {
    if (typeof source.filePath !== "string" || !path.isAbsolute(source.filePath)) throw new Error("转换来源路径无效。");
    const sourceType = extensionType(source.filePath);
    if (!SUPPORTED_INPUTS.has(sourceType)) throw new Error("不支持该来源文件格式。");
    const sourceStats = await stat(source.filePath);
    if (!sourceStats.isFile()) throw new Error("转换来源不是文件。");
    if (sourceStats.size > MAX_INPUT_BYTES) throw new Error("来源文件超过 100 MB 限制。");
    if (sourceType === target) throw new Error("来源和目标格式相同，无需转换。");
  }
  if (typeof request.outputPath !== "string" || !path.isAbsolute(request.outputPath) || path.extname(request.outputPath).toLowerCase() !== outputExtension(target)) {
    throw new Error(`输出文件必须使用 ${outputExtension(target)} 扩展名。`);
  }
  if (source.kind === "file" && path.resolve(source.filePath).toLowerCase() === path.resolve(request.outputPath).toLowerCase()) {
    throw new Error("输出路径不能覆盖来源文件。");
  }
  const requestedOcrLanguages = request.options?.ocrLanguages ?? ["chi_sim", "eng"];
  if (!Array.isArray(requestedOcrLanguages) || requestedOcrLanguages.some((language) => !SUPPORTED_OCR_LANGUAGES.has(language))) {
    throw new Error("OCR 语言选项无效。");
  }
  if (request.options?.ocr && requestedOcrLanguages.length === 0) throw new Error("请至少选择一种 OCR 语言。");
  await mkdir(path.dirname(request.outputPath), { recursive: true });
  const capabilities = context.capabilities || await detectCapabilities();
  const workDirectory = await mkdtemp(path.join(os.tmpdir(), "cleanmark-conversion-"));
  const stagedPath = path.join(path.dirname(request.outputPath), `.${path.basename(request.outputPath)}.${randomUUID()}.tmp${outputExtension(target)}`);
  const warnings = [];
  let engine = "清墨内置转换器";
  let stagedAssetDirectory = null;
  const sourceType = source.kind === "editor" ? "md" : extensionType(source.filePath);
  const options = {
    includeRemoteImages: Boolean(request.options?.includeRemoteImages),
    remoteImageLoader: context.remoteImageLoader,
    ocr: Boolean(request.options?.ocr),
    ocrLanguages: [...new Set(requestedOcrLanguages)],
    imageBudget: { count: 0, bytes: 0 },
  };
  const progress = context.progress || (() => {});
  const operationContext = { signal: context.signal, progress, timeoutMs: options.ocr ? 30 * 60 * 1000 : 15 * 60 * 1000 };
  try {
    assertNotCancelled(context.signal);
    progress({ stage: "analyze", progress: 0.03, message: "正在分析文档和转换能力…" });

    if (target === "pdf" && source.kind === "file") {
      const directEngine = await tryDirectPdf(source, sourceType, stagedPath, capabilities, workDirectory, operationContext, warnings);
      if (directEngine) engine = directEngine;
      else {
        const model = await sourceToModel(source, capabilities, workDirectory, options, { ...operationContext, ocrDataPath: context.ocrDataPath });
        warnings.push(...model.warnings);
        await modelToPdf(model, stagedPath, { ...options, ...operationContext, workDirectory });
      }
    } else if (target === "docx" && source.kind === "file" && sourceType === "pdf" && mode === "editable" && capabilities.office.word.available) {
      try {
        await runOffice("word-to-docx", source.filePath, stagedPath, {
          ...operationContext,
          timeoutMs: Math.min(operationContext.timeoutMs, 60_000),
        });
        engine = "Microsoft Word PDF 重排";
      } catch (error) {
        warnings.push(`Word PDF 重排失败，已使用内置恢复：${error.message}`);
        const model = await sourceToModel(source, capabilities, workDirectory, options, { ...operationContext, ocrDataPath: context.ocrDataPath });
        warnings.push(...model.warnings);
        await writeFile(stagedPath, await modelToDocxBuffer(model, { ...options, remoteImageLoader: context.remoteImageLoader }));
      }
    } else if (mode === "visual" && target !== "pdf") {
      const pages = await sourceToPageImages(source, sourceType, capabilities, workDirectory, options, operationContext, warnings);
      if (target === "docx") await writeFile(stagedPath, await pageImagesToDocxBuffer(pages, path.basename(request.outputPath, ".docx")));
      else if (target === "pptx") await pageImagesToPptx(pages, stagedPath, path.basename(request.outputPath, ".pptx"));
      else {
        const model = visualModelFromPages(pages, { type: sourceType, filePath: source.filePath, title: path.basename(request.outputPath, ".md") });
        const workAsset = await writeMarkdownTarget(model, stagedPath, request.outputPath, workDirectory);
        if (workAsset) {
          stagedAssetDirectory = path.join(path.dirname(request.outputPath), `.${path.basename(workAsset)}.${randomUUID()}.tmp`);
          await cp(workAsset, stagedAssetDirectory, { recursive: true });
        }
      }
      engine = "视觉保真页面渲染";
    } else if (
      sourceType === "md"
      && capabilities.pandoc.available
      && (target === "docx" || target === "pptx")
      && !await sourceMarkdownHasRemoteImages(source)
    ) {
      const markdownPath = await sourceAsMarkdownFile(source, workDirectory);
      const resourcePath = source.kind === "editor" && source.filePath ? path.dirname(source.filePath) : path.dirname(markdownPath);
      try {
        await runPandoc(capabilities.pandoc.path, [markdownPath, "--from=gfm", `--to=${target}`, "--standalone", "--resource-path", resourcePath, "--output", stagedPath], operationContext);
        engine = "Pandoc";
      } catch (error) {
        warnings.push(`Pandoc 转换失败，已使用内置转换器：${error.message}`);
        const model = await sourceToModel(source, capabilities, workDirectory, options, operationContext);
        if (target === "docx") await writeFile(stagedPath, await modelToDocxBuffer(model, { ...options, remoteImageLoader: context.remoteImageLoader }));
        else await modelToPptx(model, stagedPath, { ...options, remoteImageLoader: context.remoteImageLoader });
        warnings.push(...model.warnings);
      }
    } else {
      const model = await sourceToModel(source, capabilities, workDirectory, options, { ...operationContext, ocrDataPath: context.ocrDataPath });
      warnings.push(...model.warnings);
      if (target === "md") {
        const workAsset = await writeMarkdownTarget(model, stagedPath, request.outputPath, workDirectory);
        if (workAsset) {
          stagedAssetDirectory = path.join(path.dirname(request.outputPath), `.${path.basename(workAsset)}.${randomUUID()}.tmp`);
          await cp(workAsset, stagedAssetDirectory, { recursive: true });
        }
      } else if (target === "docx") {
        await writeFile(stagedPath, await modelToDocxBuffer(model, { ...options, remoteImageLoader: context.remoteImageLoader }));
      } else if (target === "pptx") {
        await modelToPptx(model, stagedPath, { ...options, remoteImageLoader: context.remoteImageLoader });
      } else {
        await modelToPdf(model, stagedPath, { ...options, ...operationContext, workDirectory });
      }
    }

    assertNotCancelled(context.signal);
    progress({ stage: "save", progress: 0.94, message: "正在安全保存转换结果…" });
    if (!await exists(stagedPath)) throw new Error("转换引擎未生成输出文件。");
    const outputStats = await stat(stagedPath);
    if (!outputStats.size) throw new Error("转换结果为空。");
    const finalAssetDirectory = target === "md"
      ? path.join(path.dirname(request.outputPath), `${path.basename(request.outputPath, path.extname(request.outputPath))}_assets`)
      : null;
    await replaceOutputAtomically(stagedPath, request.outputPath, stagedAssetDirectory, finalAssetDirectory);
    const result = {
      outputPath: request.outputPath,
      assetsDirectory: stagedAssetDirectory ? finalAssetDirectory : null,
      engine,
      warnings: [...new Set(warnings.filter(Boolean))],
      durationMs: Date.now() - startedAt,
      sha256: createHash("sha256").update(await readFile(request.outputPath)).digest("hex"),
    };
    return result;
  } finally {
    progress({ stage: "cleanup", progress: 0.98, message: "正在清理临时文件…" });
    await rm(stagedPath, { force: true }).catch(() => {});
    if (stagedAssetDirectory) await rm(stagedAssetDirectory, { recursive: true, force: true }).catch(() => {});
    await rm(workDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

export { componentPages, detectCapabilities };
