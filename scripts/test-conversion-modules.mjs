import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { docxToModel, modelToDocxBuffer } from "../electron/conversion/docx.mjs";
import { markdownToModel, modelToHtml, modelToMarkdown, resolveImageSource } from "../electron/conversion/model.mjs";
import { modelToPptx, pptxToModel } from "../electron/conversion/pptx.mjs";

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(projectDirectory, "test-results", "conversion-modules");
const sourceDirectory = path.join(outputDirectory, "source");
const sourcePath = path.join(sourceDirectory, "fixture.md");
const imagePath = path.join(sourceDirectory, "fixture.svg");
const unsafeImagePath = path.join(sourceDirectory, "unsafe.svg");
const docxPath = path.join(outputDirectory, "fixture.docx");
const pptxPath = path.join(outputDirectory, "fixture.pptx");

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(sourceDirectory, { recursive: true });
await writeFile(imagePath, `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="240" viewBox="0 0 480 240"><rect width="480" height="240" rx="24" fill="#17324d"/><path d="M65 55h90v130H65z" fill="#54b7ad"/><text x="190" y="130" fill="#fff" font-size="36" font-family="Microsoft YaHei, sans-serif">清墨 CleanMark</text></svg>`, "utf8");
await writeFile(unsafeImagePath, `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><script>alert(1)</script><image href="https://example.invalid/tracker.png"/></svg>`, "utf8");

const markdown = `# 清墨转换模块测试

这是带有 [安全链接](https://github.com/ZuoXing-0504/MarkDown-Free) 和 [危险链接](javascript:alert(1)) 的正文[^1]。

## 内容

| 项目 | 状态 |
| --- | --- |
| DOCX | 完成 |
| PPTX | 完成 |

- 列表一
- [x] 已完成任务

\`\`\`js
console.log("CleanMark");
\`\`\`

![清墨测试图](fixture.svg)

[^1]: 脚注内容
`;
await writeFile(sourcePath, markdown, "utf8");

const model = markdownToModel(markdown, { filePath: sourcePath, title: "清墨转换模块测试" });
await writeFile(docxPath, await modelToDocxBuffer(model));
await modelToPptx(model, pptxPath);

const [docxModel, pptxModel, docxZip, pptxZip] = await Promise.all([
  docxToModel(docxPath),
  pptxToModel(pptxPath),
  JSZip.loadAsync(await readFile(docxPath)),
  JSZip.loadAsync(await readFile(pptxPath)),
]);
const docxMediaNames = Object.keys(docxZip.files).filter((name) => /^word\/media\/.+/.test(name) && !name.endsWith("/"));
const docxMediaName = docxMediaNames.find((name) => /\.png$/i.test(name)) || docxMediaNames[0];
const pptxSlideNames = Object.keys(pptxZip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
const pptxSlideXml = (await Promise.all(pptxSlideNames.map((name) => pptxZip.file(name).async("string")))).join("\n");
const pptxRelationshipNames = Object.keys(pptxZip.files).filter((name) => /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(name));
const pptxRelationships = (await Promise.all(pptxRelationshipNames.map((name) => pptxZip.file(name).async("string")))).join("\n");
const docxRelationships = await docxZip.file("word/_rels/document.xml.rels").async("string");
const printableHtml = await modelToHtml(model);
const unsafeImage = await resolveImageSource("unsafe.svg", model, { imageBudget: { count: 0, bytes: 0 } });
if (docxMediaName) await writeFile(path.join(outputDirectory, "docx-embedded-image.png"), await docxZip.file(docxMediaName).async("nodebuffer"));

const docxMarkdown = modelToMarkdown(docxModel);
const pptxMarkdown = modelToMarkdown(pptxModel);
const assertions = {
  "DOCX 可重新解析": /清墨转换模块测试/.test(docxMarkdown) && /DOCX/.test(docxMarkdown),
  "DOCX 嵌入图片": docxMediaNames.length >= 1,
  "PPTX 可重新解析": /清墨转换模块测试/.test(pptxMarkdown) && /PPTX/.test(pptxMarkdown),
  "PPTX 列表保持分项": (pptxSlideXml.match(/<a:bu(?:Char|AutoNum)\b/g) || []).length >= 1 && pptxSlideXml.includes("列表一") && pptxSlideXml.includes("已完成任务"),
  "PPTX 包含图片": /<a:blip\b/.test(pptxSlideXml),
  "DOCX 保留安全链接": docxRelationships.includes("https://github.com/ZuoXing-0504/MarkDown-Free"),
  "PPTX 保留安全链接": pptxRelationships.includes("https://github.com/ZuoXing-0504/MarkDown-Free"),
  "危险链接被移除": !docxRelationships.includes("javascript:") && !pptxRelationships.includes("javascript:") && !printableHtml.includes('href="javascript:'),
  "危险 SVG 被阻止": unsafeImage.missing === true && /SVG 图片已阻止/.test(unsafeImage.warning || ""),
  "任务列表与脚注保留": /已完成任务/.test(docxMarkdown) && /脚注内容/.test(docxMarkdown) && /已完成任务/.test(pptxMarkdown) && /脚注内容/.test(pptxMarkdown),
  "转换警告无重复": model.warnings.length === new Set(model.warnings).size,
};
const errors = Object.entries(assertions).filter(([, passed]) => !passed).map(([name]) => name);
const result = { passed: errors.length === 0, assertions, errors, warnings: model.warnings, outputDirectory };
await writeFile(path.join(outputDirectory, "测试报告.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(`${result.passed ? "CONVERSION_MODULES_OK" : "CONVERSION_MODULES_FAILED"} ${JSON.stringify(result)}`);
if (!result.passed) process.exitCode = 1;
