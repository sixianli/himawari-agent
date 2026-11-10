# Himawari 数据导出方案（记忆 + 决策记录）

## 一、方案依赖的前提（读代码或来源证实的）

1. **「拿得走」是产品护城河。** `docs/product-vision.md:107`：「**拿得走**——记忆、规则、工具可导出，换模型、换平台仍在我手里」；:99「每条记忆带来源、可回滚……整套可导出带走」；:114「校准数据我拿得走」。决策记录对应「每次开口与沉默都有记录、有评价……数据我拿得走」（:100）。
2. **现状与愿景矛盾，需要改 PRD。** `docs/prd-v0.2.md:67`：「人类可读或通用机器可读的数据导出；只提供受控权威迁移所需的机器迁移包」在「本版本不包含」清单里。
3. **权威迁移包是另一条路，不冲突。** `docs/adr/0019-offline-authority-transfer.md:28`：「迁移包只服务于活动权威迁移，不提供人类可读或通用机器可读导出」。它的清单模式可借鉴：`packages/persistence-sqlite/src/sqlite-recovery-point.ts:40-43` 定义 `himawari.recovery-point.v1`、aes-256-gcm 信封加密、hmac-sha256 认证；错误码含 `MANIFEST_INVALID`、`DIGEST_MISMATCH`（:49-53）。
4. **存储内部保留原文，遮盖只发生在出口。** ADR 0183 标题即「只在数据发往外部时遮盖，内部存储和展示用原文」（ADR 0185 引用，`docs/adr/0185-...md:70`）。导出到文件属于「离开系统」，所以要遮盖；但加密包内可以保有原文。`payloads` 表存密文（`migrations/0001:57-74`，`ciphertext`/`encryption_algorithm`/`key_ref`），读取经 `PayloadProtectorPort`。
5. **识别规则只能复用 `sensitive-capture`。** `packages/sensitive-capture/src/redaction.ts:244` 的 `redactForEgress(input, options)` 单输入即确定；占位符形如 `[密码#xxxxxxxx]`（`redaction.ts:65`）；`maskSensitiveText`（:542）就是 `redactForEgress(input).text`。`scripts/check-egress-redaction.mjs:30-53` 的 `SENSITIVE_RULE_SIGNATURES` 会扫描识别正则泄漏到包外——导出代码只能 import，不能复制规则。
6. **sensitive 记忆不进检索索引，是既有行为。** ADR 0185:61：「`sensitive` 记忆不进全文和实体索引、不带入档案块」。
7. **快照一致性有现成机制。** 导出进程可用 `acquireStateRootLock`（`state-root-lock.ts:104`）与运行中的服务互斥；恢复点创建就是这么做的（`sqlite-recovery-point.ts:38`）。服务进程自己导出则可在单个 SQLite 读事务里拿 WAL 快照。
8. **业界一手做法（已核实 Letta，其余出自材料所列官方页）。**
   - Letta AgentFile（https://docs.letta.com/guides/agents/agent-file ，本次已抓取核实）：「open standard file format for serializing stateful agents」，单 JSON 含记忆块、全部消息、系统提示、工具定义；支持导入导出；「secrets are set to `null` for security reasons」；archival memory passages 只在路线图（未导出）。教训：**导出范围要一次写全，漏一层（如 .af 漏 archival）就破坏「逐条一致」**。
   - Claude 记忆导出（https://support.claude.com/en/articles/12123587 ，材料所列，未重新抓取）：「verbatim」「Do not summarize, group, or omit any entries」、导入逐条审阅、明说实验性不保证保留。教训：**视图逐条对应、不概括；导入要确定性**。
   - Claude Code 记忆目录（https://code.claude.com/docs/en/memory ，材料所列）：`MEMORY.md` 一条一行索引 + 按需读主题文件。教训：**人读层用「一行一条 + 锚点」最稳**。
   - ChatGPT 导出（https://help.openai.com/en/articles/7260999 ，材料所列）：ZIP 归档、一次性、不能再导入。**不学**：没有导入的导出只是备份，不满足本任务验收 1。
   - 本任务明确不用 OpenTelemetry `gen_ai.*` 当决策记录格式（仍 Development，材料所列 https://opentelemetry.io/docs/specs/semconv/gen-ai/ ，未重新核实）。

## 二、方案

### 2.1 导出什么、怎么分主次

**主数据是机器可读的加密包；人读/Agent 读的 Markdown 是它的遮盖投影。** 两层都从同一次快照生成，共享同一份清单。

```
himawari-export-<exportId>/
  manifest.json                  # himawari.data-export.v1；counts + 每文件 sha256
  data/
    memories.json.enc            # 记忆主数据（加密，见 2.2）
    decisions.json.enc           # 决策记录主数据（加密）
    index.json.enc               # memory_search_index 向量 + memory_search_terms（派生数据，可选带走）
  view/
    memories.md                  # 人/Agent 读，一行一条，锚点回链
    decisions.md                 # 人读概览，锚点回链
  README.md                      # 格式说明（简体中文，含 gen_ai.* 字段对照说明）
```

**记忆主数据**（逐表、逐行、含全部字段）：`memory_records`（全字段，含 id、revision、status、tentative、superseded_by、classification、import_batch_id、stance）+ 解密后的原文（经 PayloadProtectorPort 读出）+ `memory_provenance`、`memory_entities`、`memory_history_events`（版本历史，含 quote_ref、occurred_at）、`memory_consolidation_runs/changes/change_basis`、`memory_people` 及别名/关系/提及、`memory_profile_pins`、`memory_import_batches`、`memory_episodes`。状态处理：

| 状态 | 导出 | 说明 |
|---|---|---|
| active / archived | 导 | 原样 |
| trashed / deletion_pending | 导 | 「逐条一致」要求带走，lifecycle_state 原样写回 |
| tentative | 导 | 原样；视图层默认不显示（拍板项） |
| superseded | 导 | `superseded_by` 字段保留，被指向的记忆也在包里 |
| deleted_verified | 不导 | 数据已删，无处可导 |
| sensitive | 导 | 原文只在加密层；视图层遮盖 + 标记 |
| restricted | 断言拒绝导出 | 库里不该存在（ADR 0185:43「`restricted` 的候选仍被丢弃」）；导出器遇到即报错，防识别规则退化后悄悄漏密 |

**决策记录主数据**：`decision_ledger`（kind、counts、verdict、outcome、reason_code、subject_ref、inputs、owner_rating、rated_at、category、confidence_permille、inferred、cost_micros、duration_ms）+ `decision_ledger_payloads`（model_input/model_output 文本，逐条过 `redactForEgress`）+ `decision_signals` + `source_insights` + `proactive_processed_messages` + `muse_reference_entries`。邮件正文等第三方内容同样走统一遮盖。`gen_ai.*` 只出现在 README 的字段说明里作对照，不做格式。

**派生数据**：`memory_search_index`（向量）和 `memory_search_terms` 不在主数据里手写重建逻辑，直接整表带走、导入原样写回——比「导入后重算嵌入」更满足验收 1（嵌入模型换了分数也逐位一致），也省真钱（live 评测一次约 0.001 美元但需网关密钥，`scripts/memory-retrieval-eval/live.mjs:22-27`）。

### 2.2 「无明文机密」和「逐条一致」同时成立：加密主数据包

主数据 JSON 用主人输入的 passphrase 做 aes-256-gcm 信封加密（直接沿用 recovery-point 的算法与结构风格），文件里没有任何明文原文，**原文完好地进了包**，导入即可逐条还原。视图层 Markdown/JSON 用 `redactForEgress` 遮盖，可以外发给其他 Agent（愿景「其他 Agent 能通过 Himawari 认识主人」）。这样验收 1 和验收 4 不冲突；冲突的只是「如果 Andy 坚持主数据也要明文零密码」——那是拍板项 1。

遮盖必须**逐条独立**调 `redactForEgress(input)`，不传 `known`、不传 `trusted`：`named-earlier` 规则（`redaction.ts:411-425`）依赖同一次请求里前面点名的值，导出时没有「前面」，单条输入本身确定，输出字节确定。占位符格式自动对齐并行任务（同函数同版本），不复制正则。

### 2.3 清单与完整性

`manifest.json` 学 recovery-point：`schema: "himawari.data-export.v1"`、`exportedAt`、`exportId`、源库的 schema 版本、按表 counts、每文件 sha256、每个 payload 的 `content_digest`（与 `payloads.content_digest` 列对得上，0001:65）。导入时：schema 不认识 → 拒绝；sha256 或 counts 不对 → 拒绝（错误码学 `DIGEST_MISMATCH`/`MANIFEST_INVALID`）。

**视图层回链**：每条记忆在视图里写成
`- [memory:<id>@<revision>] <遮盖后正文>`（Markdown 一行一条，学 Claude Code MEMORY.md 风格）；决策写成 `- [decision:<id>] <kind> <verdict> …`。锚点由导出器从主数据行的主键派生，测试用它双向对回。

### 2.4 导入

- **入口**：admin-cli 新增 `data export|import|verify`（`apps/admin-cli/src/index.ts` 的手写命令分派里加分支，:104-141）；控制中心加「导出/导入」按钮，走服务端生成（浏览器下载成品文件）。不在浏览器里拼数据（现状 `ExportPanel` 那样）——浏览器拿不到全字段、拿不到决策记录、更拿不到一致快照。
- **快照**：服务端入口在服务进程内开单个只读事务（WAL 快照）；CLI 入口先 `acquireStateRootLock`，服务在跑就拒绝并提示停机导出。两条入口共用同一个导出器。
- **校验链**：schema → 清单哈希/条数 → 每行枚举校验（classification 四档、owner_rating 三值、history kind 五值、decision kind 六值）→ 每行 id 过 domain 的 `createMemoryId` 等同一套校验函数 → content_ref 引用完整性 → 全部通过后**单事务**写入空库。
- **只进空库**：目标库已有记忆即拒绝，不做合并语义（v0.2 明确不做离线副本合并，`prd-v0.2.md:62`）。文本粘贴导入（`apps/control-center/src/memory-import.ts`，ADR 0185:45 刚改过的场景）保留不动；现有 `himawari-memories.json` 下载（`memory-page.tsx:2040-2062`）由新导出取代。
- 导入后不重算派生数据（向量/全文索引随包写回），也不发任何模型或嵌入请求——零出网。
- **与迁移包的关系**：三层各司其职——recovery-point（同机备份/恢复，整库加密）、authority transfer（跨机权威迁移）、data export（记忆+决策的产品级可携带，人可读、可校验、可回导）。互不改动。

### 2.5 不改表结构

全程读侧 + 导入写既有表，**零迁移**。唯一勉强算「新值」的是 manifest 的 schema 字符串和视图锚点，都是文件内容，不进库。不需要为导入分配新 `import_batch_id`——包里带着原值原样写回。

### 2.6 测试（全部进 `npm run check`）

新增 `check:data-export`，加进 `package.json:27` 的 `check:steps`（先例：`check:egress-redaction`、`check:model-ref-contract` 的「node script + vitest」组合，:51、:55）。

| 用例 | 正向 | 反向用例（必须真的会失败） |
|---|---|---|
| 往返一致 | 建临时 SQLite 库（学 `test/integration/memory-retrieval-eval/live.test.ts` 的建库方式）→ 造记忆（含全部状态、版本历史、评价）+ 决策记录 → 导出 → 清库 → 导入 → 逐表逐行比对 | 比较器先在「未动数据」上通过；再单改一行（如改 owner_rating）断言比较器报错——证明比较器不是恒真 |
| 清单防篡改 | 导入成功路径 | 改 manifest 里某文件 sha256、counts 多 1、加密文件截断，各自断言对应错误码且拒绝写入 |
| 视图回链 | 解析 memories.md/decisions.md 每条锚点在主数据 JSON 里找到同行 | 从主数据删一条后重新生成视图，断言测试失败 |
| 机密不外泄 | 测试库植入「密码是 hunter2xyz482910」、AKIA 开头 key、6 位验证码、银行卡号（分别命中 machine-secret/password/verification-code/bank-card 五类），导出后在全部明文文件里搜原文，断言不存在且占位符存在 | 把遮盖换成恒等函数跑导出，断言本用例红——证明扫描有效 |
| 检索评测 | 用缓存/确定性嵌入对导入后的库跑 `evals/memory-retrieval/dataset.json`，断言分数与导出前逐位一致 | 同库改向量一行，断言分数比较失败 |
| 约束边界 | 断言导出器不 import prompt-catalog、不调模型运行时 | 在导出器里写一条敏感正则，断言 `check:egress-redaction` 的 `SENSITIVE_RULE_SIGNATURES` 扫描红（若把导出文件加进它的扫描范围，拍板项） |

反向用例的写法统一是「**先证明错误实现会被抓**」，即每个检查都先对着一个故意写错的版本跑红、再对着正确实现跑绿，避免 I-73 式「测试只测了清单解析、没测消费端」。

## 三、考虑过但不选的做法

- **只做明文 JSON 主数据（不加密）**：无法同时满足验收 1（原文一致）和 4（无明文机密）——含密码的记忆要么丢原文要么泄密。Letta 置 null 和 Claude 导出不含原始文件都是这个冲突下丢弃数据的妥协，我们用加密包绕开。
- **浏览器端继续当导出入口**：拿不到一致快照、决策记录、payload 解密；现状就是「字段不全、导不回去」的根源。
- **导出后导入时重算嵌入、重建全文索引**：依赖嵌入模型版本，模型一换分数就变，验收 1 脆；且要花真钱出网。改为索引随包走。
- **复用 authority transfer 包当数据导出**：它是整库、权威级、明确不人读（ADR 0019:28）；混用会把「带走记忆」绑死在停机迁移流程上。
- **只导 active 记忆（像现有 ExportPanel）**：丢 trashed/archived/tentative 就不可能逐条一致；「可带走」的承诺含历史与评价（愿景 :99「可回滚」）。
- **按主题一文件（Claude Code 主题文件式）**：主数据按表分文件已经够细；主题切分引入排序/归组判断，与「不概括、不遗漏」冲突，只保留一行一条的视图。
- **给导出包做格式协商/兼容层**：约束「不需要为旧数据做兼容」，schema 不匹配直接拒绝即可，学 recovery-point 的严格 schema 校验。

## 四、风险与反例

- **遮盖非确定**：若有人给导出遮盖传 `trusted` 或跨条共享 `known` 表，同一段文字在不同导出里字节不同，且往返导入后视图不可复现——测试「同一库导出两次，视图逐字节相同」来堵。
- **restricted 渗入**：识别规则退化（ADR 0185:63 列了已知缺口，如英文 "password is …" 认不出）会让机密以未识别形态留在明文视图。导出器对 `payloads.classification = 'restricted'` 断言拒绝是结构性的兜底；启发式漏识别是已接受的剩余风险，由并行任务跟进。
- **快照读到半个事务**：不走单读事务/锁的导出会混入中间态（ADR 0019:14 原话：「直接复制正在运行的 SQLite 文件会遗漏 WAL、在途 Run」）。两条入口都强制锁/事务。
- **锚点重复或可变**：`<id>@<revision>` 在同一包内唯一（主键保证），但导入到新库后 revision 若被应用层推进，锚点对不上旧包——对回测试只对「导出时刻的包」负责，文档写明。
- **cost_micros 等字段对其他 Agent 泄露使用画像**：视图层不展示成本与时长，只在主数据层（加密）；拍板项 3。

## 五、需要 Andy 拍板的取舍

1. **主数据包是否加密（推荐加密）**：加密 = 验收 1+4 同时成立；若要「零密码双击就能用」，明文主数据里含机密条目必须降级为占位符，验收 1 只能对不含机密的条目成立。
2. **视图层收哪些状态**：tentative/trashed/deletion_pending 进不进 Markdown（推荐不进，主数据全带）。
3. **决策记录的成本/时长进不进人读视图**（推荐不进）。
4. **导出入口形态**：控制中心按钮 + CLI 双入口，还是先只做其一（推荐双入口共享同一导出器）。
5. **向量是否随包**（推荐随包，文件体积换分数逐位一致）。
6. **`prd-v0.2.md:67` 的修订措辞与新增 ADR 编号**（0189 起）。

## 六、「证实」与「推测」分开

**读代码/文档证实**：前提 1-7 全部（均有 文件:行）；Letta .af 内容（本次抓取）；现状导出/导入代码行为（memory-page.tsx:2040-2062、memory-import.ts 全文）；recovery-point 清单结构（:40-60）；state-root-lock 语义（:104-145）；check:steps 位置与先例（package.json:27、51、55）；live 评测要真钱密钥（live.mjs:22-46）；payloads 加密列（0001:57-74）；memory_records 在 0001:393+、decision_ledger 及 CHECK 在 0069:1-145。

**推测**：CachedEmbedder 可离线复用于自动检查（只读了文件头）；masked markdown 渲染、视图文件大小在真实数据量下可用；`check:egress-redaction` 把新导出文件纳管后不会误伤（其签名针对识别正则，导出代码不写正则，理论不误伤）；`memory_import_batches` 的列约束细节（未读该表定义）。

**未核实**：`decision_ledger_payloads.model_input` 存的是遮盖前还是遮盖后文本（导出统一再过一遍 `redactForEgress`，占位符会被规则跳过——`redaction.ts:80` 的 `(?!\[)` 和 :346 的 `[` 前缀判断保证幂等，故两种情况都安全，但库存状态本身没读）；云端 CI 是否执行 `npm run check`（仓库内 glob 未见 `.github/workflows`，`scripts/run-all-checks.mjs` 是本地/平台无关入口）；材料所列 Claude/ChatGPT/Anthropic 官方页原文（未重新抓取）；OTel GenAI 的 Development 状态页。

## 七、必答问题逐条

**1. 会不会改变模型已经见过的请求开头？——不会。** 本改动全部是「读库→写文件→读文件→写库」的旁路：不碰 prompt 组装、工具定义、历史存储、遮盖调用点，导出与导入过程不发出任何模型或嵌入请求（向量随包走，不重算）。发给模型的内容没有任何追加或修改，「每轮会变的值都在最后一条消息里」的现状不受影响。既有门槛 `check:prompt-prefix`（package.json:52）及其反向用例（`.claude/rules/prompt-prefix.md:74`：「改写历史里的用户消息、让系统提示带上每轮变化的值、关掉冻结，检查都必须报告失败」，测试在 `packages/runtime-pi/test/prompt-prefix.compat.test.ts`）就是本结论的自动证据：改动合入后该门槛必须原样绿。若将来选「导入后重算嵌入」分支，嵌入请求走 `packages/memory-engine/src/embedding.ts` 的统一出口（`check-egress-redaction.mjs:15` 要求 `exchange.wrapFetch`），且是全新请求，不存在「已见过的开头」。

**2. 会不会让同一段文字变成不同字节？——不会，前提是守两条纪律。** 遮盖逐条独立调 `redactForEgress(input)`，不传 `known`/`trusted`：规则（`redaction.ts`）只看本条自身文本，占位符再遮被 `(?!\[)`（:80）与 `[` 前缀判断（:346）挡住，幂等且确定。导出 JSON 键序按字面量固定、条目按 id 排序（规则第 10 条「列表的顺序都要固定」，prompt-prefix.md:51 同理适用于文件）；时间字段原样导出不重新生成；每次变的 `exportedAt`/`exportId` 只在 manifest，不进条目。反例监控：加「导出两次视图逐字节相同」测试。

**3. 有没有自动检查、反向用例会不会真失败？——有，见 2.6 表。** 每个检查都按「先对错误实现跑红、再对正确实现跑绿」写：清单篡改的三种改法各自断言对应错误码；往返比较器要证明改一行会红；视图回链要证明删一条会红；机密扫描要证明关掉遮盖会红。全部挂进 `npm run check` 的 `check:steps`（package.json:27），不是只跑本地。未核实云端 CI 是否跑 `npm run check`。

**4. 每个新值的两端核对（I-73 的教训：清单里的 id 必须能过消费端校验）：**

| 值 | 产生端 | 消费端 | 两端校验 |
|---|---|---|---|
| `himawari.data-export.v1` | 导出器写 manifest | 导入器 | 导入器硬编码白名单，不认识即拒（学 recovery-point `MANIFEST_SCHEMA`，sqlite-recovery-point.ts:40） |
| 视图锚点 `memory:<id>@<revision>` | 导出器从主键派生 | 回链测试、人/Agent 阅读 | id 过 `createMemoryId` 同款校验；测试双向对回 |
| classification 枚举 | 导出器透传库值 | 导入器 + SQLite CHECK（0001:400） | 导入器先显式校验四档并报可读错误，不让裸 SQL CHECK 当第一道 |
| `owner_rating` | 透传 | 导入器 + CHECK IN ('useful','unneeded','missed')（0069:27） | 同上 |
| `memory_history_events.kind` | 透传 | 导入器（0065） | 枚举白名单 |
| `content_ref` | 透传 | 导入器 + FK REFERENCES payloads（0001:399 等） | 导入器预检引用完整 + 单事务写，FK 失败即整体回滚 |
| payload `content_digest` | 导出时复制 | 导入时对照解密后内容的 sha256 | 校验写入前完成，不匹配拒绝 |
| 新 CLI 命令 `data.*` | admin-cli 分派（index.ts:104-141 手写 if 链） | usage/参数校验数组（:192-219） | 同处加分支与必填参数检查，缺一即用例覆盖 |
| manifest `exportId` | 导入时保留 | 日志/审计 | 仅透传，无新校验面 |
| i18n 键（新按钮文案） | 控制中心组件 | `check:locale`（package.json:57） | 门槛自动抓漏键 |

每个值都有「产生端校验 + 消费端校验 + 一个专门测试」，避免 I-73「只测产生端、没问消费端接不接受」的形态。
