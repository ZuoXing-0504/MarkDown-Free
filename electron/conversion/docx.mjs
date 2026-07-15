import { readFile } from "node:fs/promises";
import path from "node:path";
import mammoth from "mammoth";
import JSZip from "jszip";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import sharp from "sharp";
import {
  AlignmentType,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  PageBreak,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import { markdownToModel, resolveImageSource, safeDocumentLink, textFromNode } from "./model.mjs";

const MAX_ARCHIVE_ENTRY_BYTES = 100 * 1024 * 1024;
const MAX_ARCHIVE_TOTAL_BYTES = 500 * 1024 * 1024;

async function validateDocxArchive(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  let total = 0;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const size = Number(entry._data?.uncompressedSize || 0);
    if (size > MAX_ARCHIVE_ENTRY_BYTES) throw new Error("DOCX 内部单个资源超过 100 MB 限制。");
    total += size;
    if (total > MAX_ARCHIVE_TOTAL_BYTES) throw new Error("DOCX 解压后内容超过 500 MB 安全限制。");
  }
  if (!zip.file("word/document.xml")) throw new Error("DOCX 文件结构无效或已损坏。");
}

const headingMap = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
  5: HeadingLevel.HEADING_5,
  6: HeadingLevel.HEADING_6,
};

async function normalizedImage(resolved) {
  if (!resolved?.dataUrl && !resolved?.data) return null;
  const dataUrl = resolved.dataUrl || `data:${resolved.mimeType};base64,${resolved.data.toString("base64")}`;
  const comma = dataUrl.indexOf(",");
  const sourceData = resolved.data || (
    /^data:[^;]+;base64,/i.test(dataUrl)
      ? Buffer.from(dataUrl.slice(comma + 1), "base64")
      : Buffer.from(decodeURIComponent(dataUrl.slice(comma + 1)), "utf8")
  );
  const image = sharp(sourceData, { density: 144, pages: 1, limitInputPixels: 64 * 1024 * 1024 });
  const metadata = await image.metadata();
  const sourceWidth = metadata.width || 1;
  const sourceHeight = metadata.height || 1;
  const maxWidth = 620;
  const maxHeight = 820;
  const scale = Math.min(1, maxWidth / sourceWidth, maxHeight / sourceHeight);
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const mime = resolved.mimeType || dataUrl.match(/^data:([^;]+)/i)?.[1] || "image/png";
  if (mime === "image/svg+xml") {
    return {
      data: sourceData,
      type: "svg",
      fallback: { type: "png", data: await image.png().toBuffer() },
      width,
      height,
    };
  }
  const supported = mime === "image/png" || mime === "image/jpeg" || mime === "image/gif" || mime === "image/bmp";
  if (supported) {
    return {
      data: sourceData,
      type: mime === "image/jpeg" ? "jpg" : mime.split("/", 2)[1],
      width,
      height,
    };
  }
  return { data: await image.png().toBuffer(), type: "png", width, height };
}

function styledTextRuns(node, style = {}) {
  if (node.type === "text") return [new TextRun({ text: node.value, ...style })];
  if (node.type === "inlineCode") return [new TextRun({ text: node.value, font: "Consolas", shading: { fill: "EEF1F4" }, ...style })];
  if (node.type === "break") return [new TextRun({ break: 1 })];
  if (node.type === "footnoteReference") return [new TextRun({ text: `[${node.label || node.identifier || "注"}]`, superScript: true, ...style })];
  const nextStyle = {
    ...style,
    ...(node.type === "strong" ? { bold: true } : {}),
    ...(node.type === "emphasis" ? { italics: true } : {}),
    ...(node.type === "delete" ? { strike: true } : {}),
  };
  return (node.children || []).flatMap((child) => styledTextRuns(child, nextStyle));
}

async function inlineChildren(nodes, model, options) {
  const children = [];
  for (const node of nodes || []) {
    if (node.type === "image") {
      const resolved = await resolveImageSource(node.url, model, options);
      if (!resolved.dataUrl && !resolved.data) {
        if (resolved.warning) model.warnings.push(resolved.warning);
        children.push(new TextRun({ text: `[${node.alt || "图片"}：未加载]`, color: "AA3333" }));
        continue;
      }
      const image = await normalizedImage(resolved);
      children.push(new ImageRun({
        type: image.type,
        data: image.data,
        ...(image.fallback ? { fallback: image.fallback } : {}),
        transformation: { width: image.width, height: image.height },
      }));
    } else if (node.type === "link") {
      const link = safeDocumentLink(node.url);
      if (link) children.push(new ExternalHyperlink({ link, children: styledTextRuns({ type: "root", children: node.children }, { color: "16776E", underline: {} }) }));
      else children.push(...styledTextRuns({ type: "root", children: node.children }));
    } else {
      children.push(...styledTextRuns(node));
    }
  }
  return children;
}

async function blocksFromNodes(nodes, model, options, listContext = null) {
  const blocks = [];
  for (const node of nodes || []) {
    if (node.type === "heading") {
      blocks.push(new Paragraph({ heading: headingMap[node.depth] || HeadingLevel.HEADING_6, children: await inlineChildren(node.children, model, options) }));
    } else if (node.type === "paragraph") {
      const paragraphOptions = { children: await inlineChildren(node.children, model, options) };
      if (listContext?.taskPrefix) {
        paragraphOptions.children.unshift(new TextRun({ text: listContext.taskPrefix }));
        paragraphOptions.indent = { left: 420 + Math.min(8, listContext.level || 0) * 280 };
      } else if (listContext?.ordered) paragraphOptions.numbering = { reference: "cleanmark-numbering", level: Math.min(8, listContext.level || 0) };
      else if (listContext) paragraphOptions.bullet = { level: Math.min(8, listContext.level || 0) };
      blocks.push(new Paragraph(paragraphOptions));
    } else if (node.type === "code") {
      blocks.push(new Paragraph({ style: "CleanMarkCode", children: [new TextRun({ text: node.value, font: "Consolas" })] }));
    } else if (node.type === "blockquote") {
      const quoteText = textFromNode(node).trim();
      blocks.push(new Paragraph({ indent: { left: 420 }, border: { left: { color: "54B7AD", size: 16, style: "single", space: 10 } }, children: [new TextRun({ text: quoteText, color: "526273", italics: true })] }));
    } else if (node.type === "list") {
      for (const item of node.children || []) {
        blocks.push(...await blocksFromNodes(item.children, model, options, {
          ordered: Boolean(node.ordered),
          level: (listContext?.level || 0) + (listContext ? 1 : 0),
          taskPrefix: item.checked === true ? "☑ " : item.checked === false ? "☐ " : null,
        }));
      }
    } else if (node.type === "table") {
      const rows = [];
      for (const row of node.children || []) {
        rows.push(new TableRow({
          children: await Promise.all((row.children || []).map(async (cell) => new TableCell({
            children: [new Paragraph({ children: await inlineChildren(cell.children, model, options) })],
          }))),
        }));
      }
      blocks.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows }));
    } else if (node.type === "thematicBreak") {
      blocks.push(new Paragraph({ border: { bottom: { color: "CBD5DF", size: 6, style: "single", space: 1 } } }));
    } else if (node.type === "html") {
      blocks.push(new Paragraph({ children: [new TextRun({ text: node.value, font: "Consolas", color: "555555" })] }));
    } else if (node.type === "footnoteDefinition") {
      blocks.push(new Paragraph({
        children: [
          new TextRun({ text: `[${node.label || node.identifier || "注"}] `, superScript: true }),
          new TextRun({ text: textFromNode(node), size: 18, color: "526273" }),
        ],
      }));
    }
  }
  return blocks;
}

export async function modelToDocxBuffer(model, options = {}) {
  const children = await blocksFromNodes(model.tree.children, model, options);
  const document = new Document({
    creator: "清墨 CleanMark",
    title: model.title,
    description: "由清墨转换生成",
    styles: {
      paragraphStyles: [{
        id: "CleanMarkCode",
        name: "清墨代码块",
        basedOn: "Normal",
        next: "Normal",
        run: { font: "Consolas", size: 20 },
        paragraph: { spacing: { before: 120, after: 120 }, shading: { fill: "F4F6F8" } },
      }],
    },
    numbering: {
      config: [{
        reference: "cleanmark-numbering",
        levels: Array.from({ length: 9 }, (_, level) => ({
          level,
          format: "decimal",
          text: `%${level + 1}.`,
          alignment: AlignmentType.START,
          style: { paragraph: { indent: { left: 720 + level * 360, hanging: 260 } } },
        })),
      }],
    },
    sections: [{ properties: {}, children }],
  });
  return Packer.toBuffer(document);
}

export async function pageImagesToDocxBuffer(pageImages, title = "转换文档") {
  const children = [];
  for (let index = 0; index < pageImages.length; index += 1) {
    const image = await normalizedImage({ data: pageImages[index], mimeType: "image/png" });
    children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new ImageRun({ type: "png", data: image.data, transformation: { width: 620, height: Math.min(877, Math.round(620 * image.height / image.width)) } })] }));
    if (index < pageImages.length - 1) children.push(new Paragraph({ children: [new PageBreak()] }));
  }
  const document = new Document({ title, creator: "清墨 CleanMark", sections: [{ properties: {}, children }] });
  return Packer.toBuffer(document);
}

export async function docxToModel(filePath) {
  const buffer = await readFile(filePath);
  await validateDocxArchive(buffer);
  const result = await mammoth.convertToHtml({ buffer }, {
    convertImage: mammoth.images.imgElement(async (image) => {
      const base64 = await image.read("base64");
      return { src: `data:${image.contentType || "image/png"};base64,${base64}` };
    }),
  });
  const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  turndown.use(gfm);
  const markdown = turndown.turndown(result.value);
  return markdownToModel(markdown, {
    type: "docx",
    filePath,
    title: path.basename(filePath, path.extname(filePath)),
    warnings: result.messages.map((message) => `Word 导入：${message.message || String(message)}`),
  });
}
