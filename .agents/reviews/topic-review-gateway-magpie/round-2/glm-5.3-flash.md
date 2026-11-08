# 方案审核结论

仓库已核对：`scripts/model-review/opencode-review.mjs`（全文）、`spend-guard.mjs`、`.agents/instructions/model-review.md`、`.claude/rules/prompt-prefix.md`、`docs/incidents-and-gates.md`（I-73/76/77）、ADR 0117、`test/tooling/opencode-review.test.mjs`（节选）。一手来源已核对：Magpie 官方 `docs/reference.md` 与 `docs/integrate`、`usemagpie.ai/docs/integrate`、`opencode.ai/docs/providers/`、`code.claude.com/docs/en/cloud-environments`。

---

## 问题清单（按严重度）

**1.【高·证实】`REVIEW_MODELS` 改名会弄破已有账本，方案声称“已有账本都照常用”是错的**
- 证据：`parseVerdicts` 要求 `verdict.model ∈ REVIEW_MODELS`（opencode-review.mjs:920）；`coveragePoints` 用 `record.model === REVIEW_MODELS[0]` 和 `REVIEW_MODELS.every(model => …record.model === model)`（opencode-review.mjs:1006–1016）；仓库里已提交的复核记录（PR 273 四轮，见 HEAD 提交 b9bd66x/5cedac6 的复核记录目录）账本 `model` 都是 `opencode-go/…`。改成 `review/…` 后：老账本的 `--assert-reviewed` 会报 `no-complete-round`，链上带 `low-fix` 的老轮次重核时 `parseVerdicts` 直接 `VERDICTS_INVALID`。这正是必答问题 4 / I-73（docs/incidents-and-gates.md:112）说的“只看改动、没问每个使用方能不能接受”。
- 建议：把「账本身份」和「线上身份」分开——`REVIEW_MODELS` 等账本常量保持 `opencode-go/deepseek-v4.1-flash` 等不变，OpenCode 配置里用 `modelID` 把它映射成发往 Magpie 的 `group/<名>`（官方：*“`modelID` | Model or deployment ID sent to the provider”*，https://opencode.ai/docs/providers/ ）。这样现有账本、verdicts、`--models`、prompt 文件名（`promptFileName` 取短名，opencode-review.mjs:1999–2001）零扰动。若一定要改名，必须加旧名→新名兼容映射，并加反向用例"`pr-273` 的老账本 + 新代码必须通过 `--assert-reviewed`"。

**2.【高·证实】插件改写系统提示违反 prompt-prefix 规则 4/11，方案只“记进 ADR 的风险”，既不走规则要求的例外流程，也没有任何自动检查**
- 证据：改写使“已经发给模型的内容”在字节上变化，且取决于上游是否拒绝——同一段文字不同请求不同字节，违反 `.claude/rules/prompt-prefix.md:35`（规则 4 只追加）和 :52 第 11 条（遮盖式确定性）；规则 ：88–89 要求这种变化“停下来出方案，Andy 同意才动工”。Magpie 官方把“改写请求"列为插件用途（https://usemagpie.ai/docs/integrate "*rewriting requests* | A plugin"）。另外“只在被拒时发生、同一进程内确定”目前只有作者的口头实测，没有引用一手来源。
- 建议：(a) ADT/ADR 里明确写成对 prompt-prefix 的受控豁免，附 Andy 的批准记录；(b) 自检加一条**透传探针**：OpenCode→Magpie→本机假上游，逐字节比对进出 Magpie 的 `messages`（必答问题 2 的自动化检查现在完全没有）；(c) 先读插件 `index.mjs` 源码确认改写条件和字符串，把“加逗号/移进用户消息”落实到具体源码行，而不是转述。

**3.【高·证实】回环 + 出口代理的组合没设计，很可能全线失败**
- 证据：Magpie 明确拒绝“经代理到达回环”的请求：*“A request that reaches loopback through a proxy or tunnel … is someone else's … Without sharing it is refused"*（https://github.com/yetone/magpie，docs/reference.md）。事实 4 又要求 Magpie/插件自身必须走代理（`NODE_USE_ENV_PROXY=1`）。而复核脚本的环境白名单 `OPENCODE_KEPT_ENV` 原样保留代理变量、没管 `NO_PROXY`（opencode-review.mjs:434–457）；OpenCode（Bun 运行时）对 127.0.0.1 是否走 HTTP_PROXY 未核实。云端自带 Bun 且官方注明*Bun is installed but has known proxy compatibility issues*（https://code.claude.com/docs/en/cloud-environments#installed-tools）。
- 建议：Magpie 进程：`HTTPS_PROXY`/`HTTP_PROXY` + `NODE_USE_ENV_PROXY=1` + `NO_PROXY=127.0.0.1,localhost`；OpenCode 进程：`NO_PROXY=127.0.0.1,localhost` 必须显式设。进 `focus` 用例：带着真实代理变量跑自检（假上游经 Magpie 这一路正好能验证），反向用例：去掉 NO_PROXY 必须失败。

**4.【高·证实】CodeBuddy 积分没有“运行中”上限，0.2 美元门管不到它；开跑前的积分查询设计也走不通**
- 证据：现费用门全在 OpenCode 进程内（I-77，docs/incidents-and-gates.md:115），计的是 OpenCode 本地算的美元；CodeBuddy 计的是积分，方案只在开跑前检查一次（§5）。实测一轮 4.37 积分（事实 8），意味着一次 0.2 美元“上限"内可以烧掉月额度（100+150）的相当比例；底线 20 只防"最后 20"。另外 §5 写“查积分（插件的用量查询，经 Magpie 或直接调用）”——**直接调用在容器里没有真凭证，永远失败**（事实 1/5：真凭证只在出口代理处，不上容器）。
- 建议：(a) 用 Magpie 官方端点查额度：*"GET /v1/magpie/quotas lists the user's subscription allowances"*（https://usemagpie.ai/docs/integrate ）；(b) 估算不再硬编码"13/6"：从上一轮账本的 `providers` 字段取实际消耗取 3 倍，跨跑也能接得上；(c) ADR 里如实写清楚：积分底线是开跑前的一次性估计 + 失败换 Go 兜底，不是运行中的硬门；这和 I-77 的教训一并写明差异和原因。

**5.【中·证实】Magpie 自动更新关不掉，“查清怎么关掉”是方案里唯一没落地的硬表述；仅对版本号不拦静默换包**
- 证据：官方 *“Every build keeps itself current: the app downloads a new version in the background and installs it when you restart or quit"*（https://github.com/yetone/magpie/blob/main/docs/reference.md 安装章节）;我没有找到关闭开关的文档表述（未核实，这正是方案自己欠的账）。`--version` 检查拦不住"同一版本号、二进制被换成不同哈希"。
- 建议：锁文件占住版本 + **前后对程序做 SHA-256 全文件比对**（锁文件里本来就有摘要，成本为零）；程序副本 `chmod 555`/只读；若确认 serve 模式退出时装更新、且便携目录可被改写，则改用“白名单目录只读引用 + 每次运行做哈希”双保险；并把“关自动更新的具体开关”作为实施前必须闭合的前置项写进 ADR。

**6.【中·证实】§4 与现存的 I-76 门正面冲突，方案没提**
- 证据：I-76 加的测试要求**正式复核配置不得出现 `apiKey`、必须保留 `opencode-go` 条目**（test/tooling/opencode-review.test.mjs:154、`reviewConfig` opencode-review.mjs:92/96；docs/incidents-and-gates.md:108；`.agents/instructions/model-review.md:70`）。§4 让正式配置带 `apiKey` 占位、provider 改名 `review`——两处门都要有意识地改写，否则 I-76 的门槛测试直接红。
- 建议：改门时保留其本意“真凭证不进配置”（这仍成立），文档第 70 条同步改；对外 key 用 `magpie-himawari-review`（官方：*“The key names your app…Send `magpie-<your-app-id>`…and every call is counted as acme in Usage"*，https://usemagpie.ai/docs/integrate ），比纯 `placeholder` 的归因更干净。

**7.【中·证实】自检经 Magpie 后，现有探针有一个已知的断点**
- 证据：`checkProbeRequests` 用 `MODEL_OUTPUT_LIMITS[request.model.split("/").pop()]` 和全局 `MIN_OUTPUT_TOKENS` 判断发到假服务器的请求（opencode-review.mjs:1694–1697）。经 Magpie 后，假服务器看到的 `model` 是“路由组成员映射后的 id"（是否等于原组名未核实），`PROBE_MODEL_UNKNOWN` 大概率误红；`MIN_OUTPUT_TOKENS` 目前是全局常数（:27），§4 说“按模型”却没同步说自检这条要怎么改。
- 建议：§6 明确列出两处适配；反向用例补一条“自检里假服务器看到的 model 必须等于锁定的映射值"。

**8.【中·证实】`providers` 新字段的账本校验会反杀所有老账本**
- 证据：`parseUsage` 是逐行全局校验（opencode-review.mjs:1360–1371），追加“复核记录必须带 providers”后，所有已合并 PR 的老账本在下次 `--assert-reviewed`/`--report` 读到就直接 `USAGE_LEDGER_INVALID`。
- 建议：给经网关的行加自己的标志（例如 `gateway: "magpie"`），校验规则改为“带该标志的行必须带非空 `providers`"；反向用例必须包含“老格式账本 + 网关开着也能读”。

**9.【中·推测/未核实】安装脚本的 Bun 下载不在锁文件里，破坏方案自己的供应链约束**
- 证据：§1 只锁 Magpie 和插件 npm integrity，"首次运行 Bun 也在这里触发下载”。云端 VM 预装 Bun 且官方标注已知代理问题（https://code.claude.com/docs/en/cloud-environments#installed-tools）。
- 建议：优先用 VM 预装 Bun；版本/SHA 进锁文件；若必须下载，走 `usemagpie.ai`（Magpie 文档：*Bun's default version carries its SHA-256s in the code*，https://github.com/yetone/magpie/blob/main/docs/reference.md 装 B 章下），核对后才落盘。

**10.【低·证实】环境 `allowed domains` 要加 `usemagpie.ai`，改域名清单会重建快照**
- 证据：默认 Trusted 清单只含包管理器/GitHub 等（https://code.claude.com/docs/en/cloud-environments#default-allowed-domains 部分）；官方同时确认改 allowed hosts 会触发快照重建（*“runs again to rebuild … when you change the environment's setup script or allowed network hosts"*）。方案没把这一步列进切换清单。
- 建议：在 ADR“切换"一节加环境配置步骤和 rebuilt 的预期；并在锁文件同级的 README 里写清清单要求。

**11.【低·证实】`stays=auto` 的语义和 §7 的表述不符**
- 证据：官方 *“stays= … auto（the default, while the vendor's cache of it is worth keeping), session, turn, off or strict”*（https://github.com/yetone/magpie/blob/main/docs/reference.md）；事实 8 的实测（回弹 CodeBuddy）正好说明 auto 不等于“同一账号"。§7 说"stays=auto 让它留在同一个账号"与自己的实测矛盾；回弹那次也是一次整段重算。
- 建议：按 prompt-prefix 规则 9 的目标选 `stays=session`（整段会话钉死一个账号，回到失败后的稳定态；代价是兜底后不再切回便宜的 CodeBuddy），或接受 auto 但把“每个回合都可能换家、代价以缓存 TTL 界定”写准，别写成“只有一次失效”。

**12.【低·推测】Magpie 数据目录的读-删顺序**
- 证据：用量记录在便携 `data/` 目录里，脚本退出前删 temp；官方 *magpie serve 也会在 SIGTERM 退出（无 drain）*。若脚本被 SIGKILL，providers 字段来不及写。
- 建议：追账逻辑写成"审账 occurs 在 cleanup 前”，SIGKILL 时 providers 缺失按未知记（不判失败）；测试补一条。

---

## 「侧重检查」（测试覆盖、文档一致性、普通流程走查）

走的流程：`opencode-review.mjs` 入口 → `reviewConfig`（I-76 门，test:154/163）→ 自检（探针→假服务器）→ 安装（npm ci vs 新增 install-gateway）→ 双模型一轮（spend-guard 插件→Magpie→上游）→ `usage.jsonl` 追加（parseUsage 校验）→ `--assert-reviewed` 走待写账链（coveragePoints→walkChain→lowFixProblems→parseVerdicts）。

结论：
- **没有测试覆盖的（如果方案落地）**：install-gateway 下载/校验/复用重哈希（现有 `installOpencode` 有完整套路 opencode-review.mjs:318–369 可复用）；`gateway.json`→Magpie 命令/OpenCode 配置生成（方案 §9 有列，可接受）；`providers` 字段与老账本共存（**方案没列**）；NO_PROXY/代理组合（**方案没列**）；自检经 Magpie 的 `PROBE_MODEL_UNKNOWN`/全局 MIN 整改（**方案没列**）；透传字节探针（**方案没列**）。
- **文档-代码不一致**：`.agents/instructions/model-review.md:70`（密钥规则）与 §4 冲突；`:69`（OpenCode 安装章节）要补新安装方式；I-76 的“已落门槛”行（docs/incidents-and-gates.md:108）跟着要改。方案 §10 只写了“怎么跑”一节，漏了上面这些。
- 工程案例库判定本身合规（ADR 0117 已有相关条目）。

---

## 如果由我来定

1. 保持**账本标识不变**（`REVIEW_MODELS` 仍是 `opencode-go/…`），用 OpenCode 的 `modelID` 映射到 `group/<名>`；账本加 `gateway: "magpie"` 标志，校验只作用于新格式。
2. Switch 保留每次起/停的 Magpie 设计、锁文件 + 前后 SHA-256 比对（不采版本号）、程序只读副本。
3. OpenCode↔Magpie 的 env 拆成两份：Magpie 侧代理齐、OpenCode 侧 `NO_PROXY=127.0.0.1,localhost`；集成用例用真代理变量跑。
4. 插件改写成 ADR 正式豁免 + 自检透传探针；先把插件源码读一遍写进 ADR。
5. 积分底线用 `/v1/magpie/quotas`，估算改为按上轮账本实际用量 ×3；0.2 美元门 + 保守单价（opencode 官方模型表有 `cost` 字段，https://opencode.ai/docs/models 路径由 providers 页确认支持）放 ADR 0117 同款口径。
6. I-76 门照本意改写（配置里真密钥不进，假 key 占位 + 有意保留 `magpie-` 前缀命名 key）；文档和 incidents 行同步改。

## 必答问题逐条回答

**Q1（只追加/每轮可变值在最后一条消息）**：提示词组装路径（`buildPrompt`、wrap-up 追问、`promptSha256`、`promptFileName` 短名）这条改动不触碰，正文不改；发请求的末尾追加逻辑不变。**但**：新增的中间层 Magpie 插件可能改写系统提示（方案 §7 自认），即“请求开头”出现了一次不受脚本控制的改动——按现有规则这是需 ADR + Andy 批准的例外，且必须配自动化检查（透传探针）。其余会变的值（本次端口、临时路径）都在配置而非发给模型的内容里，不违反“每轮变的值在最后一条消息”。

**Q2（同一段文字不同请求不同字节）**：现有脚本对 LLM 内容没有遮盖、无时间字段，路由不引入新排序问题——除了第 2 条的插件改写（有条件、看上游是否拒绝）和 Magpie 的 fallback（规则 9 允许的先例：巷子失败换服务方，换后整段重算）。按规则 9 的原文要求（缓存路由同键/Magpie 会话亲和），建议加 `stays=session` 或用 OpenCode 的 `headers` 字段在 wrap-up 进程注入 `X-Magpie-Session`（官方支持 provider-level `headers`）以强调亲和。

**Q3（自动检查/反向用例会失败吗）**：方案 §9 列的自检、版本门、积分底线、摘要不符——设计方向对，但缺 4 条：老账本 + 新 `providers/gateway` 字段格式兼容必须通过（反向：误判老账本无效即失败的最小用例）；`NO_PROXY` 遗漏级联失败用例；透传（Q2）用例；自检模型名/上限适配用例。

**Q4（每个新值的所有使用方）**：逐项——
- `review/deepseek-v4.1-flash`：**未通过**（老账本/verdicts 校验断链，见问题 1）——先改设计。
- `providers` 字段：写作面 OK；读侧 parseUsage/老账本**未通过**（问题 8）。
- `gateway.json`/`gateway-lock.json`（含 URL、SHA、integrity、底线 20）：消费端 install-gateway/自检/预检都在方案内；**未通过**的是 Bun 未纳入锁（问题 9）和 usemagpie.ai 域名白名单（问题 10）。
- 错误码 `GATEWAY_*`：单端消费（脚本打印/人看），可接受。
- MinOutputPerModel：`checkProbeRequests` 和全局 `MIN_OUTPUT_TOKENS` 两处用法**未收拢**（问题 7）。
- 外发 key 占位 → Magpie：可用（官方确认“本机任意 key"），但按 I-76 门名义重命名并写 ADR（问题 6）。
