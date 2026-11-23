# GitHub App：独立机器人身份

工作流使用 GitHub App installation token 操作仓库，评论作者显示为 `<App slug>[bot]`。不使用个人 PAT，不需要 `BOT_GITHUB_TOKEN`。默认 GITHUB_TOKEN 仅用于 checkout 读取，不承担机器人写入。

## 1. 注册 App

打开这个[预填注册页面](https://github.com/organizations/bot-test-org-bot/settings/apps/new?name=bot-test-discussion-curator-2005&url=https%3A%2F%2Fgithub.com%2FAnitier2005%2Fgithub-discussion-bot&public=false&webhook_active=false&contents=write&discussions=write)。它为组织创建私有 App，预选两项权限。注册需要 GitHub 的交互登录；如果页面无权限，需由组织所有者或获授权的 App 管理员完成。

核对字段：

| 字段 | 填写 |
| --- | --- |
| GitHub App name | 可用的独立名称，例如 bot-test-discussion-curator-2005；重名则调整 |
| Homepage URL | `https://github.com/Anitier2005/github-discussion-bot` |
| Callback URL / Setup URL | 留空，不使用用户 OAuth |
| Request user authorization during installation | 不勾选 |
| Webhook → Active | 不勾选；事件由仓库 Actions 处理，不需要外部服务器 |
| Repository permissions → Contents | Read and write：读取规范，提交 doc |
| Repository permissions → Discussions | Read and write：读讨论，创建/编辑总结和回复 |
| Metadata | 自动 Read-only |
| 其他权限和事件订阅 | 不添加 |
| Where can this GitHub App be installed? | Only on this account（组织内使用） |

点击 Create GitHub App。App 只注册不安装时还没有仓库访问权。

## 2. 生成私钥并安装

1. App 的 General 页面复制 **Client ID**，通常以 `Iv` 开头。工作流使用 Client ID，不是 Client secret，也不是个人 PAT。
2. 在 Private keys 区域点 **Generate a private key**，下载 `.pem` 文件。
3. 左侧 **Install App** → 组织 `bot-test-org-bot` → **Only select repositories** → 选 `test` → Install。
4. 如果组织提示批准请求，先由组织管理员批准。安装范围保持只选测试仓库。

## 3. 设置两个运行配置

打开[目标仓库 Actions 设置](https://github.com/bot-test-org-bot/test/settings/secrets/actions)：

| 标签页 | Name | 内容 |
| --- | --- | --- |
| Variables → New repository variable | `BOT_APP_CLIENT_ID` | 上一步的 Client ID |
| Secrets → New repository secret | `BOT_APP_PRIVATE_KEY` | `.pem` 文件的完整文本，包含 BEGIN/END 行及真实换行 |

不要填 Client secret，不需要存储安装 Token。密钥不要发到聊天、Issue 或 Discussion，不要提交源码。组织级配置也可用，但 Free 组织的私有仓库要使用仓库级配置。

既有 LLM_API_KEY、LLM_MODEL、LLM_BASE_URL、BOT_SYSTEM_PROMPT、BOT_BLACKLIST、BOT_CATEGORY 保持原配置。旧 BOT_GITHUB_TOKEN 不再读取；如果曾创建个人 PAT，请删除 Secret 并在个人设置撤销 PAT。

## 4. 运行与迁移

Actions → Discussion bot → Run workflow，先可选 init_only 建立新 App 名下的总结帖和上下文帖。再在普通板块发测试问题、/ask 并编辑原文，确认回复作者是 App。

旧 github-actions 测试帖保留，新的 App 不尝试编辑旧身份的帖。脚本依据 App slug 和帖子标记选择自己的帖子；旧帖子也不会进入总结。若旧上下文帖中已有维护者背景内容，需要审核后复制到新 App 上下文帖的一级评论。当前迁移不会自动把旧评论当作新 App 的可信背景。

App 的专用帖可能获得新编号，以首次运行后实际创建的链接为准，不能继续假定 #1/#2 是活动入口。

Client ID 未配置时 job 会跳过，不调用模型；配置了 ID 但私钥缺失/格式错误时，Token 步骤失败，机器人不会改用个人身份。

## 5. 权限与凭证生命周期

官方 `actions/create-github-app-token`（固定 SHA）在 job 开始生成 installation token，显式限制为当前仓库的 Contents/Discussions write。Token 最多有效一小时，job 完成后默认撤销；本工作流上限 30 分钟。私钥用于签发临时 Token，并不是个人账户登录凭证。

App Token 的写入会触发 GitHub 事件。脚本通过 Bot 类型、生成标记、专用帖 ID 排除自触发，内容不变时也不会再次调用模型。不要打开用户 OAuth 以代替安装 Token，否则身份语义不同。

若权限后来修改，需要组织批准安装的新权限。App 卸载、暂停、私钥删除或安装未包含 test 会让 Token 步骤失败。私钥轮换时先更新同名 Secret 并验证，再删除旧私钥。

## 6. 排错

| 现象 | 检查 |
| --- | --- |
| 整个 job skipped | BOT_APP_CLIENT_ID 是否设置在目标仓库 Variables |
| Private key missing / invalid | 是否将完整 PEM 放在 Secret BOT_APP_PRIVATE_KEY，保留头尾与换行 |
| Installation not found / 404 | App 是否安装到 bot-test-org-bot，且授权了 test |
| Permission denied / 403 | App 是否有 Contents/Discussions write，安装是否已批准新权限 |
| 新 App 无法编辑旧回复 | 旧回复属于其他身份，使用 App 自己创建的专用帖 |
| 回复仍显示个人账号 | 检查部署是否使用本版模板，不应存在 BOT_GITHUB_TOKEN 回退 |

官方参考：[App 注册参数](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-using-url-parameters)、[官方 Token Action](https://github.com/actions/create-github-app-token)。
