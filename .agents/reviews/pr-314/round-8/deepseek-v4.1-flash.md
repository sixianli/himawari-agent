## 一、作者说法核对（读代码证实）

- **增量只有测试 + ADR + 合并 main：基本成立。** `git diff 65d260ad..head --stat` 里看起来像生产代码的 `packages/sensitive-capture/src/redaction.ts`、`thread-prompt-bundle-service.ts`、`model-egress.ts`、`pi-runtime-adapter.ts` 等，全部来自 `545e7746a` 合并进来的 main（其第二个父提交是 `452c5e95`，即 PR #315）。`git log --all -- packages/sensitive-capture/src/redaction.ts` 显示这些是 `63ddef5cd` 等 PR #315 提交；`git diff 452c5e95..head` 里没有 `redaction.ts` / ADR 0188。PR 314 自己在第 7 轮之后只有 `b17048250`：改 ADR 0187 两处 + `test/integration/gap-cases.test.ts` 4 行。
- **无冲突残留：** 全仓搜索 `<<<<<<<` / `=======` / `>>>>>>>` 无结果；`git status` 干净。
- **迁移序号仍是 0082 且一致：** `migration-engine.ts:647-653` 有 `sequence:82 ... 0082_gap_case_marks.sql`，`migration-engine.contract.test.ts` 的 `CURRENT_SCHEMA_SEQUENCE=82`、`appliedSequences ...81,82`、`assertWritableSchema(...,82)`，`model-budget...`/`run-checkpoint...` 也改为 82；`schema-catalog.ts` 增加了 `gap_case_marks` 且 `migration-engine.contract.test.ts:72` 用实际表清单与 catalog 全量比对。
- **无与 main 新内容冲突：** 配置键 `gapExportSecretRef` 唯一；ADR 0187 唯一（0188/0189 属 main）；词表里 PR 界面用“多余提醒率”（`apps/control-center/src/i18n/resources/zh-CN.ts:1192`、`calibration/src/index.ts:760`），PR 新增代码无“误扰率”。

## 二、侧重检查（错误路径 / 不可信输入 / 安全 / 资源 / 不可撤销 / 文档一致性）

- **错误路径：** 导出中单条快照读不出/解不开 → `skipped += 1` 跳过（`production-gap-export.ts:139-167`）；全部读不出才 500（`:169-170`）；标记不存在的案例 → `GAP_CASE_NOT_FOUND`（`production-observation.ts:329`）；令牌用途不符/缺失 → 启动时抛错（`strict-configuration.ts:1418-1424`、`startup-configuration.unit.test.ts` 负例）；鉴权失败 401 空体、限流 429（`production-gap-export.ts:183-190`）。
- **不可信输入：** `caseId/endDay/marked` 由 `packages/gateway-contracts/src/contracts-v2.ts` 的 `proactiveGapCaseMarkCommandSchema` 校验；标记时服务端重算窗口与案例再按 id 查找，不直接信任旧数据。导出快照经 `isGapCaseSnapshot` 校验并强制 `parsed.id === mark.caseId`（`production-gap-export.ts:147`）。Bearer 比较是 sha256 + `timingSafeEqual`（`bearer-admission.ts:26-29`）。
- **安全：** 导出令牌单独 purpose `gap-export`，与 `muse-intake` 分开校验；标记快照与导出预填都经 `redactForEgress` 遮盖（标记时 `maskForExport`、导出时再次遮盖）。
- **资源：** 案例候选 SQL `LIMIT 1000`（`sqlite-decision-ledger-operations.ts` 的 `readGapCandidates`）；`GAP_CASE_LIMIT=50`；限流数组上限 30/60，不会无界增长；导出无条数上限但由人工逐条标记，ADR 已写明。
- **不可撤销操作：** 标记可取消；取消标记在单事务内先删 `gap_case_marks` 再删对应 payload（`sqlite-decision-ledger-operations.ts:461-475`）；“清除 Muse 数据”在单事务里删 mark、快照 payload，并仍返回条目标题/正文 ref 供调用方释放（`sqlite-muse-intake-operations.ts:517-567`、`production-muse-intake-control.ts:171-172`），与 ADR 0187 第 47 行一致。
- **文档与代码一致性：** ADR 0187 第 84 行的“设了观察起点窗口固定 / 没设则滚动”与 `production-observation.ts:186-192` 及 web 传 `{end:null}`（`apps/control-center/src/proactive.ts:154`）一致；第 47 行“取消标记不再释放、清除 Muse 仍释放条目载荷”与代码一致。ADR 0188 的 rollout 措辞见下方低问题。

## 三、问题清单（按严重度）

> 读代码证实：以下行为均来自实际读取的代码/文档；标“推测”的是可达性或后果推断。**本轮未发现中/高严重度问题。**

**低｜`packages/application/src/services/thread-prompt-bundle-service.ts:196-200, 263-268`（合并进来的 main，PR315，非 PR314 自有改动）**
- 问题：任何“第一次建记录且已有历史”的对话都被当作 `rollout`，永久使用遮盖规则版本 1，而 ADR 0188 第 56 行写的是“**上线时**已有历史、第一次建记录的对话（来源 `rollout`）写版本 1”。上线后若有“带历史新建录”的对话（导入/迁移等），其中的宽松密码写法会一直原样发给模型，直到因工具/模型等换新。
- 证据：`origin = latest ? promptBundleChange(...) : input.hasHistory ? "rollout" : "new_thread";` 与 `if (origin === "rollout") return LEGACY_REDACTION_RULESET;`；ADR 0188 `docs/adr/0188-recognize-passwords-without-a-separator.md:56`。
- 建议：用部署时间/首次启用标记区分真正的上线存量对话；或明确改 ADR 措辞并写明该安全代价。
- 标注：行为读代码证实；“上线后新建历史”路径是否真实存在为推测（ADR 0165 本身把 rollout 定义为“已经有历史的对话”，说明这是有意取舍）。

**低｜`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:448-459` + `apps/agent-service/src/production-observation.ts:333-340`（PR314）**
- 问题：`gapMark` 用 `INSERT OR IGNORE`，不仅忽略主键重复，也会忽略 CHECK/NOT NULL 冲突并返回 `changes===0`；上层把 `false` 当“已标记（replayed）”，随后释放新封的快照并返回成功。当前 `caseId` 来自服务端重算、`at` 来自 `toISOString()`，外部不可触发。
- 证据：`INSERT OR IGNORE INTO gap_case_marks ... .changes) === 1`；`if (!added) await seal.release({ ...scope, refs: [ref] });`。
- 建议：改成 `ON CONFLICT(owner_id,agent_id,case_id) DO NOTHING` 或先查重再插入，把真正的约束错误暴露出来。
- 标注：行为读代码证实；外部可达性推测为否。

**低｜`apps/agent-service/src/production-observation.ts:318-323`（PR314）**
- 问题：取消标记也要求 `seal` 存在（`if (!marks || !seal) invalid("GAP_MARKS_UNAVAILABLE")`），但取消分支只删行和 payload，不需要 `seal`。
- 建议：仅在 `payload.marked === true` 分支检查 `seal`。
- 标注：读代码证实。

**低（文档）｜`docs/architecture-v0.1.md:296, 699`（PR314 新增表后更不一致）**
- 问题：仍写“三十一个连续 SQL migration 建立 81 个登记表”“所有 31 个 migration 共登记 81 个表”，而现在实际是 82 个迁移、82 个表。该文早已严重滞后，但本 PR 再加一张表后计数更不对。
- 建议：更新为引用 `LATEST_MIGRATION_SEQUENCE`/`schemaCatalog`，或删掉易过期计数。
- 标注：读文档证实。

**很低（推测）｜`apps/agent-service/src/production-gap-export.ts:53-70`（PR314）**
- 问题：`isGapCaseSnapshot` 没有校验 `museText`、`himawariReasonCode`、`museTextWithheld`、`decidedAt`。当前导出不使用这些字段，因此无直接问题；若以后导出用到就应补齐。
- 标注：读代码证实“未校验”，风险为推测。

**已确认修好的第 7 轮低意见（读代码证实）**
- ADR 0187 第 47 行：取消标记不再额外释放、清除 Muse 数据仍释放条目载荷，与 `production-observation.ts:322-323`、`sqlite-muse-intake-operations.ts:517-567`、`production-muse-intake-control.ts:171-172` 一致。
- ADR 0187 第 84 行：固定/滚动窗口说法与 `production-observation.ts:186-192` 一致。
- 命令路径测试断言：`test/integration/gap-cases.test.ts:357-361` 现在先断言快照 payload 存在、取消后为 `undefined`；若 unmark 不删 payload，第二句会失败。

## 四、必答问题

**1. 会不会改变模型已经见过的请求开头？发给模型的内容是否仍然只在末尾追加，每轮会变的值是否都在最后一条消息？**
- PR 314 自身：不会。它不新增任何发给模型或嵌入服务的请求（ADR 0187 第 8 条；`production-gap-cases.ts`/`production-gap-export.ts` 无 egress/model 调用），只读写数据库、加密载荷和 HTTP 导出响应。
- 合并进来的 main（PR315/ADR0188）：改变了遮盖规则，但实现按对话冻结规则版本：`RuntimePromptBundle.redactionRuleset` 由 `#rulesetFor`/`#open` 固定（`thread-prompt-bundle-service.ts:263-292`），`admitPiStream` 每次请求把同一版本传给 `ModelEgressContext`（`pi-runtime-adapter.ts:1003-1007, 1567`），egress 用该版本遮盖（`model-egress.ts:220-229`）。`Exchange.#known` 是每请求新建（`model-egress.ts:128-138, 524-525`），按消息数组顺序累积（`maskRequest` → `maskTree`），旧消息先处理，所以追加新消息不会改变旧消息的字节。存量对话在 rollout 时固定为版本 1、中途换版本会断开并留 trace，符合“只在末尾追加”。
- 每轮会变的值（时间、运行环境说明）仍由既有 ADR 0164 机制放在最后一条消息，本次增量未改这块逻辑。
- 结论：满足 `prompt-prefix.md` 的“只追加”；唯一需注意的就是上面低问题里的 rollout 语义。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**
- PR 314 的模型输入没有新增文本；周报快照里的 `generatedAt`、`markedAt` 是界面/API 字段，不进入模型请求。差距线与案例的集合顺序是确定的：SQL `ORDER BY e.muse_at, e.id`、`firstPerMail` 取最早、`GAP_ATTRIBUTIONS` 固定，没有无序集合进入模型。
- main 的遮盖：同一对话内 ruleset 固定、`known` 每请求按同样顺序重建，因此同一前缀字节稳定；不同对话因规则版本不同可能对同一文字给出不同结果，这是设计使然且不破坏单对话前缀。
- 导出预填文字的遮盖用“当前”规则（`maskForExport`），未来规则升级会让导出文本变化，但那是 API 响应，不是模型请求开头。
- 结论：不违反“只追加 / 同对话字节稳定”。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**
- 有：`migration-engine.contract.test.ts`（序号 82、`appliedSequences`、`assertWritableSchema(82)`、表清单与 catalog 全量比对）、`schema-contract.contract.test.ts`；`prompt-prefix.compat.test.ts` 的 `[ADR-0188]` 三条（旧对话全程不变、新对话首轮遮盖、**REVERSE 中途换版本必须断开**）；`model-egress.unit.test.ts`（ruleset 1 与默认对比）；`thread-prompt-bundles.test.ts`（新/旧/`classification_lower`/换工具/旧记录无字段）；`redaction.unit.test.ts`、`identifiers.unit.test.ts`。
- 本轮新增断言（`gap-cases.test.ts:357-361`）在 unmark 不删 payload 时会失败；迁移序号不更新时 contract test 的 `currentSequence/appliedSequences` 会失败；中途换 ruleset 时 compat 反向用例会报告 `message-changed`（`helpers/prompt-prefix.ts:34-45`）。
- 未核实：受工具限制没有实际运行 `npm test` / lint，只做了静态核对。

**4. 改动产生/修改的每个值，使用它的地方都能接受吗？**
- `redactionRuleset`：写端 `sqlite-thread-prompt-bundle-operations.ts:158-161` 校验 undefined 或 safe int ≥1；读端 `storedRuleset` 做 `min(当前版本)` 与非法值回落；PI 与 egress 都接受可选 number。两端一致。
- `gap_case_marks.case_id`：产生 `gap_`+20 位十六进制=24（`production-gap-cases.ts:gapCaseId`）；DB `CHECK case_id GLOB 'gap_*' AND length=24`；导出用 `mark.caseId` 并与快照 id 比对。通过（测试 `gap_0123456789abcdef0123` 也是 24 位）。
- `snapshot_ref`：由 `seal` 写入 `payloads.ref`，迁移外键 `REFERENCES payloads(ref)`（`payloads.ref` 是 PRIMARY KEY）；取消标记/清除 Muse 都先删 mark 再删 payload，满足 `ON DELETE RESTRICT`。通过。
- `marked_at`：产生 `new Date().toISOString()`（含 `.???Z`），DB `CHECK ... GLOB '????-??-??T??:??:??.???Z'`，生产时钟是 `productionClock()` 的 `toISOString()`。通过。
- `gapExportSecretRef`：解析器接受新键并按 purpose `gap-export` 校验（`strict-configuration.ts:1061-1078, 1418-1424`），`service-main` 按 ref+purpose 解析，启动测试覆盖错 purpose/缺失。通过。
- `proactive.gapcase.mark` payload：契约 schema 与 fixture 一致；服务端重算窗口（`resolveWindow`，`endDay` 是排他边界日，与 `report.endDay` 一致）和案例，找不到就 `GAP_CASE_NOT_FOUND`。通过。
- 迁移序号 82：`migration-engine`、`schema-catalog`、三个契约测试一致；未发现别处硬编码 81（只有过期文档，见低问题）。
- 未核实：真实数据库迁移/全量测试未实际运行。
