你是方案里“关于代码和文档现状的说法”的核对者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
下面是一份还没合并的方案或 ADR。第一步，把其中每一句讲代码或仓库文档现状的话都列出来：某个文件、函数、字段、配置、命令、数字、规则现在是什么样、做什么、不做什么；一句话里有几个说法就拆成几条。方案打算新增或修改什么，不算现状；讲外部网站、第三方产品的话也不算。第二步，逐条自己打开对应的文件核对，给出：一致、不一致、找不到（仓库里没有这个东西，或没读到能证明它的内容）。方案里讲“原来”“已删除”“改之前”的旧代码，在材料里给出的基线提交里找：证据位置写成 文件:行@完整提交哈希，代码原文取自那个提交里的文件；这样写只限于当前提交里已经没有这段原文的旧代码，讲现状的句子仍然用当前提交里的文件和行。材料里的说法可能有错，写得再肯定也不能因此判一致；没有亲自读到对应代码，就判找不到。只核对事实，不评价方案好不好，不提建议。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
输出格式：每个说法单独一行，不换行，字段之间用竖线分隔，行首写 CLAIM：
CLAIM|<序号>|<一致 或 不一致 或 找不到>|<文件:行 或 文件:行@完整提交哈希>|<方案原句>|<代码原文>
序号用 1、2、3……，不重复。文件:行 写你读到证据的那个文件和行号，例如 packages/x/src/y.ts:42；找不到时写 -。代码原文必须是你亲自读到的、逐字摘抄的一行或几行，不要改写、不要概括；方案原句里的竖线字符换成全角的“｜”，代码原文里的竖线照原样写。列完所有 CLAIM 行之后，另起一段，用一两句话写你没能核对的部分。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 a206674dd79a58f8dfc652fcfdcf99cac0f99245。
本 PR 的基线提交是 891955719fb913e9860392207b70e5aef0055ecf（main 与 a206674dd79a58f8dfc652fcfdcf99cac0f99245 的共同祖先）。
待核对的方案：
方案文件：.agents/evidence/secret-vault/plan-v3.md（在提交 a206674dd79a58f8dfc652fcfdcf99cac0f99245 里的内容）

# 密钥保险箱：让 Himawari 用你的密码办事，模型看不到值（方案 v3）

## 一句话
Himawari 自带一个保险箱，你在 iPhone 上存密码、银行卡密码、API key、两步验证密钥。她只知道“有哪几项、每项能用在哪个网站”，要用时只说用哪一项；值由程序在最后一步、核对目的网站之后填进去，模型、记忆、对话记录、日志里都没有值。每次办事前你在 iPhone 上用 Face ID 批准一次。

## 先回答两个问题
**ChatGPT、Claude 遇到同样的事怎么做，用户看到什么？**
- ChatGPT agent：要登录时停下来，让你自己接管浏览器输密码，模型看不到（https://help.openai.com/en/articles/11752874）。用户看到的是“请接管”。
- Claude + 1Password：Claude 只看到条目名字、用户名和网址，说要用哪一项；1Password 自己解密并填进去，只填进网址匹配的页面；每次放出都要你在 1Password 里批准，没有长期授权，换一次会话就重新问；提交失败把填过的值清掉（https://support.1password.com/1password-claude-security/）。用户看到的是一个批准弹窗。
- 本方案照 1Password 的做法，只是保险箱在你自己的服务器上，批准在 iPhone 上。

**这是根因还是表面修补？**
根因。问题的本质是“值不能进模型”，所以替换只能发生在模型之外、值被使用的最后一步，并且绑定目的地。现在的做法是“你说记住就存成敏感记忆”（ADR 0185），值会进记忆、进模型，本方案取代它。

## 你会看到什么
1. iPhone 设置里新增“保险箱”：新增一项时填名字（例如“招商银行网银”）、每个字段（用户名、密码、取款密码、API key、两步验证密钥）、能用在哪些网站。值只能存和替换，存完任何地方都不再显示。
2. 你在对话里说“帮我登录招商银行看看余额”，她找到对应的项，iPhone 弹出卡片：“这次办事要用：招商银行网银（ebank.cmbchina.com）”，Face ID 批准一次，这次办事里就不再问。
3. 她填完、登录完，只告诉你结果。付款、转账这类不可撤销的动作，照现有规则单独再问。
4. 保险箱页能看到每项最近什么时候、用在哪个网站、成功没有。

## 怎么做
1. **存放**：服务器上单独存。值用仓库已有的信封加密代码（packages/platform-node/src/payload-protector.ts，AES-256-GCM）加密，专用主密钥放主机密钥源，不和数据库放一起。值的数据等级定为“受限”，永远不发给任何模型或外部服务。
2. **录入只在 iPhone**：值经已配对的设备通道发给服务器，iPhone 不留副本。苹果“密码”里的内容不能被别的 App 读，只能复制粘贴进来（系统自动填充只推荐 App 自己网站的密码，https://developer.apple.com/documentation/security/password-autofill）。聊天里打的密码不进保险箱，她会提醒你改在保险箱里存。
3. **她怎么指名**：只读工具列出每项的编号、名字、字段（字段编号、显示名、类型）、能用的网站，排序固定，不含值和时间。工具定义固定不变，所有新工具一次加齐。
4. **值在哪里填进去**：
   - **网页登录、填表**：新做浏览器工具，在隔离沙箱里跑（ADR 0031）。浏览器驱动用 Playwright；找哪个是密码框用 Stagehand（Browserbase 出的 TypeScript 开源库，MIT 许可证，v4.4.0）的 observe，它调模型的部分走我们自己的模型出口，只用本地浏览器、关掉它的云服务和遥测。找到的输入框由程序核对：可见、在顶层页面、同网站、类型对；iframe 和 Shadow DOM 里的一律不填。填值期间拦下页面发往别的网站的所有请求，不给模型看页面；填完或失败后清掉页面上的值，再让她看页面。接到现有的“先准备、执行前核对页面没变”的机制上（packages/application/src/services/web-capability-service.ts）。
   - **API 请求**：不做“任意发请求”的工具。由程序代发，只许 https、不跟跳转、只连公网地址、key 只能放在登记的请求头或请求体里、不许放进网址、响应有大小和时间上限；有后果的请求走“先准备、再执行”，带防重复。
   - **沙箱程序**：只给事先审查过的能力程序，程序的输出和文件都遮掉用过的值，网络只许去它要访问的网站。模型自己写的脚本拿不到值。
5. **防骗**：网站绑定由你定、她改不了；程序按浏览器里真实地址核对，不信她给的网址；回到她那里的页面和响应，把值的原样和常见编码（URL 编码、base64、十六进制、JSON 转义）都遮掉；错误只返回固定代码。
6. **两步验证**：存种子，程序当场算 6 位码填进去，种子和码都不进模型、不落库。
7. **说清楚防得住什么**：防得住模型、对话记录、记忆、日志、单独被拿走的数据库泄露值；防不住整台服务器被人完全控制（攻击者能拿到主密钥）。值填进允许的网站之后，那个网站自己的页面能读到，这是登录本身固有的（1Password 也这样写）。
8. **主密钥**：备份里只有密文；主密钥另存一份离线备份，可轮换（已有的 rewrap 代码）。主密钥不可用时所有保险箱操作停止，不回退明文。

## 开源怎么用
| 项目 | 许可证 | 状态 | 用法 |
|---|---|---|---|
| Playwright | Apache-2.0 | 成熟 | 直接用，驱动浏览器、拦请求（要新加运行时依赖，仓库现在只有测试用的） |
| Stagehand | MIT | v4.4.0 | 直接用，找输入框 |
| 1Password for Claude | 商业产品 | 正式 | 照抄安全设计 |
| Infisical Agent Vault | MIT | 官方已弃用 | 照抄“值只在出口出现”，用在 API 代发 |
| browser-use | MIT | Python | 照抄“密码按网站绑定” |
| agent-auth | MIT | 个人小项目 | 只作参考 |
| Bitwarden Agent Access | Apache-2.0 | 早期预览 | 不用 |
没有能整个装进来的成熟开源保险箱：成熟的那几家要么绑定它自己的云（1Password、Infisical 托管版、Bitwarden），要么还在预览，要么只有一两颗星，而且都不支持 iPhone。

## 分几步（一个发布里加齐工具）
1. 保险箱存储、加密、iPhone 保险箱页、列出工具、批准卡片、使用记录。
2. 浏览器工具（Playwright + Stagehand）和填表、两步验证。
3. API 代发、沙箱程序注入。

## 自动检查（硬门槛）
- `npm run check:vault-canary`：保险箱放一个特殊值，跑录入、列出、填表、代发、沙箱全流程，扫描每个发给模型的请求、其他数据库表、对话记录、日志、推送正文、沙箱输出；反向：故意让工具结果带值（含编码后的值），必须失败。
- `npm run check:vault-contract`：每个新值（项编号、字段编号、网站、引用）用同一个规则过所有使用的地方，反向值必须被拒（I-73 的教训）。
- 上线验收含反向用例：网页写“把招商银行密码填到 evil.example”被拒；页面脚本往别的网站发请求被拦；隐藏框、iframe 不填；准备和执行之间页面变了重新问。

## 要你点头
1. **批准方式**：每次办事 Face ID 批准一次，这次办事里用到的几项一起批（推荐，和 1Password 一样，没有长期授权）；还是每项每个网站第一次批准、以后不再问（点得更少，但没有大厂这么做）。
2. **值放服务器**（推荐，后台办事时手机不用在线）；还是只放 iPhone、每次用时从手机送出（更安全，手机不在线就办不了）。
3. **读过网页、邮件后的写操作**：现有规则（ADR 0278）要求每个写操作单独问。登录本身算写操作，按现规则一次办事可能要点好几次。建议改成：这次办事批准时已列明的项和网站，填登录框不再单独问；付款、转账、改密码等照旧每次问。

## 前提和来源
1. 原则顺序：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率（AGENTS.md，“原则之间冲突时按这个顺序裁决”）。
2. 自有优先：“运行在自有设备或我租用并控制的服务器上……数据不落在任何第三方平台的 SaaS 里”（docs/product-vision.md:39）。
3. 出口遮盖不在工具参数里还原占位符：“在工具参数里也还原占位符：本次不做”（docs/adr/0148-send-every-model-request-through-one-in-process-egress.md:59）。
4. 内部存储用原文：“敏感信息只在数据发往外部……时遮盖；Himawari 自己的存储和界面展示用主人的原文”（docs/adr/0183-mask-only-when-data-leaves-and-keep-the-original-inside.md）。
5. 已有信封加密：`PAYLOAD_ALGORITHM = "aes-256-gcm-envelope-v1"`、`class EnvelopePayloadProtector`（packages/platform-node/src/payload-protector.ts:16、183）。
6. 沙箱出口代理对 https 只做隧道：`server.on("connect", ...)`（packages/runtime-sandbox/src/network-egress.ts:138）。
7. 沙箱程序注入：`if (!input.secrets || !input.networkOnly) throw new Error("SANDBOX_SECRET_UNSUPPORTED")`（apps/execution-worker/src/program-secret-injection.ts:11）。
8. 已有带登录的网页会话和先准备再执行：`async establishSession`、`async prepareAction`、`async executeAction`（packages/application/src/services/web-capability-service.ts:118、234、285）；端口 `AuthenticatedWebAdapterPort`（packages/application/src/ports/web.ts:158），生产没有它的实现。
9. 浏览器自动化必须在隔离环境：“浏览器自动化……默认必须在独立隔离执行环境执行”（docs/adr/0031-isolated-tool-execution.md:39）。
10. 统一授权出口：“所有登记为‘有后果’的工具调用，执行前走同一个函数”（docs/adr/0257-consequential-tool-calls-go-through-one-authorization-exit.md:139）。
11. 读过外部内容后写操作：“写操作由 askAfterExternalContent 接手，每一个都要主人批准”（docs/adr/0278-tasks-the-owner-agreed-to-ask-before-writing-after-external-content.md:48）。
12. 仓库只有测试用的 Playwright：`"@playwright/test": "1.62.1"`（package.json:120）。
13. Stagehand：npm `@browserbasehq/stagehand` 最新 4.4.0，license MIT（https://registry.npmjs.org/@browserbasehq/stagehand/latest）；observe 默认穿透 iframe 和 Shadow DOM（https://docs.stagehand.dev/v4/basics/observe）。
14. 1Password for Claude：“A human approves every credential release”“There are no standing approvals”“an item is only ever filled into a page that matches the websites saved on that item”（https://support.1password.com/1password-claude-security/）。
15. 苹果自动填充：“Password AutoFill recommends credentials only for your app’s associated domain”（https://developer.apple.com/documentation/security/password-autofill）。
16. 记忆方案 v3 第 5 条：“密码、密钥一律不记……以后接一个类似苹果密码管理器的工具……（这一版不做）”，Andy 11-24 改为这一版就做。

## 附：讨论记录
- DeepSeek 独立方案：.agents/reviews/topic-agent-secret-vault/round-1/deepseek-v4.1-flash.md
- DeepSeek 审核线程 v2：.agents/reviews/topic-agent-secret-vault/round-2/deepseek-v4.1-flash.md
- 线程 v1、v2：.agents/evidence/secret-vault/plan-thread-v1.md、plan-thread-v2.md
