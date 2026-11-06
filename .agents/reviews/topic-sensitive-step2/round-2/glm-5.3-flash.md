现在核实上游一手来源（detect-secrets 与 secretlint 的具体说法）：
# 独立审核结论：方案 v3（敏感信息识别第 2 步）

下面按严重度排列。标「证实」的是我读了代码或一手来源确认的；标「推测」的是凭代码结构和上游文档推断、未逐行验证的。

---

## 问题清单（按严重度）

### 1.【高·证实】方案的「先只遮值、记录」在自动整理记忆这条路径上根本不成立

- **问题**：设计第 3 节把新密码关键词规则放进 `redactForEgress`（“排在现有 PASSWORD_ASSIGNMENT 后面”）。而 `credentialFindings` 就是 `redactForEgress` 的一个包装（`packages/sensitive-capture/src/redaction.ts:301-303`），自动整理记忆用它来**排除记忆候选**：`packages/application/src/services/automatic-memory-service.ts:73-81` 把 `credentialFindings(text)` 合入 findings，`:137-143` 里 findings 非空就把该候选 `candidate_secret_excluded`、不落库。也就是说，只要新规则写进 `redactForEgress`，它从第一天起就是记忆路径的一个**拦下表面**——既与 §2.1「新规则的 surfaces.block 一律先设为 false」矛盾，也让 §2.4「观察期内新格式密钥可能被自动整理记忆以原文存进数据库」的推演失真（实际上会被排除，而不是被存下）。
- **证据**：
  - `redaction.ts:301-303`：`credentialFindings(input)` 内部调 `redactForEgress(input).findings`；
  - `automatic-memory-service.ts:78-79`：`...scanMachineSecrets(text), ...credentialFindings(text).map(...)`；
  - `automatic-memory-service.ts:137-143`：`candidateFindings.length > 0` 即丢弃候选并写审计；
  - 反过来看，`applications` 里另一些真正的 7 条拦下点用 `scanMachineSecrets` 或真用它：`packages/application/src/services/automatic-memory-service.ts:104`、`apps/agent-service/src/production-memory-capture.ts:752`。
- **为什么现有锁不够**：§2.5「观察期内 `scanMachineSecrets` 只认现有 7 条」只锁了扫到函数本身。记忆排除的判据不是 `scanMachineSecrets` 一个，而是「scan + `credentialFindings`」两路；把 `credentialFindings` 含义改了照样改变拦下行为，锁不住。
- **建议**：在包内把「只遮值」规则集和「拦下」规则集分成两个显式清单（或 `credentialFindings`/自动记忆排除只消费 `surfaces.block=true` 的规则），并在设计 + ADR 里写清这条路径是否要跟着放宽（记忆排除更保守不一定是坏事，但它必须是被陈述、被复核的决定，不是正则顺序的副作用）；§2.5 的锁改成「所有拦下决策只依赖现有 7 条 + 现有私钥边界」，并加反向用例：含新规则命中、但旧 7 条不命中的候选记忆，在观察期内**必须**被提交（红→遮掉这条需求）。

### 2.【高·证实】「把 DSA、PGP 加进私钥边界」会从第一天起扩大拦下表面，并且方案的红action/边界不对称

- **问题**：`PRIVATE_KEY_BOUNDARY`（`packages/sensitive-capture/src/machine-secrets.ts:56`）是 `containsToolOutputSecret` 的第二个判据（`machine-secrets.ts:58-60`），而 `containsToolOutputSecret` 被用于约 10 处拦下点（如 `apps/agent-service/src/capability-programs/pi-coding-request.ts:207`、`apps/agent-service/src/production-file-preparation.ts:68`、`packages/platform-node/src/files/pi-host-publication.ts:139,161`、`packages/platform-node/src/files/pi-output-export.ts:43`）。把 DSA/PGP 加进边界 = 观察期内对应工具输出直接被拒，与 §2.1「约 30 处整段拦下继续只用现有 7 条」自相矛盾。
- **更重的是两端口径不一致的风险**：红action 那条规则 `private-key-block`（`machine-secrets.ts:24-25`）只认 `RSA |EC |OPENSSH`。若只在边界正则加 DSA/PGP、不同步放宽红action 模式，那 DSA/PGP 私钥会在工具边界被拒，但一旦从不走 `containsToolOutputSecret` 的管道进来（网页导入、邮件正文、记忆路径），出口的 `assertMachineSecretFree`（`machine-secrets.ts:86-89`，只有 `scanMachineSecrets`）认不出它，遮盖也遮不掉它，**明文私钥完整发给模型**。这是第 2 步方案最不能接受的失败形态。
- **建议**：白纸黑字写明这条属于 Andy 已同意的例外（前提 1 的拍板清单里没有明确覆盖它）；红action 模式、`PRIVATE_KEY_BOUNDARY`、`machineSecretHoldStart` 里的私钥起始条件（`machine-secrets.ts:131`）三处必须同一扩展、同一 PR；§2.5 的锁同时钉住 `containsToolOutputSecret` 的行为（含反向用例：DSA/PGP 样例应比现状**多**拦——若 Andy 同意拦；或改为只遮——若未同意）。

### 3.【高·证实】流式标记「从清单生成」缺少对 CJK 和占位符两处现状事实的处理说明，且现状一个测试都没有

- **问题**：
  - 现有 `ACTIVE_SECRET_SUFFIXES` 全部用 `\b` 前缀（`machine-secrets.ts:117-124`），`\b` 在汉字与 ASCII 之间不按预期工作；现有 `POTENTIAL_SECRET_MARKERS`（`:91-115`）不含 `密码`/`密钥` 等中文标记——我核实了现状确实没有直接单元测试断言 `密码：xxx` 的流式行为。这意味着：模型写 `密码：hunter2`，流式显示路径（`pi-model-transport.ts:336`、`execution-live-feed.ts:46-47`）靠 `redactMachineSecrets` 是遮不掉的（五行 `密码：xxx` 属于 `redactForEgress` 那层的 `PASSWORD_ASSIGNMENT`，不属于 7 条机器规则）。方案 §4 说「新的密码关键词也加进去」，方向正确，但没交代：新规则的「流式标记」需要与生成正则的 value 边界相互替代一对（开尾正则），且中文关键词不能用 `\b`。
  - 额外的占位符回环：egress-legend 提示模型照原样写出 `[密码#abcdefgh]`、`[密钥]`（`apps/agent-service/test/__prompt_golden__/chat.egress-legend.txt:1`），生成标记时若把 `密码`、`密钥` 纳入，模型回答里的占位符也会触发 hold 直到 `]` 到达——功能无害但要写进测试用例，别让实现者意外。
- **建议**：§4 的流式等逐字节测试直接包含：`密码、密钥、密鑰` 赋值样例、含 `是/为/は` 的中文赋值、`[密码#…]`/`[密钥]` 占位符回显、多行 Bearer；并在实现说明里写死「`\b` 不适用于 CJK」。

### 4.【中·证实】detect-secrets 关键词规则移植的几个前提性偏差（对照 v1.5.0 源码）

- DENYLIST 原样（`auth_?key`、`client_?key`、`db_?pass`、`secret` 等，**没有**裸 `token`/`key`）已核实：https://raw.githubusercontent.com/Yelp/detect-secrets/v1.5.0/detect_secrets/plugins/keyword.py 。方案说「允许 `[A-Za-z0-9_]*` 词缀」只写了**后缀**；上游另有前缀+后缀写的反向比较模式（`if ("value" == my_password)`，`DENYLIST_REGEX_WITH_PREFIX`），属「要求引号那组」的一部分。不搬可以，但要写进改动摘要，别当作「原样」。
- 上游默认非文件扫描走的是 quotes-required 组（`analyze_string` 的默认 `attempts`）；不带引号/带引号两组按文件类型分发（YAML/CONFIG/INI 走“配置写法”组）。聊天没有文件类型，选两组合并是刻意的拓宽（比上游按文件类型的默认值更宽，误报更多），应如 plan 所说写进改动摘要，并且 ADR 里写明这一点而不是“照搬”。方案的表述已接近，但没明说「合并比上游更宽」。
- 提“照搬 detect-secrets v1.5.0 的 `tests/plugins/keyword_test.py`”作样例：`KeywordDetector.analyze_string` 只是**按组号产出关键词后面的值**（同上源码），那些测试针对的是按文件类型的正则选择行为；直接拿来到我们“合并两组”规则上语义并不一一对应，需要逐条映射后改写，不能真“照搬”。【推测：具体需重写的比例，未逐条对过 `keyword_test.py`，未核实】
- `is_potential_uuid` 在值内任意位置搜 UUID 就跳过——已核实（官方文档原话「Ignores uuid looking secret values」+ `re.search`：https://github.com/Yelp/detect-secrets/blob/master/docs/filters.md ）。`is_likely_id_string` 在 v1.5.0 被「make more strict to avoid eliminating true positives（#526，CHANGELOG）」，方案里“会放过 `client_id: x, secret: y`”的现状描述针对哪个版本需复核【推测】；结论（不搬这两条）本身我同意——误遮 been ID 代价小、放过真秘钥代价大，且推出后界面上能还原原值。

### 5.【中·证实】新 ruleId 的“产—用两端”盘点缺一半（I-73 那个教训的原样形态）

方案只说`id`（`secretlint-<规则名>`）会出现在规则清单；我从两端逐个核了：

- **产端**：`redactForEgress` 的 `observe` 会携带 `ruleId`（`redaction.ts:178-185`）；机器块匹配走 `MACHINE_SECRET_MARKER` 那层计数（`redaction.ts:208-213`）不用 ruleId。
- **用端**：
  - `packages/application/src/services/model-egress.ts:38` `goal-ruleId: EgressRedactionRuleId`——类型联合定义在 `redaction.ts:29-38`（`EGRESS_REDACTION_RULE_IDS`），**新 ruleId 必须加进这个联合**，否则类型检查会拦截（好事，双端核对有保障）。
  - `packages/application/src/ports/sensitive-interceptions.ts:55` `ruleId: string` 自由字符串——接口层有枚举约束【URL 于 `SENSITIVE_INTERCEPTIONS_CATEGORIES`（类别）和部件 有 enum 变量的数据分类，ruleId 作为自由串就好，不需要改】。
  - `packages/application/src/services/sensitive-interception-recorder.ts:32-37` `memoryCategory()` 对不在 7 条也不在五个 kind 里的 ruleId **静默 `continue` 丢掉**——记忆审计路径（`reportMemoryAudit`）今天传的是 kind id，不会踩空；但那 30 处工具级扫描点的 ruleId 走的是诊断字符串（`host-file-read-service.ts:158`），不入库。这条“静默丢弃”要在方案里点名，将来任何人把 `secretlint-*` 塞进记忆审计时它会把数据无声吞掉。
- **建议**：在方案里直接写「新 ruleId 必须登记进 `EGRESS_REDACTION_RULE_IDS` 联合，并逐个 grep 消费点」；把 `redaction.unit.test.ts:267`（`findSensitiveValues` 只认 kind 清单）那类测试作为锚点更新；给 `memoryCategory` 加一条「未知 ruleId 不再静默」的可选副作用以免吞数据的测试。

### 6.【中·证实】「敏感信息拦截记录」覆盖面比 §2.2 声称的窄

- 拦截记录只从三条路进来：`reportEgress`（发模型请求时，`production-model-egress.ts:25,36-40`）、`reportMasked`（仅 Gmail 检查 epilogue，`apps/agent-service/src/service-main.ts:1548`）、`reportMemoryAudit`（`automatic-memory-service` → `service-main.ts:2025`）。工具读文件、读网页、跑命令里被旧 7 条**当场拦下**的地方**不会**进拦截记录（例如 `host-file-read-service.ts:153-158` 只是写进 diagnostics）。所以 §2.2「在读文件、网页、命令输出里命中的，记录的出处是工具结果」只在「该结果最终作为 tool_result 进了模型请求」时才成立（在请求时被 egres 起的part= "tool_result" 记录）；若输出因大小截断/被掉队，就没有记录。
- **建议**：把这句的适用范围写窄（“进模型请求的工具结果”），或者干脆把五类.parts（`sensitive-interceptions.ts:12-25` 里的 `file/command_output/web_page`）在拦截记录里补上它们的产生点（推测：今天的实现没产生这三类部件，未核实每一名）。

### 7.【低·证实】文档与规则一致性还有三处方案没列出的跟随改动

- `.claude/rules/prompt-prefix.md:36` 末句「遮盖密钥不变、前面的历史不变时，同一段内容每次遮出的字节相同」在升级窗口与回滚窗口为假——方案提到了第 4 条 exception，还须把这句和 `:53`（试节「例外」）里那套「遮盖规则升级有 ADR」的指路也改——否则规则文本自相矛盾。
- `docs/kv-cache-guide.md`（规则页自述「每条做法…落实情况，见这个文档」）没在方案里提及，但它承载规则的实施细节，规则文改动时它必须同步。
- `.claude/rules/prompt-prefix.md:73` 介绍 `check:prompt-prefix` 的段落若新加检查（§1「识别包不得引用 `@secretlint`」），得挂在 `npm run check` 的清单里（`package.json:27` 的 `check:steps`），方案没写这个新检查挂哪个 script、也没有反向用例（有反向用例的那条只在 ADR 0167 的 `check:egress-redaction`，见 `docs/adr/0167-sensitive-capture-package.md:72`）。

### 8.【低·证实】引用与前提的小问题

- `.agents/reviews/topic-sensitive-step2/round-1/` **在本检出里不存在**（`.agents/` 下只有 handoffs/instructions/tasks 等）。如果这是没提交/另一检出里的工作文件，方案应该写清“原文未随本检出提交”。
- 前提 8 的 `settings.py:139-153`「默认过滤器」行号，未在 1.5.0 源码里逐行核实（未核实，不影响结论）；`heuristic.py` 应为 `detect_secrets/filters/heuristic.py`，方案只写 `heuristic.py`（未致错，但按路径写）。
- 前提 7 的「27 条识别规则 + filter-comments」已核实（secretlint v13.1.0 预 README：https://raw.githubusercontent.com/secretlint/secretlint/v13.1.0/packages/%40secretlint/secretlint-rule-preset-recommend/README.md ，列表 27 条 + `filter-comments`）；「推荐集没有 Heroku 规则」亦核实。npm/gcp 两条“依赖文件名或读磁盘”、database-connection-string/basicauth 的示例跳过名单原文未逐条核实【未核实】。
- 业界做法只核了最承重的 GitHub 推文：“push protection 只支持最有把握的新版本 token 格式，避免对可能过时的 legacy formats 误拦”，官方文档原话见 https://docs.github.com/en/code-security/reference/secret-security/supported-secret-scanning-patterns （“Push protection only supports the most recent token versions that secret scanning can identify with confidence. This avoids push protection blocking commits unnecessarily when a result may be a false positive”）；推文 https://docs.github.com/en/code-security/concepts/secret-security/push-protection 同时确认「先拦下高置信格式、单独洗牌每一类」。微软 Purview “模拟模式”和 Cloudflare “先 Flag 后 Block”两条是官方 URL，方向我认可，但原文原句未提取【未核实】。

---

## 侧重检查（额外侧重：测试覆盖 + 文档/规则一致性 + 一条普通流程的走查）

**走查流程**：主人发消息 → 处理 → 模型请求 → 回答（流式显示）→ 历史落库 → 下轮请求 → 自动整理记忆。

1. **读文件**（`host-file-read-service.ts:153` `scanMachineSecrets` 拦下）— 拦下层使用现有 7 条，命中时有测试（`machine-secret-exclusion.unit.test.ts`）。方案改动后按 §2 不变。**除非**DSA/PGP 边界扩展弄错了位（见问题 2），否则此处不存在被方案忽视的情况。
2. **工具结果进入模型请求**（`pi-runtime-adapter.ts:999` 起 exchange → `model-egress.ts` `#prepare` → `redactForEgress` 遍历整个请求体含历史，`:284-458`）：方案改动后新规则在此遮值 + 记录（part= `tool_result`，规则记录端口没按 part 枚举硬编码，够用）。覆盖：`model-egress.unit.test.ts`、`packages/runtime-pi/test/egress-real-pipeline.unit.test.ts`、以及 `prompt-prefix.compat.test.ts`（[I-66]，真实遮盖+真实 Pi）。**缺口**：`prompt-prefix` 门禁检查‘逐轮 append-only’，**不会**将一次上线/回滚造成的“已发内容字节一次性变化”识别为异常；方案靠 ADR + `cache-hit-report` 监控弥补（§6）——判为可接受但要在上线流程里写明“上线当天这个门禁正常、命中率不可能全是100%”。
3. **回答流式**（`pi-model-transport.ts:336` StreamingMachineSecretRedactor）— 现状**没有任何直接测试**（仓库无引用点测试；`grep StreamingMachineSecretRedactor|machineSecretHoldStart` 只见两处 src 使用）。方案 §4 补测试是好的；“真实执行输出用的是同一个函数，自动跟上”半正确：`execution-live-feed.ts:46-47` 用 `machineSecretHoldStart` + `redactTracePayload`（行走 `redactMachineSecrets`），**东北 пись无自身流水测试覆盖新目标值**，两个消费者要在方案里各加一行测试（或至少是把切分测试跑在同一段 IncrAttr 逻辑上）。
4. **记忆落库**（`automatic-memory-service.ts:73-143`）— 这是方案有最多遗漏问题的路径（问题 1）；覆盖情况：`packages/application/test/memory-credential-exclusion.unit.test.ts` 钉住了 `credentialFindings` 的旧规则行为，但**新规则会在此路径单独生效而没有任何用例保住「观察期不排除」**——最需要新增的反向用例在这。

**文档一致性核对结论**：`.claude/rules/prompt-prefix.md:35/36/53/73` 与方案条目逐一对照已核（第 4 条「例外只有三种」、第 5 条出口遮盖那段、第 11 条“确定的遮盖”）；`docs/adr/0167`（前提 2/3/11）与 `.agents/instructions/pi-and-workspace.md:25`（精确版本）核对通过；`ci/security-exceptions.json` 存在且其端到端机制（含 gitleaks 白名单 + 反向检查设计）已核。方案第 6 节缺 `kv-cache-guide.md` 的跟进，见问题 7。

---

## 如果由我来定，我会怎样改这份方案

1. 在 `packages/sensitive-capture` 内把规则集**显式**拆成两个序列化的清单：`REDACT_ONLY`（新 secretlint/密码关键词规则，观察期内只有遮盖与记录消费）和 `ACTIVE_BLOCKS`（现有 7 条 + 现有私钥边界现状），让 `scanMachineSecrets`、`assertMachineSecretFree`、`containsToolOutputSecret` 只吃 `ACTIVE_BLOCKS`；`credentialFindings`/自动记忆排除**只看** `ACTIVE_BLOCKS`（这条做法等价于把两套 `surfaces` 直接编码成类型 + 运行时清单，而不是靠消费端自觉）——一个问题 1、问题 2、问题 5 一次解决。
2. §2.5 改述：测试锁钉「所有拦下决策只依赖 `ACTIVE_BLOCKS`」，并**为每个拦下范围内的判断加反向用例**（记忆候选、工具输出、Muse、提醒、检查点各一个新规则样例，观测它们不拦）。
3. 私钥边界的 DSA/PGP（若 Andy 同意拦）三处同步（红action 正则 + 边界 + hold 起点），或明确降级为“仅红action”，否则**别动**——它打破「继续只拦 7 条」承诺，且不对称版本会向出口漏明文 DSA 密钥。
4. §4 流式测试使用 DeepSeek 那个更强的“任意位置切开、逐字节等于一次性遮盖”写法（值得），并明确包含中文赋值、`[密码#…]`占位符回显、「maskMachineSecrets 红action 输出+ password 段 互不影响」。现状两个流式消费者**零测试**——方案里把新增的红action 位 断言到 `StreamingMachineSecretRedactor` 与 `execution-live-feed` **各自**入口（至少一个冒烟用例）。
5. §1 补一句“新 ruleId 进入 `EGRESS_REDACTION_RULE_IDS` 联合类型、且每条业务消费点附 `grep` 清单（顾 I-73 的双端核对）"；§2.2 里“读文件/网页/命令输出命中的记录出处为工具结果”限“进模型请求的工具结果”那个精度；`memoryCategory` 静默丢未知 ruleId 的行为打个注目测试。
6. §6 补两个文档动作：`.claude/rules/prompt-prefix.md:36/:53` 的字节-稳定性和遮盖确定性表述加指向新 ADR；`docs/kv-cache-guide.md` 里的实施说明同步。
7. 新检查「识别包不得引用 `@secretlint`」挂进 `check:steps` 并给出反向用例；把这一条与 `check:egress-redaction` / `check:boundaries` 的分工写明，别出现两个门禁查同一件事但口径不同（现有 ADR 0167 的特征写法检查是“包外不得各有”，新这条是“包内不得引入”）。
8. 上线顺序（排除规则先行→四 PR 合一次上线）与监控（`cache-hit-report`、`cache.follow_up_low_hit`）照方案执行不变；额外建议观察期新建一个`拦截记录`里“密钥/密码 含义总档”的固定报表（`sensitive_interceptions` 按 `ruleId`分组看到第一条可视化数据）——而不是只看缓存命中。

## 必答问题逐条回答

**Q1（请求开头 / 只追加）**：系统提示与工具定义完全不动；历史存原文、发送时重遮的结构不改变（`prompt-prefix.md:36` 与 `model-egress.ts:284-458` 证实）。**遮盖规则升级使历史上已遮的段位**在**每次**发送时**得到新的字节**——这正是第 4 条“已发内容不得改动”的主要威胁，方案以「ADR 依据的遮盖规则升级」作为第 4 条的第四种例外应对，我核实了规则文件 `:35` 今日确为三种例外。按方案落地（每条账表化、上线一次、回滚一次再变一次）可以接受；**每轮会变的值依然全在最后一条用户消息**（新规则不会产生每轮变化的值，占位符 tag 由签名密钥+值决定，per-message 确定），有 ADR 例外是合法做法之一。条件：问题 1/2 若修正不彻底，实际上会悄悄多一次“已发内容变化”（记忆排除不是发模型内容，所以不触发）——对 Q1 的回答仍“通过”；但 DSA/PGP 不对称修法在今天会把**明文**私钥带进模型，此点必须先修。

**Q2（同段文字不同请求的字节）**：无时间字段；规则清单是固定顺序的()；规则数据串在源码里单一路径（不依赖运行时顺序）；`known`（named-earlier 借用）在 `model-egress.ts:116` 每 Exchange 建一次，且每次请求起一个 Exchange（`pi-model-transport.ts:313`）——同名消息遮出的字节在同一次请求里确定、跨请求稳定，与 `prompt-prefix.md:53` 一致。若**规则版本**或**遮盖签名密钥**变，同段文字会变字节——方案第 5 节写“规则版本不变时”，我把签名密钥的轮换也理解为已知事实（`prompt-prefix.md:78`），不扣分。结论：**通过**；实现阶段唯一不能漂移的是「规则列表顺序 -> 逐条替换」的串行红action 顺序不能改并发/重排。

**Q3（自动检查 / 反向用例会失败吗）**：现有覆盖：`check:egress-redaction`（含反向用例，ADR 0167:72，具体反向用例内容未逐条核实）；`check:prompt-prefix`（真实遮盖+反向用例改历史会失败，`.claude/rules/prompt-prefix.md:73` 及测试文件 [I-66]，确认存在）；`determinism`（`redaction.unit.test.ts:95-100` idempotent 测试存在）；`check:secrets` + `ci/security-exceptions.json`（方案有登记说明）。**方案新增检查中必须自己写“反向验证”清单的有**：①「包内不得 import @secretlint」（现在未写反例），②§2.5 锁覆盖面成为 H1/H2 后**不会失败**（反向用例必须打在被锁的函数之外的两个入口），③每条不搬 filter 的“这种值仍然要遮”反向用例——方案已承诺。结论：**方案方向通过，锁的覆盖面需按问题 1/2 修正后用反向用例证实**。

**Q4（产-用两端核对）**：
- 新 ruleId → 使用的两端：类型联合 `EGRESS_REDACTION_RULE_IDS`（编译器尾巴会抓）、拦截记录端口是自由串（安全）、`memoryCategory` 静默吞（需冷测试）——按上面问题 5 补。
- `surfaces.block` 开关的**实际生效**目前只靠 grep 监督；我找到了它必然生效的两条不一地方（问题 1 memory 路径、问题 2 私钥边界）——这是本方案最大的“只看改动两边未看两端”式的同一类陷阱，等于 I-73 的教训在此当场复现。
- 属于 Andy 新需确认的（方案“还要 Andy 定”之外）：①私钥边界扩展是否真属已拍板的例外；②记忆候选排除在观察期内是否允许被新规则命中即排除（方案要挑一个姿态写下来，别让正则顺序决定）。

**未核实**：微软/Cloudflare 两处业界原文原句、secretlint 内部各条规则的 filename/示例 skip 名单、detect-secrets `settings.py` 行号、Andy 两段原话（2026-11-05/06）、另一线程的交接说明、`.agents/reviews/round-1` 原文件、`keyword_test.py` 样例 compat 一改能用的程度。
