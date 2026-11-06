## 结论摘要

这份方案的方向是对的，但有几处会直接违背它自己定的“观察期只遮值、不拦截”和“每条规则可按数据申请开拦”的目标。最严重的是：新增的密码关键词规则会经由 `credentialFindings` 在自动整理记忆里变成**阻断**；观察记录本身又因为去重键和接口契约不含 `ruleId`，无法按规则归因。另有多处上游 secretlint 的“示例跳过名单”会把真实密钥放过去，而“标准答案对照”天然检测不到这些漏报。

---

# 一、证实的问题

## 高严重度

### 高 1：新密码关键词规则会在自动整理记忆等路径变成阻断，和“观察期只遮值”直接冲突

- **问题**：方案第 2 节说约 30 处“整段拦下”继续只用现有 7 条规则，新规则 `surfaces.block` 一律 false；第 3 节却新增 `password-keyword-denylist` 并放进 `redactForEgress`。自动整理记忆并不是通过 `scanMachineSecrets` 判断密码，而是通过 `credentialFindings`，后者会读取 `redactForEgress` 的 password finding。
- **证据**：
  - `packages/application/src/services/automatic-memory-service.ts:73-80`：`candidateSecretFindings` 调用 `credentialFindings(text)`。
  - `packages/sensitive-capture/src/redaction.ts:301-308`：`credentialFindings` 收集 `redactForEgress(input).findings`，并用 `CREDENTIAL_KINDS` 过滤出 `password`。
  - `packages/application/src/services/automatic-memory-service.ts:137-142`：只要 `candidateFindings.length > 0` 就 `candidate_secret_excluded` 并丢弃候选。
  - 因此任何被新 `password-keyword-denylist` 命中的记忆候选都会被整条拒绝，包括误报。方案只锁了 `scanMachineSecrets` 只认现有 7 条，锁不住这条路径。
- **建议**：把“稳定规则/实验规则”分开。`credentialFindings` 只接受已批准的规则集；观察期内 `password-keyword-denylist` 不应进入 `candidateSecretFindings`，除非单独把“自动整理记忆也开新密码规则”作为 Andy 的显式决定。补一条自动记忆反向测试：`记住 secret: abc123` 在观察期内不得被排除。

### 高 2：观察期无法按规则归因，方案依赖的“逐条申请开拦”没有数据基础

- **问题**：方案要观察约 2 周后“逐条申请开拦”，但拦截记录的去重键、指纹、快照契约和界面都不带 `ruleId`。同一段值被多个规则命中时会被合并，且先写入的 `rule_id` 永远不会被更新。
- **证据**：
  - `packages/persistence-sqlite/src/sqlite-sensitive-interception-operations.ts:61-75`：去重键的 JSON 是 `[threadId, source, purpose, part, category, fingerprint, outcome]`，没有 `ruleId`。
  - 同文件 `:128-130`：冲突时只更新 `last_seen_at` 和 `seen_count`，不更新 `rule_id`。
  - `packages/application/src/services/model-egress.ts:197-205` 和 `:493-501`：指纹只对 `kind + value` 做 HMAC，不带 `ruleId`。
  - `packages/gateway-contracts/src/contracts-v2.ts:665-712`：`sensitive.interceptions.snapshot` 没有 `ruleId`。
  - `apps/control-center/src/components/sensitive-interceptions.tsx:160-163`：界面只显示 `item.category`。
- **建议**：把 `ruleId` 纳入指纹和去重键，或在记录层新增按规则汇总的独立表/报告；给快照契约增加 `ruleId`（或加一个内部按规则统计的查询），并补一条“同一值被两个规则命中时两条规则都能被统计”的测试。否则第 2 周的“按规则审批”只能拍脑袋。

### 高 3：上游的“示例跳过名单”在出口遮盖里是真实漏报，标准答案对照也发现不了

- **问题**：方案保留 secretlint 的“像示例就跳过”名单，但 secretlint 是文件扫描器，它的允许名单包含 `user/admin/root/pass/secret` 这类常见子串；basicauth 用的是 `includes`，不是精确匹配。很多真实密码会因此完全不被遮。
- **证据**：
  - `@secretlint/secretlint-rule-basicauth@13.1.0`：`BUILTIN_IGNORED_PATTERNS` 包含 `"user"`、`"admin"`、`"root"`、`"pass"`、`"secret"` 等；`isLikelyRealPassword` 中有 `if (BUILTIN_IGNORED_PATTERNS.some((pattern) => password.toLowerCase().includes(pattern.toLowerCase()))) return false;`（https://cdn.jsdelivr.net/npm/@secretlint/secretlint-rule-basicauth@13.1.0/module/index.js）。
  - `@secretlint/secretlint-rule-database-connection-string@13.1.0`：`isLikelyRealCredential` 中 `if (username === password) return false; if (password.length < 4) return false;`（https://cdn.jsdelivr.net/npm/@secretlint/secretlint-rule-database-connection-string@13.1.0/module/index.js）。
  - 方案前提第 7 条和设计第 1 节都写“上游的示例跳过名单”，并把它作为规则清单的一部分。
  - 由于“标准答案”就是同一套上游规则，`admin1234`、`mysecret`、`user:user`、3 位密码这类真实泄漏在对照测试里也不会失败。
- **建议**：不要移植子串 allowlist。只跳过明确的示例域名（`example.com`、`localhost`）和精确模板（`${password}`、`YOUR_PASSWORD`），不要用 `includes("admin")`。为 `admin1234`、`superuser!`、`mysecret`、`user:user`、`abcd` 补反向测试，要求我们遮住，并在移植文件头记录这是有意偏离上游。若坚持保留，必须把它列为“已知漏报”，不能算作“已保护”。

### 高 4：流式遮盖和批量遮盖用的不是同一套规则，密码关键词加进 markers 后会出现“只停留、不遮盖”

- **问题**：`StreamingMachineSecretRedactor` 只调用 `redactMachineSecrets`；实时执行输出先调用 `machineSecretHoldStart`，再用 `redactTracePayload`，后者同样只做机器密钥。方案第 4 节却说把“新的密码关键词”加进 `POTENTIAL_SECRET_MARKERS`，测试还要求结果等于 `redactMachineSecrets(完整文本)`。密码关键词规则在 `redactForEgress`，不在 `redactMachineSecrets`。
- **证据**：
  - `packages/sensitive-capture/src/machine-secrets.ts:154-176`：`StreamingMachineSecretRedactor.append/flush` 都只调用 `redactMachineSecrets`。
  - `packages/runtime-pi/src/pi-model-transport.ts:336,386`：模型输出流使用 `StreamingMachineSecretRedactor`。
  - `packages/application/src/services/execution-live-feed.ts:46-48`：实时执行输出用 `machineSecretHoldStart` 加 `redactTracePayload`。
  - `packages/application/src/services/trace-redaction.ts:5-6`：`redactTracePayload` 内部调用 `redactMachineSecrets`。
  - `packages/sensitive-capture/src/redaction.ts:215-220`：密码规则在 `redactForEgress` 里，不在 machine 规则里。
- **后果**：把 `password`、`secret` 等 marker 加进去以后，流式逻辑可能因为“看到潜在开头”而不输出，但 flush 时不会遮密码；测试如果拿 `redactMachineSecrets` 当正确答案，会把这个漏洞当成“通过”。
- **建议**：定义一个统一的流式入口，使用和 `redactForEgress` 完全相同的规则集和规则顺序；模型输出、实时执行输出、`execution-live-feed` 都用它。测试的正确答案必须是 `redactForEgress(完整文本)`，不是 `redactMachineSecrets`。如果暂时不想动密码流式，就不要把密码关键词加进 machine markers。

### 高 5：新规则的“值边界”与“上游认出的范围都必须遮住”自相矛盾，带空格的带引号密码会漏

- **问题**：方案说密码关键词的值边界沿用现有 `[^\s,，;；]+`。但 detect-secrets 的配置写法和带引号写法允许值里包含空格（只排除换行、引号、逗号、反引号等）。`password: "two words"` 在上游会遮 `two words`，按本方案只会遮到空格前的 `"two`，留下 `words"`。
- **证据**：
  - `packages/sensitive-capture/src/redaction.ts:62-63`：现有 `PASSWORD_ASSIGNMENT` 的取值是 `[^\s,，;；]+`。
  - detect-secrets v1.5.0：`SECRET = r'(?=[^\v\'\"]*)(?=\w+)[^\v\'\"]*[^\v,\'\"`]'`，允许值内部有空格；`FOLLOWED_BY_COLON_QUOTES_REQUIRED_REGEX` 和 `FOLLOWED_BY_EQUAL_SIGNS_QUOTES_REQUIRED_REGEX` 用引号包住整个值（https://raw.githubusercontent.com/Yelp/detect-secrets/v1.5.0/detect_secrets/plugins/keyword.py）。
  - 方案第 5 节又写“上游认出的范围我们都必须遮住”。
- **建议**：新密码规则用上游的引号感知边界；或者把“标准答案”限定为单 token 值，并明确记录带空格值会漏。补 `password: "two words"`、`secret: foo bar` 用例，要求整段被遮。不要为了复用现有边界而降低“不漏”的标准。

### 高 6：把 DSA/PGP 加进 `PRIVATE_KEY_BOUNDARY` 是新的阻断行为，观察期测试覆盖不到

- **问题**：方案第 1 节说“另把 DSA、PGP 加进私钥边界”。`PRIVATE_KEY_BOUNDARY` 被 `containsToolOutputSecret` 用来整段拦截；这不是新规则的 `surfaces.block`，所以“观察期内 `scanMachineSecrets` 只认现有 7 条”的测试锁不住它。
- **证据**：
  - `packages/sensitive-capture/src/machine-secrets.ts:56`：`PRIVATE_KEY_BOUNDARY` 当前只覆盖 `RSA/EC/OPENSSH`。
  - `packages/sensitive-capture/src/machine-secrets.ts:58-60`：`containsToolOutputSecret` 在 `scanMachineSecrets` 之外还要看这个 boundary。
  - 使用它的阻断路径包括 `apps/agent-service/src/production-host-read.ts:76-79`、`packages/application/src/services/automatic-memory-service.ts` 之外的 `production-file-preparation.ts:68`、`packages/platform-node/src/files/pi-output-export.ts:43`、`pi-host-publication.ts:139,160-161`、`apps/agent-service/src/capability-programs/pi-coding-request.ts:207`、`production-muse-intake.ts:457`。
- **后果**：DSA/PGP 私钥从上线第一天起会被阻断，和“新格式先只遮值”不一致；而且没有测试覆盖这些入口。
- **建议**：明确决定 DSA/PGP 是“立即阻断”还是“只遮值”。如果只遮值，不要改 `PRIVATE_KEY_BOUNDARY`；如果阻断，把它写成显式例外，并逐个入口加测试。测试应直接覆盖 `containsToolOutputSecret`，不能只覆盖 `scanMachineSecrets`。

## 中严重度

### 中 7：“模拟模式”名不副实：遮值就是执行，不是只观察

- **问题**：方案引用 Purview 的 simulation mode 和 Cloudflare 的 Flag，但这两者都是“不执行策略/只记录”。本方案却让新规则直接进入 `redactForEgress` 的在线路径，立刻改变发给模型的字节、用户看到的内容、邮件内容和自动记忆行为。遮值本身就是执行，不是观察。
- **证据**：
  - Purview 原文：“see the impact of a policy on your production environment without enforcement”（https://learn.microsoft.com/en-us/purview/dlp-simulation-mode-get-started）。
  - Cloudflare 原文：`Flag - Record the detection for audit purposes without blocking`（https://developers.cloudflare.com/ai-gateway/features/dlp/set-up-dlp/）。
  - 代码路径：`packages/application/src/services/model-egress.ts:189-218` 在发请求前直接调用 `redactForEgress`，没有单独的 shadow 分支。
- **建议**：要么加真正的 record-only 模式（记录 finding、不改变字节），要么在方案里明确写“观察期只关阻断，遮值仍然执行”，并且只把高把握的固定格式令牌放进遮值，把密码、数据库连接串、basicauth 这类高误报规则先放在 record-only。否则“观察 2 周”期间用户会先承受误遮。

### 中 8：规则文件和缓存文档只改了第 4 条，没改“确定性”的条件

- **问题**：新增规则集版本后，同一段文字是否保持相同字节，不只取决于“遮盖密钥不变、历史不变”，还取决于“规则集版本不变”。当前规则文件和缓存指南都没有这个维度。
- **证据**：
  - `.claude/rules/prompt-prefix.md:36`：“遮盖密钥不变、前面的历史不变时，同一段内容每次遮出的字节相同。”
  - `docs/kv-cache-guide.md:60`：同样只写“遮盖密钥不变、前面的历史不变”。
  - `packages/sensitive-capture/README.md:19`：“同一段文字，每次遮出来的字节必须相同”，没有任何版本条件。
  - 方案第 6 节只说要改 `.claude/rules/prompt-prefix.md` 第 4 条的例外。
- **建议**：第 4 条加“有 ADR 依据的规则集升级”这一例外；第 5 条和 kv-cache-guide 同步改为“遮盖密钥、历史、规则集版本不变”；README 也加版本条件。ADR 里明确 `RULESET_VERSION` 是规则集版本，且不能放进请求头。

### 中 9：存储路径的“已知代价”被低估，只写了自动整理记忆

- **问题**：方案第 2 节“已知代价”只说新格式密钥可能被自动整理记忆存进数据库。实际上还有提醒、对话检查点、对话标题、沙箱诊断、文件读取后的受保护载荷、网页抓取内容等路径也只调用现有 7 条的 `scanMachineSecrets`，新格式密钥会以原文进入存储或下游。
- **证据**：
  - `packages/application/src/services/host-file-read-service.ts:153-166`：`scanMachineSecrets` 通过后直接 `disclosure.protect` 保存文件内容。
  - `apps/agent-service/src/production-reminder-writer.ts:192-203`：只 `scanMachineSecrets`，新格式通过后写入提醒。
  - `packages/application/src/services/thread-checkpoint-service.ts:192-198,228,235`：检查点和候选只 `scanMachineSecrets`。
  - `apps/agent-service/src/production-thread-titles.ts:74,94`：`assertMachineSecretFree` 只认现有 7 条。
  - `apps/agent-service/src/production-sandbox-services.ts:1962`：只 `scanMachineSecrets`。
  - `packages/integration-web/src/untrusted-content.ts:27-29`：网页入库仍然只用旧的 `redactWebContentSecrets`。
- **建议**：把“观察期新格式可原文落库”的路径逐条列出，并决定每处是“接受、遮值、还是阻断”。至少区分“会进模型”和“只存本机”的路径；如果接受，写进 ADR 的风险清单，不要只写自动记忆。

### 中 10：secretlint 标准答案的范围/文件条件没有定义清楚，测试会要么误报失败、要么放过漏报

- **问题**：方案说“上游认出的范围我们都必须遮住”，但没有限定只对照“移植的那部分”。GCP 规则对 JSON 上报的是整个文件范围 `[0, content.length]`；npm 的 `_authToken=` 和 x-oauth 又受文件路径限制。直接拿整个 preset 当 oracle 会对不上。
- **证据**：
  - `@secretlint/secretlint-rule-gcp@13.1.0`：`context.report({ ..., range: [0, source.content.length] })`（https://cdn.jsdelivr.net/npm/@secretlint/secretlint-rule-gcp@13.1.0/module/index.js）。
  - `@secretlint/secretlint-rule-npm@13.1.0`：`isPackageFile`、`isNpmrc` 决定是否检查 `_authToken=`（https://cdn.jsdelivr.net/npm/@secretlint/secretlint-rule-npm@13.1.0/module/index.js）。
  - 方案设计第 1 节说只移植“按内容能认的部分”，但第 5 节又说“上游认出的范围我们都必须遮住”。
- **建议**：定义 oracle 的精确子集：每条上游规则只对照我们移植的 messageId；对 GCP 只比较 `private_key` 字段，不比较整个文件范围；对 npm 提供 `.npmrc`/`package.json` 合成路径。加一条测试：`rules.ts` 中每个 `upstreamId` 都必须有对应的 oracle 映射，反之未移植的上游规则必须显式列出。

### 中 11：`ruleSetVersion` 只出现在方案里，没有生产者/消费者

- **问题**：方案说“记录规则集版本、监控、回滚”，但当前拦截记录的类型、SQLite 表和 V2 快照都没有这个字段。规则升级后，观察数据无法区分新旧规则集。
- **证据**：
  - `packages/application/src/ports/sensitive-interceptions.ts:49-59`：observation 没有 `ruleSetVersion`。
  - `packages/persistence-sqlite/src/migrations/0078_sensitive_interceptions.sql:1-27`：表没有版本字段。
  - `packages/gateway-contracts/src/contracts-v2.ts:665-712`：快照没有版本字段。
- **建议**：要么在 observation/DB/契约里加 `ruleSetVersion`，要么在日志或单独报告里记录。不能只在 ADR 里写一句“记录规则集版本”。加迁移和契约测试。

### 中 12：`ci/security-exceptions.json` 的登记不是“加一行”那么简单

- **问题**：新测试里的假密钥样例要进例外清单，但清单有严格的 schema 和 provenance 要求，方案只写了“按项目流程交 Andy 审核”。
- **证据**：
  - `ci/security-exceptions.schema.json:17-120`：`synthetic-secret` 需要 `kind/id/path/reason/owner/reviewReference/expiresAt`，还包括 `provenance.classification/current/history`，`sourceCommit` 必须是 40 位提交号，`lines` 必须是真实行号。
  - `scripts/ci/security-exceptions.mjs:157-174`：路径必须落在 `test/`、`ci/rules/fixtures/` 或 `apps|packages/<pkg>/test/`；`id` 必须匹配 `^[a-z0-9][a-z0-9-]*$`；provenance 的 count 必须和 lines 对得上。
- **建议**：把例外清单更新作为一个独立 PR 子任务，先提交样例再填 `sourceCommit/lines`，并明确 owner review、30 天到期和 `check:secrets`。不要把这一项藏在“文档 PR”里。

### 中 13：性能门槛只写“Hermes 上不超过现状 2 倍”，不足以覆盖不可信输入和 ReDoS

- **问题**：新规则会在每次出口请求上扫描所有字符串，包括网页内容、工具结果、长历史。secretlint 的私钥、npm `_authToken=.*` 等正则在大输入上有资源消耗风险；方案没有对抗性测试，也没有绝对预算。
- **证据**：
  - `@secretlint/secretlint-rule-privatekey@13.1.0`：`PEM_CONTENT_PATTERN` 使用 `[A-Za-z0-9+/=\s\\]{100,10000}`（https://cdn.jsdelivr.net/npm/@secretlint/secretlint-rule-privatekey@13.1.0/module/index.js）。
  - `@secretlint/secretlint-rule-npm@13.1.0`：`_authToken=([^$].*)` 捕获到行尾。
  - 方案第 5 节只写“先在 Hermes 上测现状，门槛定为不超过现状的 2 倍，写进测试”。
- **建议**：加绝对时间/操作数预算，补超长行、重复前缀、1000 个候选、超大工具结果等对抗输入；超限时截断或跳过并记录。性能测试不要只依赖 Hermes 单机，CI 上应使用相对计数或多次运行取中位数。

### 中 14：规则顺序没有定义，可能改变现有 7 条规则的输出字节

- **问题**：新规则如果排在旧规则前面，可能先吃掉旧规则要匹配的文本，导致现有规则的输出、计数和占位符变化。方案只要求“现有 7 条保留”，没有规定执行顺序，也没有“旧样例输出字节不变”的门槛。
- **证据**：
  - `packages/sensitive-capture/src/machine-secrets.ts:18-43`：现有规则按数组顺序执行。
  - `packages/sensitive-capture/src/redaction.ts:208-266`：`redactForEgress` 也是固定顺序执行。
- **建议**：明确“现有 7 条先执行，新规则后执行”并写成测试；对现有正例/反例做 golden byte 对比。任何输出变化必须是有意的、在 ADR 里列出的。

### 中 15：“合并后不单独上线”没有代码/发布门槛

- **问题**：方案说 PR 2、3 合并后不单独上线，四个都合并且另一个线程上线后一起上线一次。但合并到 main 后，任何一次正常发布或热修都会带上新规则；“不单独上线”只是人工纪律。
- **证据**：方案第 7 节的 PR 表和上线说明；代码里没有规则集开关或 feature flag。
- **建议**：加 `RULESET_VERSION` 和运行期开关/发布门槛，或让 PR 2/3 进入长期分支；至少加一个发布检查，确保新规则集版本只在批准的发布批次启用。

## 低严重度 / 文档与前提问题

### 低 16：私钥覆盖漏掉 `ENCRYPTED PRIVATE KEY`，npm x-oauth 也没搬

- **问题**：上游 privatekey 和现有 `PRIVATE_KEY_BOUNDARY` 都不覆盖 `-----BEGIN ENCRYPTED PRIVATE KEY-----`；npm 规则里还有 `https://user:x-oauth-basic@github.com/` 的内容识别，方案列出的“按内容部分”没有它。
- **证据**：`@secretlint/secretlint-rule-privatekey@13.1.0` 的 `PEM_CONTENT_PATTERN` 没有 `ENCRYPTED`；`@secretlint/secretlint-rule-npm@13.1.0` 有 `XOAuthPattern`。
- **建议**：明确是否在范围内；如果不在，写进“没有处理的部分”，不要写成“移植全部能按内容判断的规则”。

### 低 17：新密码规则把所有命中值放进 `known`，会放大误遮

- **问题**：`redactForEgress` 对 password 使用 `rememberValue=true`，之后会把该值在整个消息和后续消息里再次遮掉。新规则如果匹配到 `secret: the` 这类常见词，可能把后面出现的 `the` 也遮掉。
- **证据**：`packages/sensitive-capture/src/redaction.ts:187-205` 的 `mask(... rememberValue)` 和 `:268-282` 的 `known` 全局替换；新规则设计里没有限制。
- **建议**：观察期内不要把新规则的命中加入 `known`，或者只在长度/字符集/熵达到门槛时加入；把“正常内容语料零误遮”从报告改成硬门槛。

### 低 18：前提第 7 条把 basicauth 和数据库连接串的行为混在一起

- **问题**：方案说“数据库连接串和 basicauth 两条……用户名和密码相同也跳过”。实际上 `username === password` 只在 database 规则里；basicauth 没有这个判断。
- **证据**：database 源码有 `if (username === password) return false;`；basicauth 源码没有。
- **建议**：修正前提，避免据此推断错误的安全边界。

### 低 19：`redactWebContentSecrets` 明确不在范围，但网页入库仍是旧规则

- **问题**：方案说网页导入用的 `redactWebContentSecrets` 沿用现状。新格式密钥在网页抓取入库时不会被遮，只有之后进入模型出口才可能被遮。
- **证据**：`packages/integration-web/src/untrusted-content.ts:27-29`。
- **建议**：在 ADR 的残留风险里写明“网页抓取内容可能以原文落库”，或者把网页入库的规则升级另列一步。

---

# 二、推测 / 未核实

以下内容我没有足够证据下结论，标为推测或未核实：

1. **secretlint 正则的实际 ReDoS 风险**：上游声称已做限制，但我没有在目标输入上跑过；需要对抗性测试。
2. **共享 `/g` 正则状态导致不确定**：如果移植时复用带 `lastIndex` 的 `RegExp` 并调用 `.test()/.exec()`，可能出现交替命中；当前方案没有实现，无法确认。
3. **Hermes 上 2 倍性能门槛是否可达**：没有基线数据。
4. **另一个线程的“Himawari 固定指令不检查”是否按时上线**：当前检出中没有该实现，未核实。
5. **下一个未占用 ADR 编号和开着的 PR**：无法从当前仓库状态确认。
6. **`.agents/reviews/topic-sensitive-step2/round-1/` 两份独立方案**：当前检出不存在该目录，无法核对原文。
7. **`ci/security-exceptions.json` 具体新条目**：样例还没写，无法核对 digest/provenance。
8. **端口到浏览器后的 `atob`/构建目标**：1Password 规则使用 `atob`；Node 22 和现代浏览器都有，但未验证项目构建配置。
9. **Andy 是否同意“自动整理记忆也使用新密码规则”**：从现有材料只能确认“新规则先只遮值”，不能确认记忆阻断。

---

# 三、侧重检查

我按额外侧重逐项查了以下路径：

- **错误路径 / 不可信输入**
  - secretlint basicauth、database connection string 的示例跳过名单：确认存在真实漏报风险（`includes("admin")`、`username === password`、长度 < 4）。
  - privatekey 的 Base64 校验：上游有长度和 magic byte 校验；现有 `private-key-block` 仍会匹配任意内容，属于“多遮”而不是漏遮。
  - 网页抓取内容：只走旧 `redactWebContentSecrets`，新规则不生效。
  - 超长工具结果/长行：新正则会在出口路径上运行，方案没有对抗性资源测试。
- **安全**
  - 自动整理记忆：确认新密码规则会变成阻断（高 1）。
  - 提醒、检查点、标题、文件读取、沙箱诊断：确认只走现有 7 条，新格式可能原文落库（中 9）。
  - 流式输出：确认 model 输出和实时执行输出使用 machine-only 路径，密码关键词会只 hold 不遮（高 4）。
  - 上游示例 allowlist：确认会漏真实密钥（高 3）。
- **资源耗尽**
  - 性能门槛只有 2 倍墙钟时间，缺少超长输入/ReDoS 测试（中 13）。
- **不可撤销操作**
  - 规则集升级会让老对话缓存整段失效一次；方案已承认，但回滚和“合并即上线”的发布门槛没有代码保障（中 15）。
  - 观察期内如果反复调正则，会反复改变已发内容字节，方案没有“观察期冻结规则集”的约束。
- **规则文件 / 文档 / 代码一致性**
  - `.claude/rules/prompt-prefix.md` 第 4、5 条和 `docs/kv-cache-guide.md:60` 只写了密钥和历史，没有规则集版本（中 8）。
  - `packages/sensitive-capture/README.md:19` 的“同一段文字字节相同”是绝对说法。
  - 方案只改第 4 条例外，没改第 5 条和缓存指南。
- **I-73 式端到端值校验**
  - 新 `ruleId` 能通过 SQLite 的 `length 1..128` 和 category enum，但去重键、快照契约、界面都不含 `ruleId`，导致按规则观察失效（高 2）。
  - `ruleSetVersion` 没有 schema/契约字段（中 11）。
  - security-exceptions 的 path/id/provenance 有严格校验，方案没有细化（中 12）。

---

# 四、如果由我来定，我会怎样改这份方案

我会把方案改成下面这样：

1. **先分离“识别、遮值、阻断、记录”四个面**
   - 规则注册表每条明确 `redact`、`block`、`record`，并标 `stable` / `experimental`。
   - `scanMachineSecrets` / `assertMachineSecretFree` / `containsToolOutputSecret` 只使用 `block && stable` 的规则。
   - `credentialFindings` 也只看 `stable`，不能让新密码规则在观察期进入自动记忆阻断。

2. **观察期做真正的 shadow / record-only**
   - 新增规则先只记录 finding，不改变出口字节；或者只对“固定格式、高把握”的令牌（`npm_`、Stripe、HuggingFace 等）允许遮值。
   - 密码关键词、数据库连接串、basicauth 这类需要上下文的规则，先 record-only，观察后再决定是否遮值/阻断。
   - 这比“mask + record”更接近 Purview/Cloudflare 的一手做法。

3. **规则集版本化并冻结**
   - 定义 `RULESET_VERSION`，观察期内不允许改正则；要改就升版本，并明确付出一次缓存失效。
   - 记录 `ruleSetVersion` 到拦截记录或独立报告；版本不能进入请求头/系统提示。

4. **观察数据按规则归因**
   - `fingerprint` 和 SQLite 去重键加入 `ruleId`（或按 `ruleId` 单独建统计表）。
   - 快照契约增加 `ruleId`，或提供按规则汇总的查询/CLI；补迁移和契约测试。
   - 加一条 I-73 式检查：规则清单里的每个 id 从产生到存储、接口、界面都能通过校验并可统计。

5. **流式遮盖统一到一个入口**
   - 用同一规则集、同一顺序实现 `StreamingEgressRedactor`；模型输出和 `execution-live-feed` 都用它。
   - 测试对每个样例在任意位置切开，结果和 `redactForEgress(完整文本)` 逐字节相等。
   - 不再维护手写 marker/未结尾判断；从规则元数据生成，并同时生成“完整/部分”开头的 hold 判断。

6. **标准答案只对照移植子集，并加入上游漏报的反向用例**
   - 为每条移植规则建 `upstreamId -> ourRuleId` 映射；GCP 只比较 `private_key` 字段；npm 用合成 `.npmrc`/`package.json` 路径。
   - 对上游示例 allowlist 做反向测试，确认 `admin1234`、`mysecret`、`user:user`、`abcd` 等会被我们遮住。
   - 如果决定保留 allowlist，写成“已知漏报”，不算“已保护”。

7. **把私钥边界和流式路径的例外写清楚**
   - DSA/PGP/ENCRYPTED 是“只遮值”还是“阻断”必须二选一；如果阻断，逐入口测试 `containsToolOutputSecret`。
   - 不在观察期偷偷扩展阻断面。

8. **文档和发布门槛一起改**
   - 第 4 条加例外，第 5 条和 `docs/kv-cache-guide.md` 加“规则集版本”条件，README 同步。
   - 加发布 gate 或 feature flag，避免“合并即上线”。
   - 性能测试加绝对预算和对抗输入；security-exceptions 单独一个 PR，补齐 schema/provenance/owner review。

---

# 五、必答问题逐条回答

## 1. 这个改动会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？

**上线那一刻会变，之后在规则集版本不变的前提下才是只追加。**

- 系统提示和工具定义：工具定义被 `model-egress` 的 `DEFINITION_KEYS` 跳过（`packages/application/src/services/model-egress.ts:368,441-447`），不会变；但系统提示会被 `redactForEgress` 重新遮（`model-egress.ts:189-218`，`maskRequest` 把 `system` 当普通字符串处理）。所以新的密码/密钥规则可能改变系统提示的字节。
- 历史消息和工具结果：存的是遮盖前的内容，每次发送时按当前规则重新遮（`.claude/rules/prompt-prefix.md:36`）；新增规则会改变这些历史消息的遮后字节。`ThreadPromptBundleService` 只冻结遮盖前的系统提示并校验其 sha256（`packages/application/src/services/thread-prompt-bundle-service.ts:243-255`），不覆盖出口遮盖后的字节。
- 因此上线后每个老对话的第一次请求，请求头会变一次；方案的 ADR 例外是必要的。之后如果 `RULESET_VERSION` 固定、规则不依赖后续消息、顺序固定，才恢复“只在末尾追加”。
- 每轮会变的值仍然在最后一条用户消息里；这个改动本身不把时间/规则版本写进请求头。**但必须确保 `ruleSetVersion` 只进记录/日志，不进系统提示或工具定义。**
- 附加条件：新密码规则会通过 `known` map 使用前文的值（`redaction.ts:268-282`），所以同一段文字在不同前缀下可能遮得不同；这是规则第 11 条已有的“named earlier”例外，但方案要明确它适用于新规则并测试。

## 2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？

**跨规则集版本会；同一版本内，只要规则是纯函数且顺序固定，就不会，但新密码规则会引入“依赖前文 known”的确定性差异。**

- 规则集升级、回滚、观察期调正则都会改变字节；方案已承认升级和回滚，但没有约束观察期不能调正则。
- `is_templated_secret`、`is_prefixed_with_dollar_sign`、`is_indirect_reference` 只依赖当前值/当前行，不依赖后文；但 `is_indirect_reference` 依赖整行，移植时要明确“行”是消息内的行还是整条消息。
- 新密码规则如果继续使用 `known` 和 `table`，同一段文字在不同历史前缀下可能得到不同占位符；这是现有的第 11 条例外，方案要写明并测试。
- 实现上必须避免共享 `/g` 正则的 `lastIndex` 状态、`Set/Map` 遍历顺序、文件路径/文件名判断、以及任何时间/随机值进入规则。规则数组必须固定顺序。
- 建议在测试里加：同一段文字在“前面有/没有密码赋值”的两种前缀下分别遮，确认前缀之前的消息字节不变，只有该规则允许的后文受影响。

## 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

**有相当多测试，但反向用例覆盖不完整，尤其是“新规则不得进入阻断路径”和“按规则观察”这两类。**

方案已有的好检查：

- secretlint 标准答案对照（但要限定移植子集和范围）。
- 现有每条规则至少一个新旧都命中的样例。
- 每个不搬的 detect-secrets 过滤器配一个反向测试，锁住“这种值仍然会被遮”。
- 流式任意位置切开，结果等于一次性遮盖（但正确答案应改成 `redactForEgress`）。
- 提示词金样零命中；正常内容语料报告；确定性和性能测试。

缺失或需要加强的：

- **没有测试新密码规则不会进入 `credentialFindings`/自动记忆阻断**；这是高 1。
- **没有测试 `containsToolOutputSecret`/DSA-PGP boundary 不进入阻断**；这是高 6。
- **没有测试 `ruleId` 在去重键/存储/契约里可归因**；这是高 2。
- **没有测试上游示例 allowlist 的反向漏报**；这是高 3。
- **没有测试模型输出流和 `execution-live-feed` 两处流式都等于 `redactForEgress`**；这是高 4。
- **没有测试规则顺序改变时现有 7 条输出字节不变**；这是中 14。
- **没有测试 `ruleSetVersion` 的存在和消费**；这是中 11。
- **没有对抗性性能/ReDoS 测试**；这是中 13。

“反向用例是否会真的失败”：如果按方案先写测试，`scanMachineSecrets` 只认 7 条的测试在有人把新规则加进阻断列表时确实会失败；但 `credentialFindings`、`containsToolOutputSecret`、`record` 契约这些路径不会被这个测试覆盖。建议把“每个阻断入口都跑新规则样例并断言不阻断”作为独立测试。另建议先写失败测试再实现，确保测试不是只验证实现自己的输出。

## 4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？

逐项核对如下：

- **`ruleId`（`secretlint-<规则名>`）**
  - 产生：`rules.ts` / `EGRESS_REDACTION_RULE_IDS`。
  - 存储：SQLite `rule_id TEXT NOT NULL CHECK (length(rule_id) BETWEEN 1 AND 128)`（`migrations/0078_sensitive_interceptions.sql:18`），新 id 长度可以接受。
  - 校验：`sqlite-sensitive-interception-operations.ts:45-59` 只校验长度 1..128，category 必须是五个之一；新 secretlint 规则都归 `machine-secret`，新密码规则归 `password`，可以接受。
  - **不能接受的部分**：去重键和指纹不含 `ruleId`（`:61-75`、`model-egress.ts:197-205`），快照契约不含 `ruleId`（`contracts-v2.ts:665-712`），所以不能按规则统计/审批。必须改。
- **`ruleSetVersion`**
  - 方案要求记录，但当前 `SensitiveInterceptionObservation`、SQLite 表、V2 快照都没有这个字段；没有生产者/消费者/校验。必须补。
- **`surfaces: { redact, block }`**
  - 当前代码没有这个结构；`scanMachineSecrets` 和 `redactMachineSecrets` 共用 `RULES`（`machine-secrets.ts:18-53`），没有按面拆分。实现时必须改类型并确保每个入口只读自己那个面。
- **`markers` / 未结尾判断**
  - 当前是手写 `POTENTIAL_SECRET_MARKERS` 和 `ACTIVE_SECRET_SUFFIXES`（`machine-secrets.ts:91-124`）。从规则清单生成时，要同时覆盖“完整 marker”和“部分 marker”；现有算法对完整 marker 只按 length-1 匹配，新规则如果只给 marker 不给 suffix，流式会漏。必须定义每个规则的完整 hold 语义。
- **`devDependencies` 精确版本**
  - 符合 `.agents/instructions/pi-and-workspace.md:25`；需确保 package-lock 更新、`@secretlint` 不出现在源码 import 中，检查脚本覆盖 `.ts/.tsx/.mts/.cts`。
- **`ci/security-exceptions.json` 条目**
  - 需要 `kind/id/path/digest/count/reason/owner/reviewReference/expiresAt/provenance`，`sourceCommit` 40 位、`lines` 真实行号、`id` 小写短横线格式、路径落在测试目录（`security-exceptions.schema.json:17-120`，`scripts/ci/security-exceptions.mjs:157-174`）。方案只写“登记”不够。
- **ADR 例外和规则文件**
  - 第 4 条例外可以加，但第 5 条、`docs/kv-cache-guide.md:60`、`README.md:19` 也要同步，否则文档互相矛盾。
- **监控命令**
  - `scripts/operations/cache-hit-report.mjs` 支持 `--by turn`（`:103,111`），`cache.follow_up_low_hit` 也存在（`apps/agent-service/src/service-main.ts:1810`），这两个可以用。

---

**总评**：方案的问题不在于规则选得不够多，而在于“观察”与“执行”没有真正分开，以及规则从产生到观察数据的链路没有闭合。先修高 1、高 2、高 3、高 4 和高 5，再谈移植 27 条规则；否则会在上线第一天既产生误遮，又拿不到可用来逐条开拦的可信数据。
