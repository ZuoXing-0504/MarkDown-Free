import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const source = fileURLToPath(new URL("../assets/icon/cleanmark-icon.svg", import.meta.url));
const outputDirectory = fileURLToPath(new URL("../assets/icon/generated/", import.meta.url));
const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];

await mkdir(outputDirectory, { recursive: true });

const pngs = [];
for (const size of sizes) {
  const output = `${outputDirectory}/cleanmark-${size}.png`;
  await sharp(source, { density: 384 })
    .resize(size, size, { fit: "contain", kernel: "lanczos3" })
    .ensureAlpha()
    .png({ compressionLevel: 9, palette: false })
    .toFile(output);
  if (size <= 256) pngs.push({ size, data: await sharp(output).png().toBuffer() });
}

const header = Buffer.alloc(6 + pngs.length * 16);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(pngs.length, 4);
let offset = header.length;
pngs.forEach(({ size, data }, index) => {
  const entry = 6 + index * 16;
  header.writeUInt8(size === 256 ? 0 : size, entry);
  header.writeUInt8(size === 256 ? 0 : size, entry + 1);
  header.writeUInt8(0, entry + 2);
  header.writeUInt8(0, entry + 3);
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(data.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += data.length;
});
await writeFile(fileURLToPath(new URL("../assets/icon/cleanmark.ico", import.meta.url)), Buffer.concat([header, ...pngs.map(({ data }) => data)]));

console.log(`Rendered ${sizes.length} PNG sizes and a ${pngs.length}-image ICO.`);
