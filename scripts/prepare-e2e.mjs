import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import iconv from "iconv-lite";

const source = new URL("../tests/fixtures/", import.meta.url);
const target = new URL("../test-results/md-workspace/", import.meta.url);

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
await writeFile(new URL("06-UTF16LE-CRLF.md", target), Buffer.concat([
  Buffer.from([0xff, 0xfe]),
  iconv.encode("# UTF-16 测试\r\n\r\n保留 CRLF。\r\n", "utf16le"),
]));
await writeFile(new URL("07-GB18030.md", target), iconv.encode("# GB18030 测试\r\n\r\n中文编码保留。\r\n", "gb18030"));
await writeFile(new URL("09-二进制.bin", target), Buffer.from([0x01, 0x02, 0x03, 0xff, 0x04, 0x05, 0x06]));
