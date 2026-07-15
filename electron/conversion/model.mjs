import { readFile, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";
import sharp from "sharp";

const parser = unified().use(remarkParse).use(remarkGfm);
const stringifier = unified().use(remarkStringify, {
  bullet: "-",
  fences: true,
  listItemIndent: "one",
  rule: "-",
}).use(remarkGfm);

const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_TOTAL_BYTES = 250 * 1024 * 1024;
const MAX_IMAGE_COUNT = 500;

function consumeImageBudget(options, bytes) {
  if (bytes > MAX_IMAGE_BYTES) throw new Error("单张图片超过 50 MB 转换限制。");
  const budget = options.imageBudget;
  if (!budget) return;
  budget.count = (budget.count || 0) + 1;
  budget.bytes = (budget.bytes || 0) + bytes;
  if (budget.count > MAX_IMAGE_COUNT) throw new Error("文档图片数量超过 500 张转换限制。");
  if (budget.bytes > MAX_IMAGE_TOTAL_BYTES) throw new Error("文档图片总量超过 250 MB 转换限制。");
}

function dataUrlBytes(dataUrl) {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return Buffer.byteLength(dataUrl);
  const payload = dataUrl.slice(comma + 1);
  return /;base64,/i.test(dataUrl.slice(0, comma + 1))
    ? Math.floor(payload.length * 0.75)
    : Buffer.byteLength(decodeURIComponent(payload));
}

function dataUrlBuffer(dataUrl) {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("图片数据地址无效。");
  const header = dataUrl.slice(0, comma + 1);
  const payload = dataUrl.slice(comma + 1);
  return /;base64,/i.test(header) ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8");
}

async function safeSvgPng(data) {
  const source = data.toString("utf8");
  if (
    /<!DOCTYPE|<!ENTITY|<script\b|<foreignObject\b|<style\b|@import/i.test(source)
    || /\son[a-z]+\s*=/i.test(source)
    || /\b(?:href|src)\s*=\s*["']\s*(?!#|data:image\/)/i.test(source)
    || /url\(\s*(?!#)/i.test(source)
  ) throw new Error("SVG 含有脚本、外部资源或不安全元素。");
  const png = await sharp(data, { density: 144, pages: 1, limitInputPixels: 64 * 1024 * 1024 }).png().toBuffer();
  if (png.length > MAX_IMAGE_BYTES) throw new Error("SVG 栅格化结果超过 50 MB 转换限制。");
  return png;
}

export function markdownToModel(markdown, source = {}) {
  const content = String(markdown || "");
  const tree = parser.parse(content);
  const warnings = [...(source.warnings || [])];
  let hasHtml = false;
  let hasFootnotes = false;
  const visit = (node) => {
    if (node.type === "html") hasHtml = true;
    if (node.type === "footnoteDefinition" || node.type === "footnoteReference") hasFootnotes = true;
    for (const child of node.children || []) visit(child);
  };
  visit(tree);
  if (hasHtml) warnings.push("原始 HTML 在可编辑 Office 输出中会作为文本或代码保留，不执行其中的脚本和样式。");
  if (hasFootnotes) warnings.push("脚注在 Office 输出中以可见编号和脚注段落保留，不创建原生脚注对象。");
  if (/(?:^|\n)\s*\$\$[\s\S]+?\$\$\s*(?:\n|$)|\$[^\n$]+\$/m.test(content)) warnings.push("数学公式当前以文本占位保留，不保证转换为可编辑公式对象。");
  return {
    version: 1,
    tree,
    source: {
      type: source.type || "md",
      filePath: source.filePath || null,
      baseDir: source.baseDir || (source.filePath ? path.dirname(source.filePath) : null),
    },
    title: source.title || (source.filePath ? path.basename(source.filePath, path.extname(source.filePath)) : "未命名"),
    warnings,
    metadata: { ...(source.metadata || {}) },
  };
}

export function modelToMarkdown(model) {
  return stringifier.stringify(model.tree).replace(/\n{3,}/g, "\n\n");
}

export function textFromNode(node) {
  if (!node) return "";
  if (node.type === "footnoteReference") return `[^${node.label || node.identifier || "注"}]`;
  if (typeof node.value === "string") return node.value;
  if (!Array.isArray(node.children)) return "";
  return node.children.map(textFromNode).join(node.type === "tableRow" ? " | " : "");
}

export function modelPlainText(model) {
  return textFromNode(model.tree).replace(/\n{3,}/g, "\n\n").trim();
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function safeDocumentLink(value) {
  const link = String(value || "").trim();
  if (!link) return null;
  if (/^(?:javascript|vbscript|data):/i.test(link)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(link) && !/^(?:https?|mailto):/i.test(link)) return null;
  return link;
}

function imageMimeFromName(fileName) {
  const extension = path.extname(fileName || "").toLowerCase();
  return ({
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".svg": "image/svg+xml",
  })[extension] || "application/octet-stream";
}

export async function resolveImageSource(url, model, options = {}) {
  const value = String(url || "");
  if (/^data:image\//i.test(value)) {
    if (/^data:image\/svg\+xml[;,]/i.test(value)) {
      try {
        const png = await safeSvgPng(dataUrlBuffer(value));
        consumeImageBudget(options, png.length);
        return { data: png, mimeType: "image/png", dataUrl: `data:image/png;base64,${png.toString("base64")}`, source: "embedded" };
      } catch (error) {
        return { missing: true, warning: `SVG 图片已阻止：${error.message}` };
      }
    }
    consumeImageBudget(options, dataUrlBytes(value));
    return { dataUrl: value, source: "embedded" };
  }
  if (/^https?:\/\//i.test(value) || value.startsWith("//")) {
    if (!options.includeRemoteImages || !options.remoteImageLoader) {
      return { missing: true, warning: `远程图片未加载：${value}` };
    }
    const normalized = value.startsWith("//") ? `https:${value}` : value;
    const result = await options.remoteImageLoader(normalized);
    if (result?.dataUrl) consumeImageBudget(options, dataUrlBytes(result.dataUrl));
    return { dataUrl: result?.dataUrl, source: "remote" };
  }
  let filePath;
  try {
    if (value.startsWith("file:")) {
      const fileUrl = new URL(value);
      fileUrl.search = "";
      fileUrl.hash = "";
      filePath = fileURLToPath(fileUrl);
    } else {
      const localValue = decodeURIComponent(value.split(/[?#]/, 1)[0]);
      if (path.isAbsolute(localValue)) filePath = localValue;
      else if (model.source.baseDir) filePath = path.resolve(model.source.baseDir, localValue);
    }
  } catch {
    return { missing: true, warning: `图片路径无效：${value}` };
  }
  if (!filePath) return { missing: true, warning: `未命名文档无法解析相对图片：${value}` };
  if (filePath.startsWith("\\\\")) return { missing: true, warning: `网络共享图片默认不加载：${value}` };
  let stats;
  try {
    stats = await stat(filePath);
    if (!stats.isFile()) return { missing: true, warning: `图片路径不是文件：${value}` };
  } catch {
    return { missing: true, warning: `无法读取图片：${value}` };
  }
  consumeImageBudget(options, stats.size);
  const mimeType = imageMimeFromName(filePath);
  if (mimeType === "application/octet-stream") return { missing: true, warning: `不支持的图片格式：${value}` };
  try {
    const data = await readFile(filePath);
    if (mimeType === "image/svg+xml") {
      try {
        const png = await safeSvgPng(data);
        return { data: png, mimeType: "image/png", filePath, dataUrl: `data:image/png;base64,${png.toString("base64")}`, source: "local" };
      } catch (error) {
        return { missing: true, warning: `SVG 图片已阻止：${value}（${error.message}）` };
      }
    }
    return { data, mimeType, filePath, dataUrl: `data:${mimeType};base64,${data.toString("base64")}`, source: "local" };
  } catch {
    return { missing: true, warning: `无法读取图片：${value}` };
  }
}

async function inlineHtml(nodes, model, options) {
  let html = "";
  for (const node of nodes || []) {
    if (node.type === "text") html += escapeHtml(node.value);
    else if (node.type === "strong") html += `<strong>${await inlineHtml(node.children, model, options)}</strong>`;
    else if (node.type === "emphasis") html += `<em>${await inlineHtml(node.children, model, options)}</em>`;
    else if (node.type === "delete") html += `<del>${await inlineHtml(node.children, model, options)}</del>`;
    else if (node.type === "inlineCode") html += `<code>${escapeHtml(node.value)}</code>`;
    else if (node.type === "break") html += "<br>";
    else if (node.type === "footnoteReference") html += `<sup>[${escapeHtml(node.label || node.identifier || "注")}]</sup>`;
    else if (node.type === "link") {
      const link = safeDocumentLink(node.url);
      const content = await inlineHtml(node.children, model, options);
      html += link ? `<a href="${escapeHtml(link)}">${content}</a>` : content;
    }
    else if (node.type === "image") {
      const resolved = await resolveImageSource(node.url, model, options);
      if (resolved.dataUrl) html += `<img src="${resolved.dataUrl}" alt="${escapeHtml(node.alt || "图片")}">`;
      else {
        if (resolved.warning) model.warnings.push(resolved.warning);
        html += `<span class="missing-image">[${escapeHtml(node.alt || "图片")}：未加载]</span>`;
      }
    } else if (node.type === "html") html += `<code>${escapeHtml(node.value)}</code>`;
    else if (node.children) html += await inlineHtml(node.children, model, options);
  }
  return html;
}

async function blockHtml(node, model, options) {
  if (node.type === "heading") return `<h${node.depth}>${await inlineHtml(node.children, model, options)}</h${node.depth}>`;
  if (node.type === "paragraph") return `<p>${await inlineHtml(node.children, model, options)}</p>`;
  if (node.type === "code") return `<pre><code>${escapeHtml(node.value)}</code></pre>`;
  if (node.type === "blockquote") return `<blockquote>${(await Promise.all((node.children || []).map((child) => blockHtml(child, model, options)))).join("")}</blockquote>`;
  if (node.type === "thematicBreak") return "<hr>";
  if (node.type === "list") {
    const tag = node.ordered ? "ol" : "ul";
    const items = await Promise.all((node.children || []).map(async (item) => {
      const task = typeof item.checked === "boolean" ? `<input type="checkbox" disabled${item.checked ? " checked" : ""}> ` : "";
      return `<li>${task}${(await Promise.all((item.children || []).map((child) => blockHtml(child, model, options)))).join("")}</li>`;
    }));
    return `<${tag}>${items.join("")}</${tag}>`;
  }
  if (node.type === "table") {
    const rows = [];
    for (let rowIndex = 0; rowIndex < (node.children || []).length; rowIndex += 1) {
      const row = node.children[rowIndex];
      const tag = rowIndex === 0 ? "th" : "td";
      rows.push(`<tr>${(await Promise.all((row.children || []).map(async (cell) => `<${tag}>${await inlineHtml(cell.children, model, options)}</${tag}>`))).join("")}</tr>`);
    }
    return `<table>${rows.join("")}</table>`;
  }
  if (node.type === "footnoteDefinition") {
    const label = escapeHtml(node.label || node.identifier || "注");
    return `<p><sup>[${label}]</sup> ${(await Promise.all((node.children || []).map((child) => blockHtml(child, model, options)))).join("")}</p>`;
  }
  if (node.type === "html") return `<pre><code>${escapeHtml(node.value)}</code></pre>`;
  return node.children ? (await Promise.all(node.children.map((child) => blockHtml(child, model, options)))).join("") : "";
}

export async function modelToHtml(model, options = {}) {
  const body = (await Promise.all((model.tree.children || []).map((node) => blockHtml(node, model, options)))).join("\n");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><style>
@page{size:A4;margin:18mm 16mm}*{box-sizing:border-box}body{font-family:"Microsoft YaHei","Noto Sans CJK SC",sans-serif;color:#1d2733;line-height:1.65;font-size:11pt}h1,h2,h3,h4{page-break-after:avoid;color:#132b45}h1{font-size:26pt;border-bottom:2px solid #54b7ad;padding-bottom:8px}h2{font-size:20pt}h3{font-size:15pt}pre{background:#f4f6f8;border:1px solid #dde4ea;border-radius:6px;padding:12px;white-space:pre-wrap}code{font-family:Consolas,"Cascadia Mono",monospace}blockquote{border-left:4px solid #54b7ad;margin-left:0;padding-left:14px;color:#526273}table{border-collapse:collapse;width:100%;page-break-inside:avoid}th,td{border:1px solid #cbd5df;padding:6px 8px;text-align:left}th{background:#edf7f5}img{max-width:100%;height:auto;page-break-inside:avoid}.missing-image{color:#a33}a{color:#16776e;text-decoration:none}hr{border:0;border-top:1px solid #ccd5dd;margin:22px 0}
</style></head><body>${body}</body></html>`;
}

function extensionForMime(mimeType) {
  return ({
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/avif": ".avif",
    "image/svg+xml": ".svg",
  })[mimeType] || ".bin";
}

export async function materializeMarkdownImages(model, outputPath, requestedAssetDirectoryName = null) {
  const assetDirectoryName = requestedAssetDirectoryName || `${path.basename(outputPath, path.extname(outputPath))}_assets`;
  const assetDirectory = path.join(path.dirname(outputPath), assetDirectoryName);
  let imageIndex = 0;
  const imageBudget = { count: 0, bytes: 0 };
  async function visit(node) {
    if (node.type === "image" && /^data:image\/[^;]+;base64,/i.test(node.url || "")) {
      const match = node.url.match(/^data:([^;]+);base64,(.+)$/is);
      if (match) {
        const data = Buffer.from(match[2], "base64");
        consumeImageBudget({ imageBudget }, data.length);
        await mkdir(assetDirectory, { recursive: true });
        imageIndex += 1;
        const fileName = `image-${String(imageIndex).padStart(3, "0")}${extensionForMime(match[1].toLowerCase())}`;
        await writeFile(path.join(assetDirectory, fileName), data);
        node.url = `${assetDirectoryName}/${fileName}`;
      }
    }
    for (const child of node.children || []) await visit(child);
  }
  await visit(model.tree);
  return imageIndex ? assetDirectory : null;
}

export function splitModelIntoSlides(model) {
  const nodes = model.tree.children || [];
  const hasExplicitBreaks = nodes.some((node) => node.type === "thematicBreak");
  const slides = [];
  let current = [];
  const flush = () => {
    if (current.length) slides.push(current);
    current = [];
  };
  for (const node of nodes) {
    const shouldSplit = hasExplicitBreaks
      ? node.type === "thematicBreak"
      : node.type === "heading" && node.depth <= 2 && current.length > 0;
    if (shouldSplit) {
      flush();
      if (node.type === "thematicBreak") continue;
    }
    current.push(node);
  }
  flush();
  return slides.length ? slides : [[{ type: "heading", depth: 1, children: [{ type: "text", value: model.title || "未命名" }] }]];
}
