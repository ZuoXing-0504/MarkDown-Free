import { packager } from "@electron/packager";
import { fileURLToPath } from "node:url";

const projectDirectory = fileURLToPath(new URL("../", import.meta.url));

const outputPaths = await packager({
  dir: projectDirectory,
  name: "清墨",
  platform: "win32",
  arch: "x64",
  out: fileURLToPath(new URL("../release", import.meta.url)),
  overwrite: true,
  prune: true,
  asar: true,
  appVersion: "0.2.1",
  buildVersion: "0.2.1",
  electronZipDir: fileURLToPath(new URL("../.electron-zips", import.meta.url)),
  ignore: [
    /^\/(?:release|tests|test-results|scripts|src|\.electron-zips)(?:\/|$)/,
    /\.map$/,
  ],
});

console.log(`Windows application written to ${outputPaths.join(", ")}`);
