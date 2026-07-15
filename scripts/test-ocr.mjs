import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { createWorker } from "tesseract.js";
import { downloadOcrLanguage, getOcrStatus } from "../electron/conversion/ocr.mjs";
import { pdfToModel } from "../electron/conversion/pdf.mjs";
import { modelToMarkdown } from "../electron/conversion/model.mjs";

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(projectDirectory, "test-results", "ocr");
const languageDirectory = path.join(projectDirectory, "test-results", "ocr-languages");
const imagePath = path.join(outputDirectory, "scan.png");
const pdfPath = path.join(outputDirectory, "scan.pdf");

function imagePdf(jpeg, width, height) {
  const chunks = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "binary")];
  const offsets = [0];
  const addObject = (number, parts) => {
    offsets[number] = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    chunks.push(Buffer.from(`${number} 0 obj\n`, "ascii"), ...parts, Buffer.from("\nendobj\n", "ascii"));
  };
  addObject(1, [Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "ascii")]);
  addObject(2, [Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "ascii")]);
  addObject(3, [Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`, "ascii")]);
  addObject(4, [
    Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, "ascii"),
    jpeg,
    Buffer.from("\nendstream", "ascii"),
  ]);
  const content = Buffer.from(`q\n${width} 0 0 ${height} 0 0 cm\n/Im0 Do\nQ\n`, "ascii");
  addObject(5, [Buffer.from(`<< /Length ${content.length} >>\nstream\n`, "ascii"), content, Buffer.from("endstream", "ascii")]);
  const xrefOffset = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  chunks.push(Buffer.from("xref\n0 6\n0000000000 65535 f \n", "ascii"));
  for (let number = 1; number <= 5; number += 1) chunks.push(Buffer.from(`${String(offsets[number]).padStart(10, "0")} 00000 n \n`, "ascii"));
  chunks.push(Buffer.from(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`, "ascii"));
  return Buffer.concat(chunks);
}

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await mkdir(languageDirectory, { recursive: true });
for (const language of ["chi_sim", "eng"]) {
  let lastPercent = -1;
  await downloadOcrLanguage(language, languageDirectory, ({ downloaded, total }) => {
    if (!total) return;
    const percent = Math.round(downloaded / total * 100);
    if (percent !== lastPercent && percent % 10 === 0) {
      lastPercent = percent;
      process.stdout.write(`${language}: ${percent}%\n`);
    }
  });
}

const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="420"><rect width="1400" height="420" fill="white"/><text x="80" y="180" fill="black" font-size="112" font-family="Microsoft YaHei, Arial, sans-serif">清墨 CleanMark</text><text x="80" y="330" fill="black" font-size="72" font-family="Microsoft YaHei, Arial, sans-serif">本地文档转换 OCR TEST 2026</text></svg>`);
await sharp(svg, { density: 144 }).png().toFile(imagePath);
const jpeg = await sharp(svg, { density: 144 }).jpeg({ quality: 92 }).toBuffer();
await writeFile(pdfPath, imagePdf(jpeg, 1400, 420));

const worker = await createWorker("chi_sim+eng", 1, { langPath: languageDirectory, gzip: true, cacheMethod: "none" });
let text = "";
try {
  const result = await worker.recognize(imagePath);
  text = result.data.text.replace(/\s+/g, " ").trim();
} finally {
  await worker.terminate();
}
const status = await getOcrStatus(languageDirectory);
console.log("OCR image recognition passed; testing scanned PDF pipeline…");
const pdfModel = await pdfToModel(pdfPath, {
  ocr: true,
  ocrLanguages: ["chi_sim", "eng"],
  ocrDataPath: languageDirectory,
});
console.log("Scanned PDF OCR pipeline passed.");
const pdfText = modelToMarkdown(pdfModel).replace(/\s+/g, " ").trim();
const assertions = {
  "简体中文语言包 SHA-256": status.chi_sim.valid,
  "英文语言包 SHA-256": status.eng.valid,
  "英文 OCR": /clean\s*mark/i.test(text) && /2026/.test(text),
  "中文 OCR": /[\u3400-\u9fff]/.test(text),
  "扫描 PDF OCR": /clean\s*mark/i.test(pdfText) && /2026/.test(pdfText) && pdfModel.metadata.ocrPages === 1,
};
const errors = Object.entries(assertions).filter(([, passed]) => !passed).map(([name]) => name);
const report = { passed: errors.length === 0, assertions, errors, recognizedText: text, pdfRecognizedText: pdfText };
await writeFile(path.join(outputDirectory, "测试报告.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`${report.passed ? "OCR_OK" : "OCR_FAILED"} ${JSON.stringify(report)}`);
if (!report.passed) process.exitCode = 1;
