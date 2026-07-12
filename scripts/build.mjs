import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const outputDirectory = new URL("../dist/", import.meta.url);
const pathFromUrl = (url) => fileURLToPath(url);

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

await build({
  entryPoints: [pathFromUrl(new URL("../src/renderer.js", import.meta.url))],
  bundle: true,
  outfile: pathFromUrl(new URL("renderer.js", outputDirectory)),
  platform: "browser",
  format: "iife",
  target: "chrome140",
  sourcemap: true,
  logLevel: "info",
});

await Promise.all([
  cp(new URL("../src/index.html", import.meta.url), new URL("index.html", outputDirectory)),
  cp(new URL("../src/styles.css", import.meta.url), new URL("styles.css", outputDirectory)),
]);
