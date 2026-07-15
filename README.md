# 清墨（CleanMark）

清墨是一款从零独立开发的中文桌面 Markdown 编辑器，基于 Electron，面向 Windows。项目不导入、加载、执行或分发 Typora 的代码、ASAR、V8 字节码、资源或专有桥接实现。

[项目主页](https://github.com/ZuoXing-0504/MarkDown-Free) · [问题反馈](https://github.com/ZuoXing-0504/MarkDown-Free/issues) · 如果项目对你有帮助，欢迎为仓库点亮 Star。

## 主要功能

- 新建、打开、保存、另存为、文件夹树浏览
- 编辑、分屏、预览三种模式
- GFM、表格、任务列表、代码高亮、相对本地图片
- 撤销、重做、查找、格式工具栏、主题、字词与光标统计
- 可选自动保存、未保存关闭保护、崩溃恢复草稿
- 原子保存、外部修改冲突检测、编码与换行风格保留
- 受限 IPC、上下文隔离、DOMPurify 清洗和安全远程图片通道

## 文档转换中心（0.4.0）

支持单个当前 Markdown 文档或单个外部文件转换，文档内容始终在本机处理。

| 输入 | 可输出 |
| --- | --- |
| Markdown（.md、.markdown） | DOCX、PDF、PPTX |
| Word（.docx） | Markdown、PDF、PPTX |
| PDF（.pdf） | Markdown、DOCX、PPTX |
| PowerPoint（.pptx） | Markdown、DOCX、PDF |

安装 Microsoft Office 或 LibreOffice 后，可额外读取旧版 .doc、.ppt。转换中心提供：

- “可编辑”模式：优先恢复标题、段落、列表、表格、代码、图片和链接
- “视觉保真”模式：把复杂页面渲染为高清图片，外观更稳定，但文字不便编辑
- Markdown 转 PPT：按 ---、一级或二级标题分页，超出页面时自动拆页并报告警告
- 扫描版 PDF：可选择下载简体中文和英文 OCR 语言包，在本地识别
- 转换进度、取消、超时、覆盖确认、转换报告和降级警告
- 转为 Markdown 时将图片写入同目录的“文件名_assets”并使用相对路径

引擎按当前路线和本机能力选择：Microsoft Word/PowerPoint、LibreOffice、Pandoc、清墨内置转换器。缺少外部工具不会阻止使用内置路线，也不会被静默安装。

PDF 本身通常缺少可靠结构，因此 PDF 转可编辑格式属于尽力恢复。宏、动画、复杂 SmartArt、嵌入对象、视频和特殊字体不保证可编辑地还原。完整边界见 [CONVERSION_QUALITY.md](CONVERSION_QUALITY.md)。

## 隐私与联网

- 文档、图片、临时文件、转换结果和 OCR 识别过程均留在本机
- 清墨不包含遥测、广告或云端转换
- OCR 语言包仅在用户确认后从 jsDelivr 下载，并校验固定大小和 SHA-256
- 远程图片默认不加载；用户明确允许后，仅通过受限 HTTPS 图片通道获取
- Office、LibreOffice 和 Pandoc 只在本机调用

详情见 [PRIVACY.md](PRIVACY.md) 和 [SECURITY.md](SECURITY.md)。

## 本地运行

需要 Node.js 22 或更新版本和 npm。

~~~powershell
npm ci
npm start
~~~

## 验证

~~~powershell
npm run check
npm run smoke
npm run test:e2e
npm run test:conversion:modules
npm run test:conversion
npm run test:ocr
npm audit
~~~

test:e2e 会真实创建和修改 Markdown 文件；test:conversion 覆盖 12 个跨格式方向和视觉模式；test:ocr 会联网下载到临时目录并验证固定 OCR 语言包。

## Windows 打包

构建便携应用：

~~~powershell
npm run package:win
~~~

构建当前用户安装器还需要 Inno Setup 6.7 或更新版本：

~~~powershell
npm run installer:win
~~~

0.4.0 默认输出：

- release/installer/清墨-0.4.0-安装程序.exe
- release/installer/CleanMark-0.4.0-Setup.exe
- release/installer/SHA256SUMS.txt

两个安装器文件内容相同，仅文件名不同。安装范围为当前用户，默认目录为 %LOCALAPPDATA%\Programs\清墨，不要求管理员权限。可选创建桌面快捷方式和加入 .md、.markdown 的“打开方式”，不会替换现有默认程序。

当前安装器没有商业代码签名，Windows 可能显示“未知发布者”或 SmartScreen 提示。请只从本仓库 Release 下载并核对 SHA-256。

Electron 下载受限时可临时使用镜像：

~~~powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
npm ci
~~~

## 项目结构

- electron/main.cjs：窗口、菜单、安全文件 I/O、恢复、目录扫描和转换 IPC
- electron/preload.cjs：隔离的最小渲染进程接口
- electron/conversion/：统一文档模型、格式读写、OCR 和外部引擎路由
- src/：中文界面、编辑器、预览与转换中心
- scripts/：构建、图标、打包和测试
- installer/cleanmark.iss：仅当前用户的 Inno Setup 安装器
- RELEASE_CHECKLIST.md：0.4.0 发布状态

## 开源许可

项目代码使用 [MIT](LICENSE) 许可证。第三方组件见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，贡献规则见 [CONTRIBUTING.md](CONTRIBUTING.md)。
