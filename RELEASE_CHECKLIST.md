# 清墨 0.4.0 发布清单

## 转换功能

- [x] Markdown、DOCX、PDF、PPTX 共 12 个跨格式方向
- [x] 当前编辑器内容快照和单个外部文件
- [x] 可编辑与视觉保真两种模式
- [x] Markdown 转 PPT 的分隔线、标题分页和自动拆页
- [x] DOCX/PPTX 内置读取与生成
- [x] PDF 文本提取、页面渲染和内置 PDF 生成
- [x] 简体中文、英文 OCR 语言包按需下载
- [x] OCR 固定大小和 SHA-256 校验
- [x] Microsoft Office、LibreOffice、Pandoc、内置转换器能力路由
- [x] .doc、.ppt 在 Office/LibreOffice 可用时读取
- [x] 转换进度、取消、超时、覆盖确认和转换报告
- [x] Markdown 图片资源目录成组提交和回滚

## 安全与隐私

- [x] 文档与 OCR 全程本地处理，不上传文档
- [x] 外部输入和输出路径必须经原生文件对话框授权
- [x] 100 MB、500 页/幻灯片、OCR 200 页限制
- [x] DOCX/PPTX 解压大小和单项大小限制
- [x] PDF 页面、像素、图片数量及总大小限制
- [x] 危险链接协议、SVG 脚本、事件、DOCTYPE 和外部资源过滤
- [x] 远程图片默认关闭并通过现有安全通道加载
- [x] Office 只读打开、禁用宏、更新链接和交互提示
- [x] 外部程序使用参数数组启动
- [x] 独立临时目录、原子输出和失败清理
- [x] 隐私、转换质量、安全和第三方许可说明

## 自动测试

- [x] npm run check
- [x] npm run test:conversion:modules
- [x] npm run test:ocr
- [x] npm audit 为 0 个已知漏洞
- [x] 重新执行 npm run smoke
- [x] 重新执行编辑器 npm run test:e2e
- [x] 重新执行完整 npm run test:conversion
- [x] Office COM 本机发布检查（Word/PPT 直接导出 PDF 通过；PDF 重排失败时按设计降级）
- [x] 便携版 Sharp、Canvas 原生模块和 Office 脚本检查
- [x] 安装版冒烟、编辑器 E2E、转换 E2E 和卸载检查

## 构建与发布

- [x] package.json、锁文件和安装器后备版本统一为 0.4.0
- [x] Office PowerShell 脚本配置为 app.asar.unpacked
- [x] CI 和 Release 工作流包含模块测试和完整转换 E2E
- [x] 当前用户中文安装器和英文 GitHub 发布文件名
- [x] SHA-256 清单生成与一致性验证
- [x] 生成 清墨-0.4.0-安装程序.exe
- [x] 生成 CleanMark-0.4.0-Setup.exe
- [x] 核对 SHA256SUMS.txt
- [x] 安装器体积记录：148,052,188 字节（约 141.2 MiB）
- [ ] Windows 代码签名（需要有效代码签名证书）
- [x] 提交并推送 0.4.0 源码
- [x] 创建并推送 v0.4.0 标签
- [ ] 核对 GitHub Release 安装器与 SHA-256

## 暂不纳入 0.4.0

- 批量转换和文件夹递归
- 云端转换、协作编辑和自动同步
- 宏、动画、视频和复杂嵌入对象的可编辑还原
- 自动更新
- macOS/Linux 安装包
