# 清墨（CleanMark）

清墨是一款从零独立开发的中文桌面 Markdown 编辑器，基于 Electron，适用于 Windows。项目不导入、执行或分发 Typora 的代码、ASAR、V8 字节码、资源或专有桥接实现。

[项目主页](https://github.com/ZuoXing-0504/MarkDown-Free) · [问题反馈](https://github.com/ZuoXing-0504/MarkDown-Free/issues) · 如果项目对你有帮助，欢迎点亮 Star。

## 功能

- 新建、打开、保存、另存为和文件夹树浏览
- 编辑、分屏、预览三种模式，GFM、表格、任务列表与代码高亮
- 撤销、重做、查找、格式工具栏、主题、字词与光标统计
- 可选自动保存、未保存关闭保护和崩溃草稿恢复
- 原子保存和外部修改冲突检测，避免静默覆盖其他程序的更改
- UTF-8、UTF-16 LE/BE、GB18030 和换行风格检测与保留
- 相对本地图片支持；远程资源默认完全阻止，点击后经主进程校验、限流并转为本地数据加载
- DOMPurify 清洗、Electron 沙箱、隔离上下文和受限 IPC

## 本地运行

需要 Node.js 22 或更新版本和 npm。

```powershell
npm ci
npm start
```

## 验证

```powershell
npm run check
npm run smoke
npm run test:e2e
```

端到端测试会真实创建和修改 Markdown 文件，覆盖打开、覆盖保存、另存为、自动保存、并发保存、恢复草稿、启动恢复选择、重新加载保护、撤销/重做、外部冲突、UTF-16/GB18030、二进制阻止、CRLF、相对图片、远程资源旁路、HTML 清洗和语法高亮。

## Windows 打包

构建便携应用：

```powershell
npm run package:win
```

构建中文安装器还需要 Inno Setup 6.7 或更新版本：

```powershell
npm run installer:win
```

本机输出文件为 `release/installer/清墨-0.3.3-安装程序.exe`；GitHub Release 为避免平台自动剥离中文文件名，使用 `CleanMark-0.3.3-Setup.exe`。安装器仅安装到当前用户的 `%LOCALAPPDATA%\Programs\清墨`，不需要管理员权限，可选创建桌面快捷方式和加入 `.md`、`.markdown` 的“打开方式”列表，不替换现有默认程序。正常卸载时可选择同时清除本地设置和恢复草稿。

生成文件不进入 Git 历史；本地构建会同时生成中文安装器、英文发布资产和 `SHA256SUMS.txt`。`v*` 标签会由 GitHub Actions 校验标签版本、重新安装测试并发布到 GitHub Release。

> 当前安装器没有商业代码签名，Windows 可能显示“未知发布者”或 SmartScreen 提示。请仅从本仓库 Release 下载并核对 SHA-256。代码签名需要开发者另行提供有效证书。

Electron 下载受限时可临时使用镜像：

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
npm ci
```

## 项目结构

- `electron/main.cjs`：窗口、菜单、安全文件 I/O、恢复和目录扫描
- `electron/preload.cjs`：隔离的最小渲染进程接口
- `src/renderer.js`：文档状态、预览、侧栏和交互
- `src/index.html`、`src/styles.css`：中文界面和主题
- `tests/fixtures`：真实 Markdown 流程测试数据
- `scripts`：构建、图标、打包和测试脚本
- `installer/cleanmark.iss`：仅当前用户的中文 Inno Setup 安装器
- `RELEASE_CHECKLIST.md`：当前版本发布状态和外部阻塞项

## 开源许可

项目代码使用 [MIT](LICENSE) 许可证。第三方组件许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。安全报告方式见 [SECURITY.md](SECURITY.md)，贡献规则见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 隐私说明

清墨不包含遥测或广告。未保存内容会以明文恢复草稿保存在当前 Windows 用户的应用数据目录中，并在成功保存或明确放弃后清除。远程图片默认不会联网；只有用户点击后，主进程才会加载公开 HTTPS 位图，并阻止私网地址、非常用端口、非图片响应和超过 10 MB 的内容。
