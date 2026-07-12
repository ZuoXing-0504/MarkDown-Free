import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const source = fileURLToPath(new URL("../assets/icon/cleanmark-icon.svg", import.meta.url));
const outputDirectory = fileURLToPath(new URL("../assets/icon/generated/", import.meta.url));
const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];

await mkdir(outputDirectory, { recursive: true });

for (const size of sizes) {
  await sharp(source, { density: 384 })
    .resize(size, size, { fit: "contain", kernel: "lanczos3" })
    .ensureAlpha()
    .png({ compressionLevel: 9, palette: false })
    .toFile(`${outputDirectory}/cleanmark-${size}.png`);
}

console.log(`Rendered ${sizes.length} PNG sizes to ${outputDirectory}`);
