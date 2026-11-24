# 问题：让 Himawari 能用主人的密码、密钥办事，但模型永远看不到值

## 主人的要求（Andy 2026-11-24 原话摘要，原话在项目线程）
- 密码、银行卡密码、网站登录密码、各种 API key 等密钥，存在类似密码管理器的地方，不经过模型、不进记忆。
- Himawari 要用时只说用哪一项（例如“招商银行那张卡的密码”），由工具把值取出来直接填进去，模型全程看不到值。
- 要的是通用能力，不针对某一个场景（原话：“有很多种场景会用到这些隐私数据……我要你做的是让 Himawari 具备这个能力，而不是说具体的什么场景”）。
- 这一版就要做。客户端只做 iPhone（macOS、watchOS 暂停）。
- 不要从零写，先找 GitHub 上成熟的开源方案。
- 银行卡号、证件号不归这里，按普通记忆原样给模型（另一个线程负责）。

## 项目约束（原文见仓库）
- 愿景：自有优先、数据自持，运行在主人控制的服务器上（docs/product-vision.md:37-39）。原则顺序：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率（AGENTS.md）。
- 有后果的工具调用走同一个授权出口（docs/adr/0257-consequential-tool-calls-go-through-one-authorization-exit.md）。读过网页、邮件等外部内容后的写操作先问主人（ADR 0278）。
- 理解用户意思交给模型，不写关键词表（.claude/rules/owner-standing-rules.md 最后一节）。
- 不写死，能动态获取的一律动态。Andy 反感多余点击、反复确认。
- 发给模型的内容只追加，不改已发出的前缀（.agents/instructions/prompt-prefix.md）。

## 已核对的现状
- 发给模型前，出口遮盖把密码、验证码等换成带编号的占位符 `[密码#xxxxxxxx]`，模型输出里的占位符再换回原值（packages/sensitive-capture/src/redaction.ts:65，packages/sensitive-capture/src/restoration.ts，packages/application/src/services/model-egress.ts；ADR 0146、0148、0183）。ADR 0183：内部存储和展示用原文，所以主人在聊天里打的密码在对话记录里是明文。
- 沙箱程序已能按 `secretRefs` 注入授权的密钥（apps/execution-worker/src/program-secret-injection.ts），密钥从主机密钥源取（packages/platform-node/src/host-secret-source.ts：macOS 钥匙串、systemd credential、受限文件）。
- 沙箱有出口网络代理（packages/runtime-sandbox/src/network-egress.ts），目前只转发，不改请求头。
- web-capability-service 有“带登录的网页会话”记录，含 allowedOrigins 和 secretRefs（packages/application/src/services/web-capability-service.ts:118-160）。
- 现在没有能操作网页、填表单的浏览器工具（只有 web_search、web_fetch）。ADR 0031 要求浏览器自动化在隔离环境里跑。
- iPhone 客户端已有钥匙串、Secure Enclave 封装和与服务器的配对通道（clients/apple/Sources/HimawariCore/KeychainValueStore.swift、SecureEnclaveKeys.swift、DeviceKeys.swift）。

## 查到的一手资料
- 苹果“密码”App 不对第三方 App 开放读取；第三方只能做自动填充提供方，或在自己的输入框接受系统自动填充：https://developer.apple.com/documentation/security/password-autofill
- 1Password SDK（服务账号 + op:// 引用读取）：https://developer.1password.com/docs/sdks/load-secrets
- 1Password for Claude：模型只看到条目标题、用户名、网址；值只由 1Password 自己的软件解密并填入；只填进网址匹配的页面；每次放出都要人批准；失败时清掉已填的值：https://support.1password.com/1password-claude-security/
- ChatGPT agent：要登录时让用户接管浏览器，模型看不到密码：https://help.openai.com/en/articles/11752874
- Bitwarden Agent Access（Apache-2.0，早期预览）：https://github.com/bitwarden/agent-access
- Infisical Agent Vault（出口代理替换占位符，已标为弃用，推荐其托管版）：https://github.com/Infisical/agent-vault
- agent-auth（MCP，{{password}} 占位符、按域名白名单、每个“凭据+域名”第一次用要人批准、跳转出白名单就中止）：https://github.com/ex-nihilo-labs/agent-auth
- agentvault（子进程注入 + 输出里把值换回占位符）：https://github.com/bshk-app/agentvault

## 要你回答
请出一套方案：存在哪、怎么录入、模型怎么指名用哪一项、值在哪里被填进去、怎样防止被网页注入骗去把密码填到别处或发出去、主人要点几次头、iPhone 端做什么、哪些现成开源可以直接用、分几步做。
