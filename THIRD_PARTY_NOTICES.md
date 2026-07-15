# 第三方软件声明

清墨包含或在构建时使用以下开源软件。各组件仍遵循其自身许可证；完整许可证文本可在对应 npm 包、项目仓库和 node_modules 中查阅。

| 组件 | 用途 | 许可证 |
| --- | --- | --- |
| Electron | 桌面运行时 | MIT |
| DOMPurify | HTML 清洗 | MPL-2.0 OR Apache-2.0 |
| highlight.js | 代码语法高亮 | BSD-3-Clause |
| marked | Markdown 预览解析 | MIT |
| iconv-lite | 文本编码转换 | MIT |
| unified、remark-parse、remark-stringify、remark-gfm | Markdown AST 与 GFM | MIT |
| Turndown、turndown-plugin-gfm | HTML 转 Markdown | MIT |
| Mammoth | DOCX 内容读取 | BSD-2-Clause |
| docx | DOCX 文件生成 | MIT |
| PptxGenJS | PPTX 文件生成 | MIT |
| JSZip | OOXML ZIP 读写 | MIT OR GPL-3.0-or-later；清墨按 MIT 选项使用 |
| PDF.js（pdfjs-dist） | PDF 解析与渲染 | Apache-2.0 |
| @napi-rs/canvas | 本地 Canvas 渲染 | MIT |
| sharp | 图片处理与安全栅格化 | Apache-2.0 |
| Tesseract.js | 本地 OCR | Apache-2.0 |
| @tesseract.js-data/eng、@tesseract.js-data/chi_sim | 可选 OCR 语言数据 | Apache-2.0 |
| @electron/packager | Windows 应用打包 | BSD-2-Clause |
| esbuild | 前端构建 | MIT |
| Inno Setup | Windows 安装器 | Inno Setup License |
| Inno Setup Chinese Simplified Translation | 安装器中文翻译 | MIT |

## 可选外部程序

清墨可检测并调用用户已经安装的外部程序，但不捆绑、不静默安装，也不授予这些程序额外许可：

- Microsoft Word、Microsoft PowerPoint：Microsoft 商业软件许可
- LibreOffice：MPL-2.0 / LGPLv3+ 等项目许可
- Pandoc：GPL-2.0-or-later

这些外部程序只用于用户主动发起的本地转换。其可用性、转换结果和许可责任取决于用户安装的版本。

## Clean-room 声明

清墨不包含、加载或执行 Typora 的代码、资源、ASAR、V8 字节码或专有桥接实现。
