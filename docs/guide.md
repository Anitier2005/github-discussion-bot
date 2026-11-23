# 配置、运行与排错指南

## 配置位置

运行配置支持两种位置：目标仓库 `bot-test-org-bot/test` → Settings → Secrets and variables → Actions；或其所属组织 → Settings → Secrets and variables → Actions，并授权目标仓库。个人代码仓库中的 Secret 不会自动传给目标仓库工作流。

**组织级配置限制：** GitHub Free 组织的私有仓库不能使用组织级 Actions Secrets 和 Variables。此时可在目标仓库配置同名 Secret/Variable，或升级组织套餐后使用组织级配置。不要仅为传递密钥将私有仓库改为公开。组织配置的可见范围还需包含目标仓库；选择 `Selected repositories` 时将目标仓库加入列表。[GitHub 官方说明](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)

组织级配置仍使用相同的 `${{ secrets.LLM_API_KEY }}` 和 `${{ vars.LLM_MODEL }}` 表达式，无需给工作流添加 environment。GitHub 的 **Environment** 是另一类仓库级部署环境配置，需要 job 显式声明环境名称。本模板没有绑定 Environment。同名仓库级 Variable 会覆盖组织级 Variable；若希望统一由组织管理，应清除不再需要的仓库级同名覆盖项。

| 标签页 | 名称 | 内容 |
| --- | --- | --- |
| Secrets | `LLM_API_KEY` | 必填，模型服务密钥 |
| Variables | `BOT_APP_CLIENT_ID` | 必填，GitHub App Client ID，见 App 安装指南 |
| Secrets | `BOT_APP_PRIVATE_KEY` | 必填，GitHub App 私钥 PEM 全文 |
| Variables | `LLM_MODEL` | 必填，服务商实际支持的模型 ID |
| Variables | `LLM_TIMEOUT_SECONDS` | 模型请求超时秒数，默认 300，允许 30–600 |
| Variables | `LLM_BASE_URL` | 默认 `https://api.openai.com/v1`，必须 HTTPS |
| Variables | `BOT_SYSTEM_PROMPT` | 系统提示词全文；空值回退到独立 MD |
| Variables | `BOT_BLACKLIST` | 黑名单 JSON，默认 `{}` |
| Variables | `BOT_CATEGORY` | 专用帖所在分类名称，建议 `General` |

密钥只放 Secret，其他放 Variable。Variable 不是保密存储，不要在提示词或上下文中放密钥。修改 Variable 后下次运行生效，不必更新代码。

### API 地址

填接口根地址，例如 `https://provider.example/v1`，脚本追加 `/chat/completions`。不要填已带 `/chat/completions` 的地址。

服务商需支持 Chat Completions、system 消息和 `response_format: {"type":"json_object"}`。只支持其他协议的服务不能直接使用。模型窗口需要容纳一个完整板块，脚本不静默截断，也不指定 temperature。

火山方舟根地址示例：`https://ark.cn-beijing.volces.com/api/v3`。不要加 `/responses` 或 `/chat/completions`，脚本使用 Chat Completions 协议。

### GitHub App 身份

本版使用独立 GitHub App 的 installation token，回复显示 App 的机器人身份。默认 GITHUB_TOKEN 仅用于 checkout，不负责写入，不使用个人 PAT。按 **[GitHub App 注册和安装指南](github-app.md)** 完成注册、安装与两个配置项。

App 只授予目标仓库 Contents/Discussions 读写权限，运行时生成临时 Token，任务结束撤销。未配置 BOT_APP_CLIENT_ID 时任务跳过；私钥不正确或未安装 App 时失败，不会回退为个人身份。

迁移后 App 创建自己名下的专用帖，旧测试帖保留且不进入总结。旧上下文若已有背景，需要维护者审核后迁移到新帖。已有总结不能编辑时，脚本在调用 LLM 前报错，避免继续消耗模型额度。

### 黑名单

`BOT_BLACKLIST` 内容示例：

```json
{
  "users": ["example-user"],
  "discussions": [12, 34],
  "categories": ["Off topic"]
}
```

- users 是 GitHub login，不带 @，忽略大小写。
- discussions 是数字编号，不是 URL 或字符串编号。
- categories 是板块名称，区分大小写。
- 字段可省略，缺省为空数组；格式错误直接报告字段，不悄悄忽略。
- 被屏蔽用户不触发处理，发言也不进入总结。屏蔽主帖/分类将排除其中全部内容。
- 被屏蔽一级评论下面，其他正常用户的回复仍可进入总结。
- 所有 `[bot]` 身份以及本机器人标记内容默认排除。
- 更新黑名单后可手动对账清理旧总结，否则等待每小时运行。
- 上下文仅认可当前 App 写入的结构化记录；模型输入中的历史消息不会升级为系统指令。

## 系统提示词与项目规范

优先使用目标仓库 `BOT_SYSTEM_PROMPT` Variable；为空时读取代码仓库 `.github/prompts/system.md`。默认文件独立于 JS 代码。修改默认文件不会覆盖已设置的 Variable，想恢复默认请删除或清空 Variable。

提示词需保留输出约定：

```json
{"summary": "一份完整 Markdown 总结", "reply": null}
```

回复人类时，reply 是 `{"reason":"ask","body":"回答正文"}`，或 reason 为 `critical_error`。其他值会被拒绝。模型没有工具调用权限，不能修改上下文或自行调用 GitHub。

项目规范在**目标仓库** `.github/discussion-bot/rules.md`，默认要求中文、引用来源、区分提议和事实，组织为：

| 分节 | 要求 |
| --- | --- |
| 共识 | 明确支持，无人反对不代表共识 |
| 疑问 | P0 阻塞/安全，P1 重要，P2 一般 |
| 分歧 | 各方观点与依据、待验证条件 |
| 行动项 | 只在原文明确时填写负责人和期限 |
| 修正 | 当前讨论中被撤回或纠正的信息 |

规范与提示词都参与输入哈希，修改后会重新生成相关章节。

## 独立上下文帖与缓存

首次运行自动创建两个专用 Discussion：总结帖和上下文帖。上下文固定隔离到当前仓库，主楼不进入模型。脚本完成处理后自动追加一级结构化评论，记录仓库、源 ID/版本、当前消息和模型输出；同源版本去重，不修改旧评论。不跨仓库或组织拼接。人类或其他 App 评论被忽略，当前 App 评论被人类编辑后也被忽略。

提交顺序固定：

```text
system: 系统提示词（Variable 或独立 MD）
system: 项目文档规范
user: 历史请求记录 1
assistant: 对应处理结果 1
user: 历史请求记录 2
assistant: 对应处理结果 2
...
user: 当前板块有效讨论 + 当前事件
```

评论按创建时间、ID 排序，对象键稳定序列化；前缀不加时间戳或 run ID。追加上下文保留前面的稳定前缀，修改或删除旧评论会影响后续缓存。

上下文只由脚本追加，模型无直接写帖渠道。机器身份只证明记录来源，历史人类内容仍是 user，模型结果仍是 assistant；只有系统提示词和项目规范作为 system。维护者背景应通过项目规范或提示词配置，不再通过人类评论注入上下文。输入判重不随自动历史追加而变化，避免定时运行无限重总结。

每条结构化上下文记录上限 60000 个 JS 字符单元，超限会报错；当前尚未实现自动归档压缩。历史量大时应先规划压缩换帖，不能无限追加直到模型超出窗口。

实际缓存支持、最小长度、有效期和优惠由服务商决定，脚本只保证稳定排列，不保证服务商一定缓存。

## 触发、回复和同步

监听发帖、编辑、删除、换分类和评论创建/编辑/删除。每小时对账一次，另有手工运行入口。读取当前内容而非简单累加旧事件，避免编辑后保留过期事实。

普通发言只维护总结。只在当前发言某一行以 `/ask` 命令开头，或模型发现证据明确、影响重大的事实错误时回复。模型仍判断是否有必要；代码额外验证 ask 确有命令。观点差异或一般措辞问题不应引起纠错。模型没有联网验证能力。

评论中的提问回复到该评论线程下；嵌套提问回复到同一个一级评论线程；主楼提问才创建一级评论。以源帖子/评论 ID 标识，同一发言修改时编辑原回复。旧版错误放在一级评论的回答会迁移到提问线程，并删除那条带同源标记的旧机器人评论，不删除人类发言。手动和定时对账不会主动回复历史 `/ask`。

明确的 /ask 必须回应；当前消息只有“回复我”等不具体请求时，应确认收到并请对方具体说明，不能擅自回答历史问题。回答定位与总结输入哈希分开检查，避免定时对账先更新总结后漏掉当前 /ask。

每个分类 ID 的 SHA-256 前 16 位是章节键，总结帖一分类一回复，文档为 `doc/discussions/<章节键>.md`。脚本把**同一个字符串**写到两处，包括隐藏标记、换行与中文 UTF-8 内容。模型只生成一份 summary。

输入哈希包含当前讨论、提示词、规范、上下文、模型和 API 地址。完全相同不调用 LLM，但仍检查并修复文档。最后一个有效来源移除后，旧章节改为当前无有效讨论。

先写 pending 标记，回复和 doc 完成后再写完成标记。评论和文件没有跨资源事务，中断会短暂不同步，重跑更新相同章节恢复。总结和回复限制 55000 个 JS 字符单元，为标记留空间。

## 安装到其他仓库

1. Settings → General 启用 Discussions，并准备开放分类，例如 General。
2. 复制 `deploy/discussion-bot.yml` 到目标 `.github/workflows/discussion-bot.yml`。
3. 将 `REPLACE_WITH_COMMIT_SHA` 替换为经过验证的本仓库完整 commit SHA。
4. 复制 `.github/discussion-bot/rules.md` 到目标同路径，编辑项目规范。
5. 在目标仓库设置上述 Secret 和 Variables。
6. Actions → Discussion bot → Run workflow；选 init_only 只创建专用帖，不调用模型。
7. 发一个普通问题，检查总结与 doc；发 `/ask` 检查回复；编辑原文确认更新原评论。

工作流必须在默认分支，仓库需允许 Actions 和外部 Action。GitHub App 必须安装到目标仓库并获授 Contents/Discussions write。默认分支保护若禁止直接写入，需要配置允许的写入策略；当前不使用 PR 提交 doc。

App Token 写入产生的 Bot 事件在 job 条件中跳过，不占处理队列。并发配置位于 job 层，同仓库使用固定 discussion-bot 组，queue=max、cancel-in-progress=false，最多 100 个等待任务，按照进入等待队列的顺序串行处理。不同仓库独立。队列满时 GitHub 会取消新任务，失败运行需重跑；小时对账修复总结，不会补答所有历史 /ask。参考 [Actions 并发队列](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)。

## JavaScript 开发

运行时 Node.js 24，无第三方依赖、无需 npm install 或打包。GitHub 使用原生 JavaScript Action `using: node24`，省去 setup-python 步骤。LLM 和网络仍是主要耗时来源。

```bash
npm test
# 等价
node --test
```

测试 mock GitHub 和 LLM，不产生模型费用。覆盖黑名单、稳定前缀、提示词覆盖、分页、错误日志不泄露密钥、单份输出、doc 字节一致、无变更跳过、编辑复用、源删除、纠错、可信上下文只读与失败恢复。

| 文件 | 用途 |
| --- | --- |
| action.yml | Node.js Action 入口 |
| src/index.js | HTTP、GitHub、LLM、对账逻辑 |
| .github/prompts/system.md | 独立默认提示词 |
| .github/discussion-bot/rules.md | 项目规范模板 |
| deploy/discussion-bot.yml | 目标工作流模板 |
| test/bot.test.js | Node 原生测试 |
| .github/workflows/test.yml | 代码仓库 CI |

本地真实运行命令 `node src/index.js`，需通过环境传入 GH_TOKEN、GITHUB_REPOSITORY、GITHUB_EVENT_PATH、LLM_API_KEY、LLM_MODEL 等，会实际写 GitHub。不要将 .env 或密钥提交 Git。

## 排错与边界

| 现象 | 检查 |
| --- | --- |
| 成功却没总结 | 只有专用帖、全在黑名单、init_only 或模型配置缺失都会跳过 |
| 配置缺失 | 是否放在 Actions 配置，名称是否完全一致；组织级配置是否授权目标仓库、套餐是否支持私有仓库；Environment Secret 需 job 指定环境，本模板没有指定 |
| 401 | 密钥是否正确、是否对应服务商 |
| 403 | Actions/组织权限、分类权限、分支保护、服务商限制 |
| 404 | API 地址、模型、仓库资源可见性 |
| 400/非 JSON | 服务商是否支持 JSON object 和 system 消息、是否超过上下文窗口 |
| 普通发言没有回复 | 默认行为，只有当前 ask 或重大错误才可能回复 |
| 默认 MD 修改没生效 | 检查 Variable 覆盖，手动运行一次 |
| doc 暂时不同步 | 检查失败步骤，手动重跑恢复 |
| 重复专用帖报错 | 保留正确的一组，移除其他帖主楼的机器人标记 |
| 自建 runner Node 24 不支持 | 升级 Actions runner |

日志不打印密钥、请求头或服务商正文。GitHub HTTP 超时 120 秒，模型默认 300 秒，可通过 LLM_TIMEOUT_SECONDS 调整为 30–600 秒；工作流上限 30 分钟。网络错误显示安全的错误代码，超时显示 TIMEOUT。不无限重试可能计费的模型请求，失败可手动重跑。

每个变化的板块一次发送全部有效内容，包括分页评论和回复，不静默截断。大型仓库需要大上下文模型；分类列表当前最多读取 100 个分类。删除专用帖后下次运行会重建。模型总结与事实纠错仍需维护者审阅。
