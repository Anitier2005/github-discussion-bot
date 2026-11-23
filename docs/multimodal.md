# Discussion 图片与附件

脚本识别正文、评论和嵌套回复中的 Markdown 图片/附件链接、HTML img 的 src 以及 GitHub 附件裸链接。黑名单与机器内容在附件处理前排除。

| 类型 | 当前处理 |
| --- | --- |
| PNG/JPEG/GIF/WebP | 下载真实字节，作为 image_url 的 data URI 发给视觉模型 |
| PDF | 下载后通过 Chat API file 模态传入；模型/服务商需支持 PDF 输入 |
| TXT/Markdown/CSV/TSV/JSON/日志/YAML | 提取 UTF-8 文本 |
| DOCX/PPTX/XLSX | 有界解压 OOXML 提取文本，不执行宏、不运行文件 |
| 音频、视频、压缩包、旧 DOC/XLS、其他二进制 | 当前标注 unsupported_format，不声称已经理解 |

Word/PPT 的版式、嵌入图片和 Excel 公式计算不在文本提取范围内；PDF 的视觉与扫描识别由模型服务负责。当前测试火山方舟使用 Chat Completions 的 image_url 和 file 输入。其他 OpenAI 兼容服务可能仅支持图片，PDF 不兼容会由接口报错，不悄悄转为空白文件。

## 私有附件与权限

不会仅把私有 URL 交给模型碰运气。脚本先读取字节，再发送图像/文档数据。GitHub Token 只发送给初始 GitHub user-attachments 路径，或当前仓库的 Contents API；重定向不携带 Token。当前仓库 raw/blob 文件链接转换成 Contents API 读取，支持私有仓库，不读取其他仓库的私有文件。

GitHub 个别私有附件端点不支持 installation token，或签名已过期时，仍可能无法下载。这种情况会在 attachments 中记录 http_404 等未读取状态，并要求模型说明，不能保证任意登录后可见的附件都可被 App 下载。

默认允许 GitHub 的附件、raw 和常见存储域名。额外可信文件域名在目标仓库 Actions Variable `BOT_MEDIA_HOSTS` 中用逗号分隔添加，例如 `files.example.org`。不开放任意主机；只接受 HTTPS，DNS 地址检查并固定到公网 IPv4，拒绝本机/私网地址、嵌入用户名密码和非 443 端口。每次重定向重新检查域名与地址。

## 限额与上下文

每板块最多读取 12 个不同附件，单文件最多 8 MiB，总计 20 MiB；单文件最多 4 次重定向、30 秒下载等待。文本最多 40000 字符，截断会明确标注。Office 解压限额为单 XML 2 MiB、累计 4 MiB、2000 个 ZIP 条目。

附件内容的 sha256 与读取状态参与输入判重，同 URL 内容变化也能触发更新。模型输入中每个附件前带源评论 ID、原链接和摘要校验值，避免回答串图。图和文档里的文字始终是不可信数据，不提升为系统指令。

上下文帖保存附件来源、读取状态、hash 及模型的文字结论，不把大段 base64 写入评论。图像/PDF 实体在当前请求发送；下一次需要时由脚本重新读取。总结与 doc 仍使用同一个 Markdown 字符串，模型不输出第二份。

## 联网搜索边界

附件下载不等于联网搜索。当前没有向模型提供搜索引擎工具，也不会让模型任意浏览网页。普通网页链接不自动当作附件抓取；未传入的网页内容不能作为已核实证据。

参考：[火山方舟 Chat API](https://docs.volcengine.com/docs/ark/chat-api?lang=zh)、[文档理解](https://docs.volcengine.com/docs/ark/document-understanding?lang=zh)。
