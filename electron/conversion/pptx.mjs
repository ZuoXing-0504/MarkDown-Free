import { readFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import PptxGenJS from "pptxgenjs";
import sharp from "sharp";
import { markdownToModel, resolveImageSource, safeDocumentLink, splitModelIntoSlides, textFromNode } from "./model.mjs";

const MAX_ARCHIVE_ENTRY_BYTES = 100 * 1024 * 1024;
const MAX_ARCHIVE_TOTAL_BYTES = 500 * 1024 * 1024;

function validatePptxArchive(zip) {
  let total = 0;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const size = Number(entry._data?.uncompressedSize || 0);
    if (size > MAX_ARCHIVE_ENTRY_BYTES) throw new Error("PPTX 内部单个资源超过 100 MB 限制。");
    total += size;
    if (total > MAX_ARCHIVE_TOTAL_BYTES) throw new Error("PPTX 解压后内容超过 500 MB 安全限制。");
  }
  if (!zip.file("ppt/presentation.xml")) throw new Error("PPTX 文件结构无效或已损坏。");
}

function decodeXml(value) {
  return String(value || "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function pptTextRuns(nodes, style = {}) {
  const runs = [];
  for (const node of nodes || []) {
    if (node.type === "text") runs.push({ text: node.value, options: { ...style } });
    else if (node.type === "break") runs.push({ text: "\n", options: { ...style, breakLine: true } });
    else if (node.type === "inlineCode") runs.push({ text: node.value, options: { ...style, fontFace: "Consolas", highlight: "EEF1F4" } });
    else if (node.type === "footnoteReference") runs.push({ text: `[${node.label || node.identifier || "注"}]`, options: { ...style, superscript: true } });
    else if (node.type === "image") runs.push({ text: `[${node.alt || "图片"}]`, options: { ...style, color: "AA3333" } });
    else if (node.type === "link") {
      const link = safeDocumentLink(node.url);
      runs.push(...pptTextRuns(node.children, { ...style, color: "16776E", underline: { color: "16776E", style: "sng" }, ...(link ? { hyperlink: { url: link } } : {}) }));
    } else {
      runs.push(...pptTextRuns(node.children, {
        ...style,
        ...(node.type === "strong" ? { bold: true } : {}),
        ...(node.type === "emphasis" ? { italic: true } : {}),
        ...(node.type === "delete" ? { strike: "sngStrike" } : {}),
      }));
    }
  }
  return runs;
}

function slideChunks(model) {
  const logicalSlides = splitModelIntoSlides(model);
  const chunks = [];
  for (const nodes of logicalSlides) {
    const titleNode = nodes.find((node) => node.type === "heading");
    const bodyNodes = titleNode ? nodes.filter((node) => node !== titleNode) : nodes;
    const title = cleanText(titleNode ? textFromNode(titleNode) : model.title) || "清墨文档";
    let current = [];
    let currentHeight = 0;
    let part = 0;
    let split = false;
    for (const node of bodyNodes) {
      const height = estimatedNodeHeight(node);
      if (current.length && currentHeight + height > 5.5) {
        chunks.push({ title: part === 0 ? title : `${title}（续）`, nodes: current });
        part += 1;
        current = [];
        currentHeight = 0;
        split = true;
      }
      current.push(node);
      currentHeight += height;
    }
    if (current.length || !bodyNodes.length) chunks.push({ title: part === 0 ? title : `${title}（续）`, nodes: current });
    if (split) model.warnings.push(`幻灯片“${title}”内容过多，已自动拆分。`);
  }
  return chunks;
}

function estimatedNodeHeight(node) {
  if (node.type === "image" || (node.type === "paragraph" && node.children?.length === 1 && node.children[0].type === "image")) return 2.05;
  if (node.type === "table") return Math.min(2.8, 0.38 + (node.children?.length || 1) * 0.38);
  if (node.type === "list") return Math.min(2.5, 0.28 + (node.children?.length || 1) * 0.42);
  if (node.type === "code") return Math.min(2.4, 0.48 + String(node.value || "").split("\n").length * 0.3);
  const length = cleanText(textFromNode(node)).length;
  return Math.min(1.8, 0.48 + Math.ceil(length / 55) * 0.32);
}

function fitWithin(width, height, maxWidth, maxHeight) {
  const scale = Math.min(maxWidth / Math.max(1, width), maxHeight / Math.max(1, height));
  return { width: width * scale, height: height * scale };
}

function resolvedImageBuffer(resolved) {
  if (resolved.data) return Buffer.from(resolved.data);
  const dataUrl = resolved.dataUrl || "";
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("图片数据无效。");
  return /;base64,/i.test(dataUrl.slice(0, comma + 1))
    ? Buffer.from(dataUrl.slice(comma + 1), "base64")
    : Buffer.from(decodeURIComponent(dataUrl.slice(comma + 1)), "utf8");
}

async function normalizedPptxImage(resolved) {
  const buffer = resolvedImageBuffer(resolved);
  const metadata = await sharp(buffer, { pages: 1, limitInputPixels: 64 * 1024 * 1024 }).metadata();
  const mimeType = resolved.mimeType || resolved.dataUrl?.match(/^data:([^;,]+)/i)?.[1]?.toLowerCase() || "application/octet-stream";
  if (["image/png", "image/jpeg", "image/gif"].includes(mimeType)) {
    return { dataUrl: resolved.dataUrl || `data:${mimeType};base64,${buffer.toString("base64")}`, width: metadata.width || 1, height: metadata.height || 1 };
  }
  const png = await sharp(buffer, { pages: 1, limitInputPixels: 64 * 1024 * 1024 }).png().toBuffer();
  return { dataUrl: `data:image/png;base64,${png.toString("base64")}`, width: metadata.width || 1, height: metadata.height || 1 };
}

async function addNode(slide, node, layout, model, options) {
  const { y, height } = layout;
  if (node.type === "image" || (node.type === "paragraph" && node.children?.length === 1 && node.children[0].type === "image")) {
    const imageNode = node.type === "image" ? node : node.children[0];
    const resolved = await resolveImageSource(imageNode.url, model, options);
    if (resolved.dataUrl) {
      const image = await normalizedPptxImage(resolved);
      const fitted = fitWithin(image.width, image.height, 11.35, Math.min(3.4, height));
      slide.addImage({ data: image.dataUrl, x: 0.85, y: y + Math.max(0, (height - fitted.height) / 2), w: fitted.width, h: fitted.height });
    }
    else {
      if (resolved.warning) model.warnings.push(resolved.warning);
      slide.addText(`[${imageNode.alt || "图片"}：未加载]`, { x: 0.9, y, w: 11.3, h: 0.5, color: "AA3333", fontSize: 15 });
    }
    return;
  }
  if (node.type === "table") {
    const rows = (node.children || []).map((row) => (row.children || []).map((cell) => cleanText(textFromNode(cell))));
    if (rows.length) slide.addTable(rows, { x: 0.8, y, w: 11.7, h: Math.min(height, 3), fontFace: "Microsoft YaHei", fontSize: 14, border: { type: "solid", color: "BFCAD4", pt: 1 }, fill: "FFFFFF", color: "203040", margin: 0.06, autoFit: false, bold: false });
    return;
  }
  if (node.type === "list") {
    const items = node.children || [];
    const itemHeight = height / Math.max(1, items.length);
    for (let index = 0; index < items.length; index += 1) {
      const taskPrefix = items[index].checked === true ? "☑ " : items[index].checked === false ? "☐ " : "";
      slide.addText(`${taskPrefix}${cleanText(textFromNode(items[index])) || " "}`, {
        x: 0.95,
        y: y + index * itemHeight,
        w: 11.1,
        h: itemHeight,
        fontFace: "Microsoft YaHei",
        fontSize: 17,
        color: "263746",
        margin: 0.02,
        valign: "mid",
        bullet: taskPrefix
          ? undefined
          : node.ordered
            ? { type: "number", style: "arabicPeriod", numberStartAt: index + 1, indent: 20 }
            : { indent: 20 },
      });
    }
    return;
  }
  const text = node.type === "code" ? node.value : cleanText(textFromNode(node));
  if (!text) return;
  const richText = node.type === "code" ? text : pptTextRuns(node.children);
  slide.addText(richText.length ? richText : text, {
    x: 0.95,
    y,
    w: 11.1,
    h: height,
    fontFace: node.type === "code" ? "Consolas" : "Microsoft YaHei",
    fontSize: node.type === "code" ? 13 : 17,
    color: node.type === "blockquote" ? "526273" : "263746",
    fill: node.type === "code" ? { color: "F4F6F8" } : undefined,
    margin: node.type === "code" ? 0.12 : 0.02,
    valign: "top",
    breakLine: false,
  });
}

function createPresentation(title) {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "清墨 CleanMark";
  pptx.company = "ZuoXing-0504";
  pptx.subject = "由清墨转换生成";
  pptx.title = title;
  pptx.lang = "zh-CN";
  pptx.theme = {
    headFontFace: "Microsoft YaHei",
    bodyFontFace: "Microsoft YaHei",
    lang: "zh-CN",
  };
  return pptx;
}

export async function modelToPptx(model, outputPath, options = {}) {
  const pptx = createPresentation(model.title);
  for (const section of slideChunks(model)) {
    const slide = pptx.addSlide();
    slide.background = { color: "F7FAFC" };
    slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.333, h: 0.16, fill: { color: "54B7AD" }, line: { color: "54B7AD" } });
    slide.addText(section.title, { x: 0.75, y: 0.35, w: 11.8, h: 0.72, fontFace: "Microsoft YaHei", fontSize: 30, bold: true, color: "18334D", margin: 0, fit: "shrink" });
    let y = 1.3;
    for (const node of section.nodes) {
      const height = estimatedNodeHeight(node);
      await addNode(slide, node, { y, height }, model, options);
      y += height + 0.1;
    }
    slide.addText("清墨 · CleanMark", { x: 10.7, y: 7.05, w: 1.8, h: 0.22, fontSize: 8, color: "80909F", align: "right", margin: 0 });
  }
  await pptx.writeFile({ fileName: outputPath, compression: true });
}

export async function pageImagesToPptx(pageImages, outputPath, title = "转换演示文稿") {
  const pptx = createPresentation(title);
  for (const image of pageImages) {
    const slide = pptx.addSlide();
    slide.background = { color: "FFFFFF" };
    slide.addImage({ data: `data:image/png;base64,${Buffer.from(image).toString("base64")}`, x: 0, y: 0, w: 13.333, h: 7.5 });
  }
  await pptx.writeFile({ fileName: outputPath, compression: true });
}

function mediaType(fileName) {
  const extension = path.extname(fileName).toLowerCase();
  return ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml" })[extension] || "application/octet-stream";
}

export async function pptxToModel(filePath) {
  const zip = await JSZip.loadAsync(await readFile(filePath));
  validatePptxArchive(zip);
  const slideNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)/i)?.[1]) - Number(b.match(/slide(\d+)/i)?.[1]));
  if (slideNames.length > 500) throw new Error("PPT 超过 500 张幻灯片限制。");
  const markdown = [];
  const warnings = ["PPT 可编辑导入会保留文本、图片和备注，但复杂布局、动画与 SmartArt 可能降级。"];
  for (let index = 0; index < slideNames.length; index += 1) {
    const slideName = slideNames[index];
    const slideXml = await zip.file(slideName).async("string");
    const texts = [...slideXml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gi)].map((match) => cleanText(decodeXml(match[1]))).filter(Boolean);
    markdown.push(`# 幻灯片 ${index + 1}`, "", texts.join("  \n") || "_（无可提取文本）_", "");

    const slideNumber = Number(slideName.match(/slide(\d+)/i)?.[1]);
    const relName = `ppt/slides/_rels/slide${slideNumber}.xml.rels`;
    const relFile = zip.file(relName);
    if (relFile) {
      const relXml = await relFile.async("string");
      const relations = new Map([...relXml.matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/?\s*>/gi)].map((match) => [match[1], match[2]]));
      const imageIds = [...slideXml.matchAll(/<a:blip\b[^>]*r:embed="([^"]+)"/gi)].map((match) => match[1]);
      let imageIndex = 0;
      for (const imageId of imageIds) {
        const target = relations.get(imageId);
        if (!target) continue;
        const normalized = path.posix.normalize(path.posix.join("ppt/slides", target)).replace(/^\.\.\//, "");
        const mediaFile = zip.file(normalized) || zip.file(`ppt/media/${path.posix.basename(target)}`);
        if (!mediaFile) continue;
        imageIndex += 1;
        const data = await mediaFile.async("base64");
        markdown.push(`![幻灯片 ${index + 1} 图片 ${imageIndex}](data:${mediaType(target)};base64,${data})`, "");
      }
    }
    const notesFile = zip.file(`ppt/notesSlides/notesSlide${slideNumber}.xml`);
    if (notesFile) {
      const notesXml = await notesFile.async("string");
      const notes = [...notesXml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gi)].map((match) => cleanText(decodeXml(match[1]))).filter(Boolean);
      if (notes.length) markdown.push(`> 备注：${notes.join(" ")}`, "");
    }
    if (index < slideNames.length - 1) markdown.push("---", "");
  }
  return markdownToModel(markdown.join("\n"), {
    type: "pptx",
    filePath,
    title: path.basename(filePath, path.extname(filePath)),
    warnings,
    metadata: { slides: slideNames.length },
  });
}
