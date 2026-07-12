import { packager } from "@electron/packager";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const projectDirectory = fileURLToPath(new URL("../", import.meta.url));
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const electronZipDir = fileURLToPath(new URL("../.electron-zips", import.meta.url));
let hasElectronZipDir = true;
try {
  await access(electronZipDir);
} catch {
  hasElectronZipDir = false;
}

const outputPaths = await packager({
  dir: projectDirectory,
  name: "清墨",
  platform: "win32",
  arch: "x64",
  out: fileURLToPath(new URL("../release", import.meta.url)),
  overwrite: true,
  prune: true,
  asar: true,
  appVersion: packageJson.version,
  buildVersion: packageJson.version,
  appCopyright: "Copyright © 2026 ZuoXing-0504",
  ...(hasElectronZipDir ? { electronZipDir } : {}),
  icon: fileURLToPath(new URL("../assets/icon/cleanmark.ico", import.meta.url)),
  win32metadata: {
    CompanyName: "ZuoXing-0504",
    FileDescription: "清墨 Markdown 编辑器",
    OriginalFilename: "清墨.exe",
    ProductName: "清墨",
    InternalName: "CleanMark",
  },
  ignore: [
    /^\/(?:release|tests|test-results|scripts|src|installer|assets|\.electron-zips|\.github)(?:\/|$)/,
    /^\/(?:README\.md|COMPARISON\.md|RELEASE_CHECKLIST\.md|CONTRIBUTING\.md|SECURITY\.md|CODE_OF_CONDUCT\.md)$/,
    /^\/(?:\.gitignore|\.gitattributes)$/,
    /\.map$/,
  ],
});

console.log(`Windows application written to ${outputPaths.join(", ")}`);
