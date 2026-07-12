import { cp, mkdir, rm } from "node:fs/promises";

const source = new URL("../tests/fixtures/", import.meta.url);
const target = new URL("../test-results/md-workspace/", import.meta.url);

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
