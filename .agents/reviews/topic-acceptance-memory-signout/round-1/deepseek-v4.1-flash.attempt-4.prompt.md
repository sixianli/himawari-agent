你是独立的方案设计者。
你能用的工具：read、grep、glob、websearch、webfetch，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。
下面只给了问题、目标和约束，没有给出任何人的方案；材料里如果提到某种做法，只作参考。先读代码弄清现状，再独立提出你认为最好的方案，不要假设已经有人想好了答案。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
输出格式：先列方案依赖的前提，每个前提附来源（文件:行或网址）和原话；再写方案本身、考虑过但不选的做法及原因、风险和反例、需要人拍板的取舍。把「读代码或来源证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 f0478c4de46347f87e23ff4d131e26f4c7f41d13。
问题、目标和约束：
# 问题：发布验收还没有覆盖“记忆的增、改、删”和“退出登录”

## 背景
Himawari 是 Andy 的个人 AI Agent 网页产品。每个上线包上线前，有一套“发布验收”：在测试机 Hermes 上把候选包装好、起真服务，用真 Chromium（Playwright）按剧本走 18 个场景，任何一个失败就不能上线（门槛 `scripts/delivery-mode/browser-acceptance-gate.py` 的场景名单，`deploy.sh` 和上线包脚本会读它）。剧本在 `test/integration/product-path-browser.test.ts`，验收环境在 `test/fixtures/product-path-harness.ts` 和 `test/fixtures/product-path-configuration.ts`，页面定位只写在 `apps/control-center/test/release-walkthrough-ui.ts`。

Andy 要求验收覆盖用户上线后真实能操作的所有入口。现在缺两块：记忆的增、改、删，以及退出登录。

## 目标
让发布验收真实走一遍“记忆增、改、删”和“退出登录”，正向和反向都要有（反向：给一个不该成功、不该触发的操作，期望结果为空或被拦下）；失败就拦下上线。

## 约束
- 不写死：地址、模型、账号名、文案都不能写死在测试里，从配置或页面取。
- 不碰生产机；Hermes 同一时间只能一个线程用。
- 不能花钱调付费大模型；验收里的模型是脚本化的假模型。
- 改登录方式属于大改动，方案要 Andy 同意后才动工。
- 密钥、令牌不进聊天和仓库。
- 测试不许用假替身替换业务逻辑（`npm run check:real-admission`）。
- 发给模型的内容只能往后追加（本任务不应碰到）。

## 已核对的事实
1. 生产的登录方式是 Cloudflare Access（邮箱验证码），配置 `identity.kind` 是 `cloudflare-access`。来源：`docs/runbooks/production-web-entry-runbook.md:63` 原话“生产配置：…`identity.kind` 是 `cloudflare-access`”。内置账号（密码 + TOTP）是 Access 坏了时的退路：同文件 148 行“退回自带登录（Access 本身坏了、短期修不好时）：旧配置的 … `identity.kind` 是 `built-in`”。
2. 验收环境现在模拟的是 Access：自签 JWT、本机假发行方提供 `/cdn-cgi/access/certs` 和 `/cdn-cgi/access/get-identity`（`test/fixtures/product-path-harness.ts` 的 `handleProvider`；配置见 `test/fixtures/product-path-configuration.ts:98` 起的 `identity`）。
3. 网页设置里的“退出登录”只在内置账号时显示：`apps/control-center/src/app.tsx:559-562`，`settingsAccount={configuration && identityMethod === "built-in" ? (<SignOutSetting …/>) : undefined}`。所以生产（Access）的设置里现在没有退出登录入口。周报里有一处“重新登录”按钮直接跳 `/cdn-cgi/access/logout`（`apps/control-center/src/components/weekly-report.tsx:1085`）。
4. 内置账号的退出调用 `accountRequest("logout", …)`（`apps/control-center/src/components/sign-out-setting.tsx:21`）；账号只能用停机管理命令 `admin-cli account create` 建，凭据经私有文件传入（`apps/admin-cli/src/account-command.ts`），要求配置 `identity.kind` 为 `built-in`；接口层已有测试 `test/integration/built-in-identity.test.ts`（真密码、真 TOTP、会话过期和撤销），但不经浏览器。
5. 记忆页有“添加”“编辑”“删除”，删除后“7 天内可在‘最近删除’里恢复”（`apps/control-center/src/i18n/resources/zh-CN.ts` 的 `memory.page.add`、`memory.editAction`、`memory.deleteAction`、`memory.page.deleted`）。现在验收的 `accept-memory-page` 场景只打开记忆页、看计数、无报错（`test/integration/product-path-browser.test.ts` 搜 `accept-memory-page`）。
6. 删除对话、批准某些操作需要“最近认证”（5 分钟内登录过），Access 时指 Access 登录时间（`docs/runbooks/production-web-entry-runbook.md` 的“最近认证”一条）。

## 一手资料
- Playwright 官方：登录一次存 `storageState` 给其他测试复用；改服务端状态的测试建议每个并行 worker 一个账号；需要不带登录态时可以在测试文件里重置 storage state。https://playwright.dev/docs/auth
- Cloudflare 官方：访问 `<应用域名>/cdn-cgi/access/logout` 退出，“This action revokes the user's session across all applications”，并立即清掉浏览器里的授权 cookie，已发出的令牌约 20–30 秒后失效。https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/
- ChatGPT：头像 → Settings → Security → “Log out all”，当前会话立即结束。https://help.openai.com/en/articles/9243857
- Claude：网页版 Settings → Account 可以退出所有会话。https://support.claude.com/en/articles/10310342

## 请回答
1. 记忆增、改、删和退出登录分别应该在哪种登录方式下验收，为什么；要不要额外起一个内置账号的验收环境。
2. 生产（Access）设置里没有退出登录，这是该补的产品缺口，还是不该补；补的话怎么做、怎么验收。
3. 每个场景的正向和反向用例具体怎么设计，怎样做到不写死。
4. 这些做法是治根还是治标；有哪些风险或漏掉的情况。
