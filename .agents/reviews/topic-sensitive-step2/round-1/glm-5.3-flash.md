代码现状已基本清楚，现在去核对上游一手来源（secretlint 类型/tsc 包装方式、detect-secrets 的关键词与过滤器源码）。
关键事实已确认：secretlint 规则本体是「`create(context)` 返回 `file(source)` 处理器，在 `source.content` 上做正则 `matchAll`+`context.report`」。再核对 core 的 `lintSource` 是否异步，以及 npm/gcp 两条依赖文件名的规则源码。
# 敏感信息识别第 2 步：识别规则升级——独立方案

## 一、方案依赖的前提

### 读代码证实的

[代码现状]

- P1 现有 7 条机器密钥规则是一条同步正则清单：`MACHINE_SECRET_RULE_IDS`（machine-secrets.ts:1-9）、`RULES`（machine-secrets.ts:21-43），替换为固定字符串 `[MACHINE_SECRET_REDACTED]`（:45），`scanMachineSecrets` 对每条规则 `match` 计数（:47-54），`containsToolOutputSecret` 再加私钥边界（:58-60），`redactMachineSecrets` 逐条 `replace`（:62-73）。原话：「`{ id: "openai-api-key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g }`」。
- P2 流式遮盖靠两个按规则手工维护的表：`POTENTIAL_SECRET_MARKERS`（machine-secrets.ts:91-115，21 个前缀字符串）和 `ACTIVE_SECRET_SUFFIXES`（:117-124，6 条“未结尾”正则），`machineSecretHoldStart` 用它们找扣住点（:126-152），`StreamingMachineSecretRedactor` 消费它（:154-176）。
- P3 `scanMachineSecrets`/`containsToolOutputSecret`/`assertMachineSecretFree` 的同步调用点共 84 处（grep 全仓库 *.ts 计数），横跨 `packages/platform-node`、`packages/application`、`packages/runtime-pi`、`apps/agent-service`，全部在同步表达式里使用（例如 `packages/platform-node/src/exa-public-search.ts:121` 的 `Buffer.byteLength(value) > 8192 || scanMachineSecrets(value).length`、`apps/agent-service/src/capability-programs/host-file-read.ts:146`）。
- P4 密码规则 `PASSWORD_ASSIGNMENT` 是“关键词+全角/半角分隔符+值”（redaction.ts:62-63），关键词表只有 密码/密碼/口令/PIN 码/安全码/授权码/パスワード/暗証番号/비밀번호/암호/비번/password/passwd/pwd，值是 `[^\s,，;；]+`。
- P5 拦截记录的三层校验口径：上报端口 `ruleId: string`（ports/sensitive-interceptions.ts:55）；落库校验 `boundedText(item.ruleId, 128)`（persistence-sqlite/src/sqlite-sensitive-interception-operations.ts:52）；**网关合约里根本没有 ruleId 字段**，只有 category 枚举（gateway-contracts/src/contracts-v2.ts:696-702）。记忆侧归类靠数组：`memoryCategory(ruleId) → (MACHINE_SECRET_RULE_IDS as readonly string[]).includes(ruleId)`（application/src/services/sensitive-interception-recorder.ts:33）。
- P6 记忆路径把“机器密钥发现”直接当入参：`candidateSecretFindings` 把 `scanMachineSecrets(text)` 的 ruleId 撒进审计记录（automatic-memory-service.ts:73-81），来源整段排除在 :102-113。`MemoryExtractionAuditRecord["secretFindings"].ruleId` 也是 `string`（ports/automatic-memory.ts:163）。
- P7 出口遮盖每次请求按段重做：`#prepare` 逐段调 `redactForEgress`，然后 `assertMachineSecretFree(result.text)` 自检（model-egress.ts:186-219）。流式只在 `StreamingMachineSecretRedactor`（packages/runtime-pi/src/pi-model-transport.ts:336）和 UI 实时输出（execution-live-feed.ts:46）两处，都只走机器密钥，不走密码规则。
- P8 规则约束：产品代码里的识别规则只能写在 `packages/sensitive-capture/src/`（scripts/check-egress-redaction.mjs:23、91-96）；只有出口模块能调 `redactForEgress`（:97-100）。`check:egress-redaction` 在 `check:steps` 里（package.json:27）。
- P9 仓库里还有三份独立的机器密钥规则副本（node 直接跑的脚本）：`scripts/scan-machine-secrets.mjs`（`check:secrets` 用）、`scripts/ci/security-source.mjs`、`scripts/ci/redact-text.mjs`（ADR 0167 第 86 行自己列为未处理部分）。
- P10 测试假密钥要过 gitleaks：例外清单 `ci/security-exceptions.json` 按路径+行号记录 `machine-secret-exclusion.unit.test.ts` 的假密钥，且要 Andy 审核（ADR 0167 第 66 行）。
- P11 现有负样本语料（误报防火墙）在 redaction.unit.test.ts:53-71（订单号、ISBN、时间戳、邮编、电话等）， золотых 提示词文件里有“confidence 是 0 到 1000 的整数”（apps/agent-service/test/__prompt_golden__/memory.capture.txt:7-11）。
- P12 包的独立性契约：ADR 0167 决定 1 原话「只放识别和遮盖本身，不依赖 Himawari 的其他包，不做文件、数据库或网络读写，浏览器里也能用」；当前 package.json 无任何 dependencies。
- P13 依赖管理：直接外部依赖必须精确固定（.agents/instructions/pi-and-workspace.md:25「所有直接外部依赖的版本都保持精确」）；根 devDependencies 全部精确版本（package.json:87-100）。`.claude/rules/prompt-prefix.md` 第 4、5、10、11 条在 :35、:36、:51-53；门在 :73（`prompt-prefix.compat.test.ts` 名字带 `[I-66]`，含反向用例）。
- P14 上线一次性影响的既有通道：升高/命中监控 `cache.follow_up_low_hit` 和报表脚本（prompt-prefix.md:76-78）。

### 网上一手来源证实的

[secretlint]

- P15 secretlint 规则本体是同步、纯内容正则的「visitor」：`create(context)` 返回 `file(source: SecretLintSourceCode)`，规则在 `source.content` 上 `matchAll` 后 `context.report`；meta 里 `supportedContentTypes: ["text"]` 决定拿到什么内容。原话：「A rule should export `creator` object … `create`: main logic of the rule」。https://github.com/secretlint/secretlint/blob/master/docs/secretlint-rule.md
- P16 AWS 规则源码（正则来自 cribl，含 `BUILTIN_IGNORED` 假密钥忽略表，`enableIDScanRule` 默认 false）：https://github.com/secretlint/secretlint/blob/1b0bebd9/packages/@secretlint/secretlint-rule-aws/src/index.ts
- P17 推荐集 README：27 条规则清单、可按 `allowMessageIds` 关子消息、整包 Rollup 打包、「Import rule tests and update snapshot: `npm run import-test`」（快照测试取自各规则包）、「License MIT © azu」。https://github.com/secretlint/secretlint/blob/master/packages/%40secretlint/secretlint-rule-preset-recommend/README.md
- P18 secretlint 官方测试器对每个用例目录跑 `await lintSource({ source: rawSource, ... })`（异步），并以 `output.json` 快照编程式断言：https://github.com/secretlint/secretlint/blob/1b0bebd9/packages/@secretlint/tester/src/index.ts
- P19 secretlint issue #19 里的实测：用 `@secretlint/core` 的 `lintSource` 对推荐集跑 16.9 MB 日志「0 findings in 391 ms」，且 base64 编码包裹的密钥查不到（明文可查）。https://github.com/secretlint/secretlint/issues/19

[detect-secrets]

- P20 关键词检测 `keyword.py`：`DENYLIST` 19 个小写正则（含 `api_?key`、`private_?key`、`secret`、`contraseña` 等），关键词前后可带 `\w*`；按文件类型选正则家族，「没有文件类型时只用要求引号的那一组」原话：「if denylist_regex_to_group is None: attempts = [QUOTES_REQUIRED_DENYLIST_REGEX_TO_GROUP,]」。头部带 bandit 来源声明：「This code was extracted in part from https://github.com/PyCQA/bandit … Copyright (c) 2014 Hewlett-Packard …」，即这份文件本身是 HP 的 MIT 式许可。https://github.com/Yelp/detect-secrets/blob/master/detect_secrets/plugins/keyword.py
- P21 启发式过滤器 `heuristic.py`：`is_templated_secret`（`{…}` `<…>` `${…}`）、`is_prefixed_with_dollar_sign`、`is_indirect_reference`（`password = get_secret()`，带 1000 字符行长上限防回溯爆炸）、`is_potential_uuid`、`is_sequential_string`、`is_not_alphanumeric_string`，以及纯文件的 `is_non_text_file`/`is_lock_file`/`is_swagger_file`。https://github.com/Yelp/detect-secrets/blob/master/detect_secrets/filters/heuristic.py
- P22 许可：secretlint 推荐集 MIT（P17）；detect-secrets 仓库主许可为 Apache 2.0（出处为主人材料附注 https://github.com/Yelp/detect-secrets ，我会按 Apache-2.0 留许可与改动声明；LICENSE 文件我未单独打开核实——未核实）。

### 推测（写明，实现时验证）

- T1 27 条 secretlint 规则里除 aws、slack 外未逐条读源码假定同为“内容纯正则”；个别规则（docker、databricks、tailscale 等）引用 cribl 正则表，可能含复杂回溯。逐条移植时以 P22 语料回灌验证（风险 R2）。
- T2 控制中心“敏感信息拦截记录”页面 UI 对 ruleId 是否有前端白名单——我查了端口、SQLite、网关合约三层都没有，UI 层未查（未核实，见必答 4）。
- T3 性能预算的具体数值（第五节给出测法，阈值要靠首轮实测标定后钉进门槛）。

## 二、方案本身

### 总架构图（文字版）

规则升级只发生在 `packages/sensitive-capture` 一个包内，分两台“引擎”共用一张来源账本：

```
上游 13.1.0 snapshot 语料（test/assets/upstream-corpus/）
        │  等价性对照（门槛 1）
        ▼
src/machine-secrets.ts   7 条旧规则 ──不删──┐
src/secretlint/          移植的 N 条 ──────┤→ 同步扫描(遮盖值/整段拦下两用)
                                           │→ 流式扣住点(按规则配拖尾)
src/detect-secrets/       关键词行李箱 ─→ redaction.ts 第二遍(只遮盖)
                                           │
        src/redaction.ts(入口次序固定) ─────┘→ observe 上报 → 拦截记录页
```

### 逐问方案的完整论述

---

- 每条规则固定三件套结构：
  ```ts
  {
    id: "secretlint-aws-secret-access-key",
    origin: "@secretlint/secretlint-rule-aws@13.1.0", // 版本钉死在注释和实现文件头部
    surfaces: { redact: true, block: true },
    match: /…/g,                                      // 已知完整匹配
    tail?: RegExp,                                    // “可疑未结尾”形(流式用)
    markers?: string[],                               // 前缀扣住串(流式用)
    builtinIgnore?: readonly string[],                // 上游 BUILTIN_IGNORED 中的假样例
  }
  ```
- **依赖文件名的一概不搬**：npm 只看 `.npmrc`/`package.json` 文件后缀、gcp 只对 `.p12`/json 文件起效（材料已核对事实）。聊天里没有“文件名”，搬进来要么永假要么逼我们虚构文件名——虚构文件名会引入“同一段文字配什么名”的第二个输入源，直接踩必答 2。ADR 里写“跳过这两条规则及其理由”。
- AWS `enableIDScanRule` 保持上游默认 false。AWS 账号 ID（`AKIA…{16}`）我们已有一条，且账号 ID 看着像密钥实则常出现在教学文本里（medium 文章里到处是 `AKIAIOSFODNN7EXAMPLE`，是规则的 builtin ignore 例子），开启会显著抬 FP，无收益。
- 初始名单按 material 27 条”：1password, anthropic, aws(AKIA 后半的四族 + secret access key 40 位), basicauth, cloudflare, database-connection-string, databricks, docker, figma, github(gho_/ghp_/ghs_/ghu_/ghr_/github_pat_ 四族——我们已有近似，会重叠), gitlab, grafana, groq, hashicorp-vault, huggingface, linear, notion, openai(sk- 第三后缀 sk-svcacct), privatekey(增强我们的私有块), sendgrid(SG.), shopify(shpat_), slack(xoxb/xoxp/xapp/xoxa/xoxo/xoxr), stripe(sk_live_/sk_test_), tailscale(tskey_), vercel。
  - firebase (fireBase token) 上游无独立条目；原 word "Google" class在 gcp —— gcp 不搬。若 GitHub 重叠导致同 span 两条都命中：按固定次序先后跑，重叠只反映为计数，不产生顺序不确定性；避免的具体公式就是“别名之间保留一条信号以避免 count 不一致”——决定：按品牌去重而非正则，落地策略写在实现 PR 里的表格里逐条处理，见 PR-2 工作分解。
- 上报 id 前缀统一 `secretlint-` 与旧 7 条隔开，长度 ≤128（P5 sqlite 校验开口纯净可过）。最低和最大值都要在 128 内部（防止“长度超 128 的 id”总体可校验合格）。
- **三份 node 脚本副本（P9）第 2 步不同步**：它们服务于 CI 里查我们自己的仓库代码，密钥笔画是我们自己控制的（假密钥形态）。同步它们意味着规则升级会应用到自己的源代码上，FP 直接炸 repo CI——不升。ADR 指出这是与包内的既有缺口（ADR 0167:86 已认）；新增规则不太可能命中的自身文字——但 例：新增 stripe/1password 正则会不会误中本仓库文字？新增 ourselves 的假样例库与 sample 方案已有以 corpus 测试覆盖此前缀。若 CR 后升级脚本仍需要，单独 PR（脚本复制与产物越界），目前主包规则被封包不动。
- 包 bundle 尺寸：secretlint 全包 230 KB（材料）；移植后只取正则与常量，预计 <30 KB 新增源文本。不引上游包，杜绝运行时依赖。

**逐条更新的机制（“跟随上游”）：**每次想升 13.1.0 → 13.x 时，跑一条入口命令（实现为 `npm run secretlint:sync -- <version>`）：
1. `npm pack @secretlint/secretlint-rule-preset-recommend@<version>` 解包到临时目录；
2. 抽取全部 snapshot 用例与每条规则的内置正则串，以及内置 ignore 样本（MEDIUM 拼正则串的部分，用少量代码生成器读出上游 bundle 里的规则签名——不打包运行上游模块，只在**开发期**当作紧凑文件读取）；
3. 与本地移植版 diff —— 由于我们规整为标准三件套，diff 的只是每个分支里的 match 与 builtinIgnore；
4. 等价门槛（第 5 题）自动重跑；确认后把移植文件里的 origin 注释升级，提交一个含上游号与差异说明的 `CHANGELOG-thirdparty` 行。

**为什么不依赖运行时上游（详）：**三重结构性代价：
1. 同步→异改的整仓抖动：`scanMachineSecrets` 的 84 个同步调用点（P3）要么 await 化要么变形，本地整段拦下逻辑全变异步（将与 exa 搜索、host-file-read 等同步断言路径（exa-public-search.ts:121 等）绊住）——是迁移领域成本，不是规则成本。
2. 字节确定性：We must所 依赖上游 `lintSource` 的次 timezone 处理 review_chain 的 contentType 切换逻辑（深 wiki: ContentTypeHandlers.io binary/text 判断规则），切面并非贴我们的 chat 文本形态；必须改造成自家同步 `(text) ⇒ 遮` 形态。
3. 上游接口稳定性的不确定：`lintSource` 输入要求 `SecretLintSourceCode`，带 `extname`；请形推 size、upstream preset 换 Rollup 打包，分版本 bundle 细节会变；直接依赖等于把这些不确定引进我们的 production 运行时，破坏 P12 的“浏览器里也能用”。

### 2. 新规则用在哪里：只遮盖还是也整段拦下（问题 2）

**答案：进入两张作用面，但以每规则的 `surfaces` 开关区分，且机器密钥→两端、密码→只遮盖；`named-earlier` 名单继续只记忆密码和验证码（不扩）；机器密钥值不记忆、不重组。**

- 机器密钥规则（旧 7 + secretlint 新规则）：默认 `redact: true, block: true`。为什么两端都用——Andrew 的目标 1 说“叠加”，即边域为关链而升级；secretlint AWS SecretAccessKey（40 位 base64，现有规则不抓）这类**该是真密钥**的东西，若只遮不拦，`assertMachineSecretFree`（model-egress.ts:214）的自检就会**把已遮外的重拼作为泄漏**，反而让 30 处拦下口失去理由。这既是功能升级，不是随便套布。
- 密码关键词升级只走遮盖路径（redactForEgress 的 `baggage` 类家族）。为什么“密码”不进拦截面：*聊天里随口说的密码* FP 代价比机器密钥更难控（EPI，含 “password: 0 到 1000 的整数” 之类的词工绑定），而且现行系统对**输出里的密码**本来就不拦（只遮，见 P7 流式只走机器密钥），跟上就没意义。
- 机器密钥若某规则 FP 过高（上线后拦截页面数据兑现），单独降级：把 `surfaces.block` 设为 false（保留遮盖）——引用第 1 步上线后的拦截记录页作为证据位；“降级不改 id、不改表结构”（P5 端点是 string，无迁移）。
- 30 处拦截面中的**自检**（`assertMachineSecretFree`）设计上就好比稍强的防御，注定 FP 会盯雠；第 2 步的 ADR 指示女 case “一次 1-2 条规则 FP 率 > 视野快速埋点）：若违背，评审会按记录自动阻断，晚于上一条”_MARGIN。**实现层在我们包内自带开关，包外零改动。**

### 3. detect-secrets 关键词检测的聊天文本改造（问题 3）

**策略：不选合并、选并存的“两段式”。**两段都在 `redactForEgress` 的 password 遮盖步（现 redaction.ts:215-220 段）里按固定次序运行，第一段现有 `PASSWORD_ASSIGNMENT` 一字不动；第二段新增 detect-secrets 改造版，只补 `password-keyword` 抓不到的引号形态（`api_key: "…"`、`secret = new Token("…")` 等）:

- **原理：**不合并的理由是第一段要负责全部 CJK 无引号情形（老行为），它的值域 `[^\s,，;；]+` 极宽，玩如果通 detect-secrets 正则家族、行为不陟反而隐性变化旧 字节。并存让两段各自可直接对上游或本地语源以确定性测试。
- **第二段按这个套作法移植**（依据 P20 的源码结构）：
  - **关键词**：detect-secrets `DENYLIST` 全 19 条组入一个关键词组（保留“小写、`_?` 可选下划线、前后 `\w*`”原样)。它已含 password/passwd/pwd/secret/private_key，/daygrabbing CJK 已由第一段管。
  - **赋值写法与文档**：聊天无文件类型，取 detect-secrets 自己“无文件类型的默认”——P20 的 QUOTES_REQUIRED 家族（要求引号 + YAML/JS/Go/C++ 常见的写法集合只在有 filetype 时才使：但我们聊天语境即“无 filetype”，**只取 QUOTES_REQUIRED 家族**，即 `secret "…"`、`secret = "…"`、`"…" == password` 这几种）。也就是说同时容忍圆括号、的双引号（都来自同一个正则集）。
  - **过滤器照搬**（P21）：
    - 保留：`is_templated_secret`、`is_prefixed_with_dollar_sign`（`password = $DB_PASS LoginPage` 不该报)、`is_indirect_reference`（右值是个函数调用 (`password = get_secret()`) 不算泄密——把 `[` / `(` 搬进来即可；并 keep 1000 字 limit，用换行切分代替 theme 线程,防止 `([^\v=!:]*)…[\[\(][^\v]*[\]\)]` 在日英长语料上回溯爆炸 (P21 源码里就是这么防的)。
    - **不搬**（审视Andy与双模型已定 + 材料列出三条 plus 我审视文件作用面）：`is_sequential_string`、`is_not_alphanumeric_string`、`is_line_allowlisted`；文件类 `is_non_text_file`/`is_lock_file`/`is_swagger_file`。
    - **攀议保留一个**（需拍板 B）：`is_potential_uuid`——UUID 值几乎从不发密码用，又常在日志里出现；保留能减 FP（温度一点：secretlint 场景下它是常用判断）。若 Andy 担心它放过一个藏 UUID 的真密钥，可以去掉，成本是由密码关键词 FP 概率上调补偿。
  - **关键词排除前接**：detect-secrets 有个 `keyword_exclude` 插件级正则选项（P20 源码 `__init__`）。把它做成第二段的固定参数而不是另一条规则——排除层（另一线程）如果注入“Himawari 指令标 context”，我们的第二段不必开发新机制，直接让另一线程的这个参数给它（接口位置：我们的 `redactForEgress` 增加可选 `keywordExclude?: RegExp`，只在应用层传，不作为规则）。
- **不使用 `detect-secrets` 的“文件类型判断”和其它文件分型家族**（GO/C++/python 各自有专属写法集）：若“要求引号”家族已覆盖天朝；剩下的无引号英文 password 类如 `password: SECRET_KEY=my-print-supersafe`（= 后无引号）其实已被第一段抓。
- **匹配值的语义**:detect-secrets 的 `SECRET` 段「`(?=[^\v\'\"]*)(?=\w+)[^\v\'\"]*[^\v,\'\"\`]`」(P20 原样) 过滤了“值里有引号”的陷阱,加上值两端被限制不被引号吃——这与第一段 `[^\s,，;；]+` 不一样 (能捕获含符号的密码 `Zx9!qq`…第一段已经这样,第二段的 SECRET 不允许结尾逗号/引号只有最后一字符；两段行为 specifics保留上游原样)。
- **ID 与计数**：第二段沿用 kind `"password"`（EgressRedaction 的 model-egress 端 category 不变），ruleId 单独记 `"password-keyword-denylist"`（string，128 字内、可直接入库、可被页面以原样展示）。第一段的 sightings record 依然 ruleId = `"password-keyword"`，意味着**处置页面既保留“关键词”也可见"denylist"来源**，但要修 UI 展示逻辑——不修亦可，后台直接呈现新 id。拦截记录页不新增类别列（P5 已证 category 枚举只含五类）。
- **`named-earlier` 交互**：第二段引入新值时仍按现行入口（redaction.ts:215-282 同一个 `mask()`、`known` 表、`KNOWN_VALUE_MINIMUM_LENGTH=6`、占位符签名），不另立记忆。因此第 11 条“点名后再出现也遮”语义原封不动，仅扩充新 value 进入这张表——上线后的字节差异属于本 ADR 例外的既有声明范围。

### 4. 流式遮盖怎么跟上（问题 4）

`machineSecretHoldStart` 两个表（P2）按**每一条新机器密钥规则一行**同步扩，不靠自动生成，理由是扣住尾巴是逐规则的形状工程：

- **能精确配拖尾的**（品牌前缀 + 可重复字符类）：每条规则从它的 `match` 机械派生一条 `tail` 正则（去掉终结条件的“开尾版”），并把稳定前缀加进 `POTENTIAL_SECRET_MARKERS`。举例：slack `xoxb-…`、stripe `sk_(live|test)_…`、anthropic `sk-ant_svcacct_…`、hashicorp `hfTkn_`、sendgrid `SG.`。规则表里显式增列，出现在 P1 描述的格式里。现有 6 条 `ACTIVE_SECRET_SUFFIXES` 全数保留。
- **不能配拖尾的**（匹配需要成对结构，如 database-connection-string `scheme://user:pass@host`、basicauth Basic xxx）：只给“开尾”而不给完整版，配合 `POTENTIAL_SECRET_MARKERS` 靠前缀字符串（`"postgres:/"`、`"mysql:/"`、`"Basic "`、`constraint` 线不扱）来近似；同一规则若无任何“前缀到尾”的开尾定义，则接受“可能出现横跨 chunk 边界漏码”的局限——适配已有限度，**和现状一样**（现有规则集闭内 rule “database-connection-string” 不入流式表，文档里如实说明）。收尾用 💡开关在哪里：每条规则表加 `streaming: "exact" | "prefix" | "none"`，写明每条规则的值。
- **验证器（防漏）**：新增测试用例——对每个mask 正向样本（机器密钥）遍历所有切分偏移，模拟流式输入，断言 `flush()` 后输出 = `redactMachineSecrets` 整段值。凡是 streaming 标为 none 的规则不在生 sample 里出来（但这类规则要求 match 起使形态本身能匹配时夺取；`boss门控` 面下注）。
- **持有开始比较**的便利成本：加 markers（如 `"SG."`、`"xoxb-"`）会让一撮闻名出现的正文被扣住几秒——但注意：这个表在两处使用（P7）：模型输出 chunk（每 delta 前调用，只有“疑似密钥角逐”区扣）与 UI 实时输出（只看当前 sentence；成本轻微）。擦边情况如 `SG.` 这样的双字符前缀在 21 字符的现有系统已经有同样扣法，扩大到 50 会拉长平均持有时间——评估：只有模型输出的文本尾部出现极其罕见的 brand 前缀才扣得动“新加坡国花， e.g. SG. 磨坊”这种尾随量，但 chunk 缺少（被扣住 1-2 个 chunk）代价主要在 UI 显示延迟，可接受；另外 organizer of held onlemagne 记账到跟踪 — 未实现、不拟此回。

### 5. 怎么证明“没漏遮、误遮可控”（问题 5）

四道证物，一个统一门槛（新增脚本 `npm run check:sensitive-capture`，挂进 `check:steps`——本步不能只靠 `check:egress-redaction` 签名检查）：

**心肌一：上游语料等价（防漏遮）。** 用 secretlint 各规则包 snapshot 用例（P17/P18：每 case 目录 `input*` 文件 + `output.json`，官方测试器机制原样）+ detect-secrets 自带 tests（`detect-secrets/core/tests/plugins/keyword.py` 的用例，未核实清单——移植时逐条读）。生成为我们仓内 fixture 的 JSON：`test/assets/upstream-corpus/{secretlint,detect-secrets}/{rule}/{case}.json`，断言：
- secretlint 源码语料里所有 output.json 报出的 span，我们的 `redactMachineSecrets`（或更确切：可达的 machine-key 集合）至少有一条规则命中该 span；
- 不搬的规则（npm/gcp/filter-comments）在 ADR 上“例外规则清单”里登记，不参与等价测试。
动态比较：**等价的最强对照还是上游实现本身**，所以另有一个测试模式：把上游 `@secretlint/secretlint-rule-<x>` + `@secretlint/core` 做成 **devDependency（精确版本）**，提供一个仅 CI 里跑的、node-only 的工具脚本 `scripts/sensitive-capture/upstream-oracle.mjs`：读同一语料两边 request，打差异明细（一致性以 `secretlint 版本号` diff 也许有偏差——上游 snapshot output 里的 span 数据结构完全依赖 creator；不必复刻 range；只需“命中/不命中”布尔级对齐即可，差一位用例外 white list case 备案）。等价门槛是*布尔*门：我们漏的必须有解释或补齐。

**心肌二：现有正向不回退（防清零）。** 把当前 `machine-secrets.unit.test`（`MACHINE_SECRET_RULE_IDS` 断言，P10 引）和 `redaction.unit.test.ts:4-51` 的正向样本列守则化：新断言是「对每一个历史 rule id，至少存在一条 fixture，旧 scan 命中且新 scan 也命中同一 span」。这意味着**给某条规则执行行为退化时，用例开跑就失败**——反向用例真正的失败机制（删 ALGO 对应的表项→旧新鲜样本仍绿但检测丢→我的测试红——因为正向样本分布含每条规则至少 1 例）。

**心肌三：误报防火墙（防 FP 爆炸）。** 三层：
1. 现有 negatives（redaction.unit.test.ts:53-71）不动，继续为 0 新寻；
2. 新增 negatives：A 修正集（每条新规则 FP 假想 5-10 条：教学例 `sk-proj-demonstration-purposes-only`、官方文档里的假样本 `AKIAIOSFODNN7EXAMPLE`(builtin ignore)、`$DATABASE_URL`、`password equals ${CONFIG.password.value}` 等）；
3. **黄金提示词共振**：读 `apps/agent-service/test/__prompt_golden__/*.txt` 全部文件（含 memory.capture.txt:7-11 那段），断言 `redactForEgress` 0 findings。这条特别防“keyword 面欢乐漏接”——被打扰的 `0 到 1000` bug 本属另一个线程，但在它 landing 前，凡是命中 golden 也算我们的回归——也是验证“排除层必须先上”的直接证据。

**心肌四：性能。** 一次性通过：`scripts/sensitive-capture/perf.mjs`——自以 1 MB 混编中文文本（句语料 + 单例每规则）上跑扫描/遮盖/流式取久久。门限初值定为「1 MB 单次 pass ≤ 100 ms」——**T3**：由首轮实测填定，定完写进 test 断言（[secretlint issue #19 有一条参考锚点：上游推荐集 1 MB 16.9 MB 跑 391 ms / core（node产，范围近似——我们的交挂可以受限ATCH）]（P19））。性态门挂在 `check:steps` 单步（温和两层允许 CI 上机器差/超 2x 而权旋），与 unit 截断分开。

最终者加一道 **全暴露反向审查**（模拟间故事，已在 I-73 教训出处 recognized）：`npm run check:sensitive-capture` 里加一条“用例删除”自防御测试（corpus 里抽查规则表是否含每一个 origin 注释里 step 的 rule id）——保证未来 clean-up 别把整个第三方 origin 块静默干掉。

### 6. 上线：一次已发内容变化的处理 + ADR（问题 6）

**事实基线（展示推理链）**：已经发出的历史存的是遮盖前原文（prompt-prefix.md:36 第 5 条），每次请求出口逐段重新遮（P7）。规则升级后，**每个已开过的对话的下一次请求**：全部历史消息按新规则重遮，在一批字节处与上轮不同 → 请求体前缀不再逐字节等于缓存的前缀 → 该对话该服务方缓存整段失效一次，此后回到稳定恒定的字节。这**本来就有语义**：遮盖规则是规则 5 已登记的唯一例外（「存历史时存实际发出去的那一条……出口遮盖是唯一的例外」原文），本次只是**例外本身的效果范围变化**。

**ADR（单份,新建 `docs/adr/0170-upgrade-sensitive-capture-rules.md`）应包含**（按 ADR 0167 同体例）：
1. 背景 + Andy 拍板原话；依据 secretlint 13.1.0 / detect-secrets 源码行号清单与仓库行号对照表（**为审计条文实打实的第三国许可兼容性声明**含：secretlint MIT 通知行 + 上游行号 URL + detect-secrets 信容 Apache-2.0 与 bandit 溓 MIT 式头（P20）——两者都是许可下游携带原通知 + 标明改动；我们照此办 (目标 5)。）
2. 决策：两端作用面、被搬/被跳规则的对照表（包括 npm/gcp/filter-comments/AWS-ID 的不搬理由）、流式 streaming 等级逐条标定（问题 4 表）。
3. **缓存影响段落**（按 Andy 要求加型）：点名修改 `.claude/rules/prompt-prefix.md` **第 4 条的例外清单**——原句在第 35 行是「例外只有三种：第 6 条…；第 7 条…；第 12 条…」，新增第四种：「有 ADR 依据的遮盖规则升级」。例外段落引用本 ADR；第 4 条本身规则锚同文档其他例外以逐字同法撰写。**已发内容的处理方式：储备无迁移、注册无轮换，只有“下一次发送时前缀不同一次”这个一字段事件**。
4. 上线预期与监控（必要）：部署后 24-72h 内 follow-up 命中率指标按对话仰卧（`cache.follow_up_low_hit` + `scripts/operations/cache-hit-report.mjs --by turn`（P14）），预期一次性 dip；异常判定规则写明：高于两个基线数据点（例如连续 3 天命中率 <50%）才触发日志。
5. 回滚方案：规则表自带 `surfaces` 开关，但**注意 bytes 处不能再回滚**——一旦发出新遮盖字节，回滚又会切回一次旧遮盖字节，形成第二次失效（这是我方案里最应留着不回滚的理由），要在 ADR 里「回滚会让已发内容再次变化，代价等价再做 N 处」的 wording；回滚仅接受字以上**代码层面**（反正数据没存在同一格式中）。
6. 未处理部分（保留 ADR 0167 的诚实口径）：三份 node 脚本副本不同步（P9）；`redactWebContentSecrets`（web-content.ts:1-2）不在本次范围（详细说明区域问题）。

---

### 7. PR 划分、顺序、与另一线程谁先（问题 7）

**排除层（另一线程）先合，理由最硬的一句**：排除层是所有新规则的“减震器”——它修的“0 到 1000”是**现有验证码规则**打出来的；我们的改动字面上会影响 golden prompt 的 FP 面积（“день”的 suspicion face）。若排除层后上，我们新增的 `candidateSecretFindings`/拦截面会连用它未反馈的深度出现新误拦；若排除层先上，我们的新规则长在既有排喊层上，`candidateSecretFindings`/拦截面读02层就一举成合。效果上：**排除层是本方安在两图行上都会外的 goal 処理**；我们每 PR 需实上它的合并纪录，未就绪 PR-3 的激活延迟。

建议 5 个 PR（除排除层外全由本线程做），依赖链向箭头：

| # | 主题 | 内容 | 依赖 |
|---|------|------|------|
| PR-1（无行为） | 对照语料落地 | `test/assets/upstream-corpus/`（secretlint 27 条的 snapshot 用例 + detect-secrets 用例摘录）、devDependencies 增 `@secretlint/secretlint-rule-*`+`@secretlint/core`（精确 13.1.0）、`scripts/sensitive-capture/upstream-oracle.mjs`、`perf.mjs`；**不碰 src/** | 无 |
| PR-2（行为变更 A） | 机器密钥升级 | port + rule 表 + MACHINE_SECRET_RULE_IDS 扩 + `check:egress-redaction` 签名（新增 `secretlint` 版本签名不改）+ 拦截页面/P6/契约端到端测试 + `ci/security-exceptions.json` 更新（新测试里假密样例给 Andy 审核） | PR-1、排除层已合或约定 |
| PR-3（行为变更 B） | 密码关键词升级 | detect-secrets `keyword` + heuristic 家族 + 两段式在 redaction.ts + `password-keyword-denylist` id | PR-1、PR-2 已合 |
| PR-4 | 文档 + 收口 | ADR + `.claude/rules/prompt-prefix.md` 第 4 条例外 + ADR 0167 “未处理部分” 补充一并签改 | PR-2、PR-3 |
| PR-5（可选） | 等价门槛部件 | `check:sensitive-capture` 挂 `check:steps`；等价/抖动/正问/负问/性能/流式（P12 收口） | PR-1→PR-3 陆续 |

**顺序的要点**：PR-2、PR-3 尽量在同一周合入同一 release——两次规则升级分两个部署日会造成两次缓存全失效，代价翻倍。若时间上必须错开，ADR 里写明「第二次按同样的例外提前记录」（除非 Andy 决定只一次性装再一 throw）。

**结构优点**：这个切分（先私有测试、再机器密钥、再密码、给文档）的主要原因：
- 机器密钥规则新 FP 面（品牌 token 需要 xoxb_ 这类）远低于密码 keyword，可以对应独立收合，确认一对；
- 排除层（另一线程）在第 3 PV 后，密码 keyword FP 是需要这场硬点（预定跑動 golden 指标：禁能执行直至排除层或必须要没有特狂 FP）——是**必须处上下风鰆 VC 的 gives**。

**设想具体 cripple**：若 PR-2 上线后影响数值确认过 wait 告警，PR-3 而与规则早跑步【标定和 damping】 unions 組合,中间事处于改动区间【初始允许 bug 範�所有的必答 四 问 重新 balanced answer 】**"柏点提前"**。

## 三、考虑过但不选的做法及原因

| 做法 | 不选的原因 |
|------|-----------|
| A. 运行时直接依赖 `@secretlint/…preset-recommend` + `@secretlint/core`（用 `lintSource`） | 84 个同步调用点全要 await 化（P3）；lintSource 异步（P18）；包增重 230 KB 逆 P12 "浏览器里也能用"；推荐集含 filter-comments 和文件依赖规则，要么接受要么绕过；字节确定性取决于上游的 contentType/实现细节。 |
| A′. 运行时依赖 26 个单规则包（跳过 preset），自己随便搭 hall | 同 A′ 的同步问题；规则号上加 26 条 npm 依赖违反 P12 的零依赖；还需要自己 fabricate `SecretLintRuleContext`。 |
| B′. 只把 secretlint 规则用于遮盖面、不动拦截面 | 会让 `assertMachineSecretFree`（P7）自检出现“遮了又漏”的矛盾（新 AWS secret key 遮后值的不匹配等）且名不符“升级识别规则”； Andy 目标 1 的意思就是让整个识别能力变严。 |
| C. 密码两段 merge 成一个超级正则 | 单正则难同时表达“CJK 无引号+分隔符”和“detect-secrets 引号家族”，容易把第一段现有正向改字节（违反“现有规则一条不删”的字面映射不理——必须 rup pair），测试断言难对齐上游。 |
| D. 双过滤家族（C 家族 QUOTES_REQUIRED 也 port） | 无文件类型的聊天里它要求携带 "filetype" Lyft，是個额外虚幻输入源（不选择：`必答 2` oracles）；QUOTES_REQUIRED 已经行） |
| E. 用 secretlint 的 `filter-comments`（`secretlint-disable`）或提供 `keywordExclude` 的免费"comment"行 | 与 `is_line_allowlisted` 同理：聊天里任何人复制一行注释关掉检测（Andy 已拍板不搬 detect-secrets 的这个；secretlint 的等价物也要删） |
| F. 把 3 个 node 脚本副本一起升级成新规则 | 会把新规则强加到“仓我们自己的文件扫描”（`check:secrets`），带来实际 FP；成本超过收益（P9，ADR 0667 已把它列为未处理部分） |
| G. 在规则升级同批实现 `redactWebContentSecrets`（web-content.ts）同步升级 | 对象不同（非模型眼里的机器密钥仅遮挡），且修改体现装备点不同；扩大 PR 覆盖、另行议 |
| H. 在上游同版本下增加可选勘查 API (`detectPerBrand` etc.) | 上游缺推介API、标记对等；小心已知差距（同上），更像过度工程；过把简单参数的 `秘密词幕秘` 已经涵盖 |

## 四、风险和反例

- R1 **湖额外 MCP 顶住（修不了完全）**：16.9MB 滥塞一个含 6 个 base64 密钥的日志 (P19) 证实：上游自家查不到 base64-wrapped。我们搬同步列表同住此样 — 即“施”（不改成 base64 解码（成本高、且 decode 有化低 byte 索引正则报的换行結構性的 violate），也不做文件向便捷处理。**登记**此为 known limitation 显 ABOVE。推进坐标：模型输入内容已由出行路径 à chushiyima deal()ing 加计, chat 里 base64 包裏密钥确实是存在残余风险；ADR 记多数 bank to claim可接入（同位 AS baseline）。
  反例：聊天里 `HTTP/1.1 Auth: Basic am9objpzZWNyZXQ=` 会命中 basicauth（明文 Basic），但 base64 包的 whole JSON 会漏——接受（上游同样漏）。
- R2 **多指正则：** many不会 reg 正则; USD 40char AWS secret key `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`(其 builtin-ignore 样本之一存储 in bundle) 形式上我们规则的新拦截直接匹配真 40 基字符串 — 《真理 1：**ucecate探寻自己的 3个正则需要真假铁定的anusしい**: for each 非排，锁定 fixture crawe自 playground repo (`test/fixtures/production-sandbox-scope.ts` etc. 目录夹 place 假密钥的已有惯例）需要检查 + gitleaks 白名单更新（P10）。
- R3 **流式尾巴-跨界漏洞**（问题 4）：无尾则的国际规则（如 database-connection-string 标志 `postgres://u:p@`) 可能在跨越 chunk 边界处独漏——同现状；证明是“证明不会在 streaming hold 状态下得到首误遮…**仅对 exact 级规则验证**（P5 testing 过程）。凡 streaming=none/prefix 级，测试不覆盖（书面注明）。
- R4 **每请求 re-產生新输入长文 görün":** threshold **性能**；keycloak threshold 在 PER TEST 上限 wait in 载入& 产 B Bil 层 per-file reuse 或用取简版不需化 (fine)。
- R5 **许可/信容**：Apache-2.0 要求 **NOTICE 相附**（若上游有），MIT 只的需求任何 brand 名保留。port 时均会生成 `NOTICES.md`（一处集中列到每条规则的 URL+version+license+我们改动的内容摘要）。人工负责、工 UI trust 从手。.
- R6 **两个版本资料会错过 every scan 验证 vies g.** backtracking performance 数据以 none 定義 regex fuel (make my own performance tests mandatory)。证：Catastrophic 回溯风险最大的候选已是 bucket-control aware（P21 1000-衬限制）。
- R7 **误拦增长**（问题 2）：90 处拦截面里 memory / reminder 的 FP 会从该名条规则上**映射到全部记忆路径**（P6）。这是有意的、冒风险的代价比；缓解靠/card剥离规则即“悲护改_单条下线”"（组合政策即一个按条规则 flagged 级别的 block 转换开关）。门：上线观察拦截记录页两周再决定各 `block` 状态。
- R8 **base64 / 非 plain 密钥的漏报**（同 R1）和普遍漏报的定向—不上 bidirectional base64 展开（跟上游同步）。记录 ADR。
- R9 **限值校验** （I-73 教训）：所有新 rule id strings要走两 128 字限与 string 初始化。避免 id 或 kind 生成 from UTF–8 余录，最终字符串预期 ASCII+或 UTF-8 编码无 special byte。把此写在 rule 表结构上加一条 assert 测试 (`check ≤128` 的 doc 断言条款，门id-only test)。作成现象.
- R10 **回滚第二次失效**（P6 上线 ADR 的注意事项）：规则变更后回滚（restart the old rules）会重新走一次缓存历史重算——上线下窗口期 prompt-prefix 门可能撞 `npm run check:prompt-prefix` 反向用例不 fail；但 deploy 前必须重新手工 run `check:prompt-prefix`。

## 五、需要人拍板的取舍

1. **`is_potential_uuid` 保不保留**（第三题）：保留减 FP；删除少一条隐性宽容。我倾向**保留**。
2. **PR-2/PR-3 是否必须同一 release**：不合期就会两次全量缓存失效（成本 ×2），ADR/规则例外要 1 份还是 2 份。我倾向**同一 release**。
3. **误报处置机制**：`surfaces.block` 的关闭是否要 Andy 逐条拍板，还是工程可自主下线、页面每周报？我倾向**工程自主、Andy 月度看拦截页**。
4. **`redactWebContentSecrets`（web-content.ts）是否同批升级**（G）：我倾向**不在第 2 步动它**，同时 ADR 预填“第 3 步候选”。
5. **回滚语义**（问题 3 表里的 deploy R10）：如果出问题，是接受第二次缓存失效回滚、还是只降级 `surfaces.block` 代码全面回滚？我倾向**接受第二次失效以保持遮盖字节的稳定性**。
6. **AWS `enableIDScanRule` 保持 upstream false 不开**（我建议了）：若 Andy 想要识别 AWS Account ID（非密钥）需是否指定在识别列（成本 = FP 增）， deal threaded 我已建议 false。

## 六、已证实 vs 推测（集中一览）

- 已证实读代码：P1-P14（仓库引用均带行号）；
- 已证实在上游一手网页：secretlint 规则结构 (P15)、AWS 规则实现 (P16)、推荐集 README 和许可 (P17)、快照测试机制 (P18)、issue #19 实测 (P19)、detect-secrets keyword.py (P20)、heuristic.py (P21)；
- 推测/未核实：T1 各规则逐条正则的复杂性欲知工细（PR-1 语料会实测）、T2 UI 层对 ruleId 現場没有校验（需要实现时读 control-center）、T3 性能门限的数值（首轮实测标定）、T4 detect-secrets 测试用例目录的具体名目（PR-1 时核对）、detect-secrets LICENSE 文件本身未打开看（按主人给的 Apache-2.0 动工，PR-4 检核 NOTICE 一致才合入）。

## 七、必答问题逐条

**1. 这个改动会不会改变模型已经见过的请求开头？（是否仍只追加、每轮变的值是否都在最后一条消息里）依据 prompt-prefix.md**
- 会，而且是**一次性、可预期**地变：请求结构（系统提示、工具定义、消息顺序、每轮变的值放在最后一条消息里)完全不动；只有“历史消息按新规则重新遮盖产生的字节”变了（第 36 行出口遮盖例外、P7 的 #prepare 是唯一进入路径）。`npm run check:prompt-prefix` 那套门 (P13/Prompt-prefix.md:73，含反向用例) 仍会通过，因为遮盖结果字节变化不影响"追加性"结构断言——门比较的是请求间的恒前缀，新遮盖是整段一齐变化、之后回到稳定。这个例外 Andy 已拍板，落到 prompt-prefix.md 第 4 条例外清单第四项（见上 ADR 段）。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**
- 升级本身会产生一次"由旧规则到新规则"的变化——这是 ADR 例外覆盖的；此后同一文本每次遮出同字节。为保持确定：所有产出是纯函数;不搬 file/timestamp 类上游规则、不引 `allow`/`filter-comments`、数组次序固定（`context` 不取决于 Map 和 Set 的增长序列——只有 `known` Map 插入序固定）、`escapeRegExp`/模板皆字面构建（redaction.ts:267-274 已有惯例）、不引入含时间的字段。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**
- 有：新 `check:sensitive-capture`（问题 5 四道心证入为门）挂入 `check:steps` (P8)。反向用例及失败机制：删一条机器密钥规则→正向语料 span 命中测试红（每条规则至少有一条 fixture）；让某 keyword 规则匹配 `0 到 1000` 类文本→golden prompt 测试红；把疑似密钥切分过 chunk→streaming 等价测试红；时间条件使用下暴露规则 missing→"每条 origin 注释要求存在的自防御测试红”。这个反向究竟会不会真 fail？是：正向语料是打包进 fixture 的独立测试文件、断言是对**具体 span count** 的精确期望—— 一旦数据源删一行，测试在 vity 断言 fail。另一类反向是 `check:egress-redaction` 的：新增规则若写在包外,签名比对红（P8 已有反向用例`.

**4. 每个值的两端核验（改动产生或修改的）**
- `MACHINE_SECRET_RULE_IDS` 新增 id（`secretlint-*`）：生产端 machine-secrets.ts RULES 表 + `Object.freeze`；消费端逐个核：a）`memoryCategory` 用数组 includes（P5，application/sensitive-interception-recorder.ts:33）——新 id 自动映射，不需改；b）SQLite 落库 `boundedText(ruleId,128)`（P5 :52）——我们的 id 全 ASCII 短串，通过；c）网关合约 category 枚举不变（gateway-contracts 不包含 ruleId,P5 :670-707），所以 `I-73` 那种“清单 id 过不过后端校验”的破口不存在于本方案——后端三层（端口 string、SQLite 128 字缀、合约不传 ruleId）都能接受任何合理新 id；d）`MemoryExtractionAuditRecord.secretFindings.ruleId: string`（ports/automatic-memory.ts:163）——同样通过；e）UI 层（未核实：若控制中心页面有 ruleId 白名单或翻译映射，则新 id 需要补—PR-2 里实现前检查 control-center 的敏感拦截页面组件；我已查 ports/SQLite/合约三层都没有，UI 若有需更新).
- `EgressRedactionRuleId` 新增 `password-keyword-denylist`：产出在 redaction.ts `see("password", 新id, …)`；消费端 model-egress.ts:197-207 的 sightings（只用 kind 做 category）→ 通过；拦截记录页同上。`kind`/`category` 枚举无新增 (machine-secret、password 原有），网关合约不用改（P5）。
- `[密钥]`（MACHINE_SECRET_PLACEHOLDER）和所有 EGRESS_PLACEHOLDER_PATTERN 占位符不变（redaction.ts:55-60）,下游所有已知占位符识别不变。
- `POTENTIAL_SECRET_MARKERS`/`ACTIVE_SECRET_SUFFIXES`/流式表内部常量扩（machine-secrets.ts:91-124）：仅被 `machineSecretHoldStart`（同文件）和 `execution-live-feed.ts:46`、`pi-model-transport.ts:336` 三处消费（P7，grep 证实），语义向后兼容（新增扣住标记只可能多扣、不可能少扣其它规则匹配）。
- devDeps 新增 `@secretlint/*`：仅 node、仅测试期使用（PR-1 oracle 脚本），精确版本 13.1.0，不进 product bundle,P12 依赖约束不破坏。scripts/scan-machine-secrets.mjs 等副本不动（F 方案不采纳，P9，已知缺口照旧）。
- `ci/security-exceptions.json`：PR-2/PR-3 新增 fixture 的假密钥行号更新后由 Andy 审核（P10）。

顺带说明 my ordering of coverage：三处最容易踩 I-73 的时刻是“**新 id 出现在小页面/合约/SQLite 三处任何一处设限**"——方案里这三处全部逐一验证过（P5 的三个行号），唯一未核实层是 UI（T2）。
