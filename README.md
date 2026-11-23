# Discussion curator

原生 JavaScript GitHub Action，运行于 Node.js 24，使用内置 fetch，无第三方运行时依赖，无需安装或打包。实现代码放在个人仓库，目标组织仓库只保存 workflow、项目规范与生成的 doc。

完整安装、配置示例、提示词与缓存机制、回复规则和排错说明见 **[详细使用指南](docs/guide.md)**。

图片、PDF、文本及 Office 附件的输入方式、私有附件权限和限额见 **[多模态说明](docs/multimodal.md)**。附件内容由脚本读取后发送，模型当前没有联网搜索工具。

机器人以独立 GitHub App 身份运行，首次部署先按 **[GitHub App 注册和安装指南](docs/github-app.md)** 配置。无需个人 PAT。

## 配置

目标仓库启用 Discussions，保留至少一个开放讨论分类（不是只允许维护者发帖的公告分类）。复制 `deploy/discussion-bot.yml` 到目标 `.github/workflows/`，将 Action 引用固定为发布的完整 commit SHA。复制 `.github/discussion-bot/rules.md` 到目标同路径，并按项目要求编辑。

目标仓库或所属组织的 Settings → Secrets and variables → Actions（组织级配置需授权目标仓库；Free 组织的私有仓库不支持使用组织级 Secrets/Variables，详见使用指南）：

| 类型 | 名称 | 内容 |
|---|---|---|
| Secret | LLM_API_KEY | 模型 API 密钥 |
| Variable | BOT_APP_CLIENT_ID | 必填，安装到目标仓库的 GitHub App Client ID |
| Secret | BOT_APP_PRIVATE_KEY | 必填，GitHub App 私钥 PEM 全文 |
| Variable | LLM_MODEL | 支持 JSON object 输出的模型名，必填 |
| Variable | LLM_BASE_URL | OpenAI 兼容接口根地址，默认 https://api.openai.com/v1 |
| Variable | BOT_CATEGORY | 汇总和上下文帖的分类名，建议 General |
| Variable | BOT_BLACKLIST | JSON，例如 `{"users":["someone"],"discussions":[12],"categories":["Off topic"]}` |
| Variable | BOT_SYSTEM_PROMPT | 系统提示词全文，优先于代码仓库的独立 Markdown 默认文件；留空则回退到文件 |

空黑名单默认为 `{}`。用户名忽略大小写，discussion 为数字编号，分类按名称精确匹配。黑名单用户不触发也不进入总结，所有 Bot 身份及机器人生成内容默认排除。上下文限定当前仓库与当前 App，拒绝人类、其他机器人及被其他身份编辑的记录。

## 行为

首次运行自动创建总结帖和固定介绍的上下文帖。脚本在处理成功后自动追加结构化记录，以仓库与源版本去重；历史记录不修改。主楼不进入模型输入，人类内容保留 user 角色、模型结果保留 assistant 角色，不提升为 system。不同仓库不拼接上下文。实际缓存命中与收益取决于服务商和最小输入长度，脚本只保证稳定前缀。

系统提示词独立放在 `.github/prompts/system.md`，业务规范来自目标仓库 `.github/discussion-bot/rules.md`。输入为完整板块有效帖子、评论和嵌套回复，支持分页。以分类 ID 的稳定哈希标识章节，同板块编辑原汇总回复；各章节正文包含稳定机器标记，字节级原样写入 `doc/discussions/<hash>.md`，无需模型输出第二份。没有内容变化不调用模型。删除、编辑、换分类会重新汇总，历史章节无来源时标记为空。

本次发言某一行以 `/ask` 开头时回答当前消息；问题不具体则确认收到并请对方说明。重大事实错误可按规范主动纠正。其余事件只维护总结。回复以源帖/评论 ID 为键更新，不追加重复回复。评论提问在对应评论线程内回答，主楼提问以一级评论回答。小时级对账和手工运行用于修复总结遗漏，不主动回复历史提问。

使用 GitHub App 的临时 installation token，限定当前仓库 Contents/Discussions write；默认 GITHUB_TOKEN 只负责 checkout。Bot 事件在 job 条件中排除。每仓库共享一个 job 并发组，`queue: max`、`cancel-in-progress: false`：同时只执行一个，最多 100 个等待任务，超过上限会被取消。不同仓库可并行。失败运行可重跑；此队列不是无限持久消息服务。

## 运行与限制

Actions → Discussion bot → Run workflow；选 init_only 只建立两个帖，不消耗 LLM。配好 API 后在普通板块创建测试帖，编辑原文、发 `/ask` 并检查 doc 与汇总评论。`npm test` 或 `node --test` 执行本地测试。

模型一次处理一个板块全部当前内容；为保留语义和稳定前缀不静默截断。大型仓库需选足够上下文窗口和 GitHub 单次请求额度；超限会失败并可重跑。模型没有联网验证能力，纠错可靠性受上下文证据限制。GitHub 评论和文件提交不是跨资源事务，失败时可能短暂不同步，重跑会修复。正文校验限制 55000 字符。不要在可信上下文或项目规范中放秘密。目标分支若保护禁止直接写入，需为机器人配置允许的写入策略或后续扩展 PR 模式。
