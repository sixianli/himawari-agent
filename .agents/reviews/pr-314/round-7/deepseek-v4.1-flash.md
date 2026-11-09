# PR 314 第 7 轮复核结论（增量 611ff977 → 65d260ad）

## 总评

增量里生产代码确实只删了一行（`apps/agent-service/src/production-observation.ts` 的 `seal.release`）；我核对了删除载荷的实际实现，**删掉这行是安全的**：`gapUnmark` 在同一事务里先删标记行、再删 `payloads` 行；返回值现在只用于判断是否 `null`，没有别的调用方依赖它去释放。

未发现中、高严重度的功能或安全缺陷。发现的问题都是低严重度，集中在**文档与代码不一致**、**作者说法与 diff 不一致**、以及一处**未来存储切换的风险/测试覆盖薄弱**。

---

## 问题（按严重度从高到低）

### 1. 低（文档，读代码证实）：ADR 新写的“网页标记的案例……能在网页上取消”在未设观察起点时不成立

- 文件:行：`docs/adr/0187-weekly-gap-lines-and-cases-against-muse.md:84`
- 问题：新句说“网页标记的案例总是当前窗口里的案例，能在网页上取消；只有命令里带了别的周的结束日，才会出现网页看不到的标记”。但没设观察起点时，周报窗口是**滚动**的最近 7 天，旧的网页标记会随时间移出窗口，之后网页上就看不到、也就不能在网页上取消——这正是原句描述的问题，不是只有“命令带别的周结束日”才会出现。
- 证据（亲自读到）：
  - `apps/agent-service/src/production-observation.ts:186-192`：未传 `end` 且没有 start 时走 `{ now: new Date(now), days: 7 }`，窗口随 `now` 前进。
  - `apps/control-center/src/proactive.ts:152-155`：网页读取固定发送 `{ end: null }`，因此总是走上述滚动窗口。
  - `apps/control-center/src/components/weekly-report.tsx:1134-1140`：页面只渲染当前 `report.gapCases`，按钮也只出现在这些条目上。
  - 结论：设了观察起点时窗口固定为起点起的 7 天，网页标记确实一直可取消；**没设起点时**，一周前网页标记的案例会移出窗口，网页无法再取消。
- 建议：改写为“设了观察起点（固定窗口）时，网页标记的案例一直在当前窗口里、能在网页上取消；未设起点（滚动窗口）时，旧标记会随窗口前移而只在导出里保留，直到清除 Muse 数据或手动发命令取消”。

### 2. 低（文档，读代码证实）：ADR 决策 7 的“之后调用方的释放只是空操作”对“清除 Muse 数据”路径不准确

- 文件:行：`docs/adr/0187-weekly-gap-lines-and-cases-against-muse.md:47`
- 问题：该句夹在“取消标记和清除 Muse 数据……”之后，字面上会让人以为清除 Muse 数据后调用方的释放也是空操作。实际 `clearAll` 只在本事务里删了**标记快照**载荷；Muse 条目本身的 `title_ref/text_ref` 载荷是返回给调用方、在事务外由 `seal.release` 删除的，**不是空操作**。
- 证据（亲自读到）：
  - `packages/persistence-sqlite/src/sqlite-muse-intake-operations.ts:517-566`：事务里删 `gap_case_marks` 及其 `snapshot_ref` 载荷，最后 `return { refs: rows.flatMap(...titleRef/textRef...) }`，并未删这些 `title/text` 载荷。
  - `apps/agent-service/src/production-muse-intake-control.ts:170-173`：`const { refs } = await this.#store.clearAll(...); if (refs.length > 0) await this.#seal.release({ ...scope, refs });`，这里实际删的是 Muse 条目载荷。
- 建议：把该句限定为“标记快照载荷不需要调用方再释放”；清除 Muse 数据路径应写明条目载荷仍由调用方 `release` 删除。

### 3. 低（作者说法与 diff 不一致，读代码证实）：ADR 实际改了两处，不是“一句话”；测试也不止加了状态码断言

- 文件:行：`docs/adr/0187-weekly-gap-lines-and-cases-against-muse.md:84`、`docs/adr/0187-weekly-gap-lines-and-cases-against-muse.md:87`、`test/integration/gap-cases.test.ts:581-582`
- 问题：作者说“ADR 改了一句话；导出测试加了状态码断言”。实际 diff 是 2 条已知局限 bullet 都有改写（案例窗口说明 + 取消标记释放说明），测试除了状态码还加了 `cases` 的 id 等值断言。
- 证据（亲自读到 `git diff 611ff977..65d260ad`）：ADR 为 `2 insertions(+), 2 deletions(-)`，两条 bullet 都变了；测试新增：
  ```ts
  expect(exported.statusCode).toBe(200);
  expect(exported.json().cases.map((entry: { id: string }) => entry.id)).toEqual([long.id]);
  ```
- 建议：提交说明/复核材料如实写成“ADR 改了两处，测试补状态码与案例 id 断言”。作者关于“生产代码只改一行”的说法属实（1 行删除）。

### 4. 低（推测 / 已知局限）：`gapUnmark` 直接写 SQL 删 `payloads` 行，绕过 `PayloadStorePort`，未来切到密文文件存储会留下文件

- 文件:行：`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:461-477`
- 问题：`gapUnmark` 用 `DELETE FROM payloads ...` 删元数据行；当前生产载荷是 SQLite 内联（`sqlite_blob`），所以删干净没问题。若以后启用外部密文文件（`HybridPayloadStore`），该 DELETE 不会删对应文件，会留下密文文件。ADR 已把它列为已知局限，但这次删除 `seal.release` 后再没有兜底。
- 证据（亲自读到）：
  - `packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:470-476`：事务里先 `DELETE FROM gap_case_marks`，再 `DELETE FROM payloads WHERE ref = ? ...`，没有文件清理。
  - 当前生产走 `durable-adapters.ts:297-303` 的 `payload.put/get/delete`，未发现 `HybridPayloadStore` 在 `apps/` 下被引用；`sqlite-durable-operations.ts:1693-1716` 默认 `storage inline`。
  - 补充：旧的 `seal.release` 在这种未来场景里也救不了——`HybridPayloadStore.delete` 先读元数据（`ciphertext-file-store.ts:258-264`），而 `gapUnmark` 已经把元数据删了，读不到 `relativePath`。
- 建议：保持现状可接受；若将来启用文件存储，应在同一事务内存下 `ciphertext_path` 并删文件，或让 `gapUnmark` 走 `PayloadStorePort`。这条属于“推测/未来风险”，不是本次回归。

### 5. 低（测试覆盖，读代码证实）：取消标记删载荷的断言走的是端口直调，未覆盖生产命令路径

- 文件:行：`test/integration/gap-cases.test.ts:522-537`、`test/integration/gap-cases.test.ts:330-362`
- 问题：`deletes the snapshot together with the mark row when unmarking...` 直接调 `h.marks.unmark(...)` 验证载荷被删；而走 `ProductionObservation` 命令路径的测试只验证 `marks.list` 为空，没有验证载荷被删。也就是说，若有人把 `#markGapCase` 的 unmark 分支写错（例如不再调 `unmark` 却仍返回成功），现有断言不一定能区分。
- 证据（亲自读到）：`gap-cases.test.ts:531-532` 直接调端口；`gap-cases.test.ts:344-347`（mark 后 export）与 `:357-359`（unmark 后 export 为空）未检查 `snapshotRef` 对应载荷。
- 建议：在“marks a case ... removes it when unmarked”里补一条：unmark 前后用 `payloadStore.get(row.snapshotRef)` 断言由有变无。

---

## 侧重检查（错误路径、不可信输入、安全、资源、不可撤销、文档一致）

- **取消标记的错误路径**：`gapUnmark` 在行不存在时返回 `null`，不发错误；生产层据此返回 `replayed: true`。事务删除顺序正确（先标记行、后载荷，满足 `gap_case_marks.snapshot_ref REFERENCES payloads(ref) ON DELETE RESTRICT`，见 `0082_gap_case_marks.sql:5`）。**读代码证实，无问题。**
- **标记写库失败 / 重复标记**：`production-observation.ts:333-339` 仍保留 `.catch` 释放和 `if (!added)` 释放，这两条路径没有随本次删行丢失。**读代码证实，无问题。**
- **清除 Muse 数据**：`sqlite-muse-intake-operations.ts:528-539` 在同一事务里删 `gap_case_marks` 与快照载荷；测试 `gap-cases.test.ts:454-469` 覆盖。**读代码证实。**
- **不可信输入/校验两端**：命令契约 `caseId: machineString`、`endDay: jstDaySchema`、`marked: boolean`（`contracts-v2.ts:936-943`）；标记时服务端重算窗口并用 `found.id` 才写库（`production-observation.ts:325-334`），因此入库 `case_id` 一定满足 `0082_gap_case_marks.sql:4` 的 `GLOB 'gap_*' AND length=24`；`gapCaseId` 产生 `gap_`+20 hex（`production-gap-cases.ts:39-41`）。导出端再校验快照 `id === mark.caseId`（`production-gap-export.ts:147`）。**读代码证实，两端校验一致。**
- **安全**：导出用 `BearerGate`，SHA-256 后 `timingSafeEqual`（`bearer-admission.ts:23-35`）；认证/未认证限流桶分开；未认证 401 空体（`production-gap-export.ts:183-190`）；导出快照与标记 id 不一致时跳过，全部读不出才 500（`:139-170`）；预填文字先 `maskForExport` 再截断，并在输出前再遮一次（`:72-93`, `:158-163`）。**读代码证实，未发现新漏洞。** 我只做了静态阅读，未运行测试。
- **资源耗尽**：候选读取 SQL 硬上限 1000（`sqlite-decision-ledger-operations.ts:512`），案例上限 50（`production-gap-cases.ts:10`），导出无上限（ADR 已列已知局限）；标记由本人逐条操作，未发现本次新增放大点。**读代码证实。**
- **不可撤销操作**：取消标记会永久删除该案例快照载荷；由于快照可从同一窗口重算，重新标记可恢复（前提是底层评价/邮件数据仍在）。这是既定设计。**读代码证实。**
- **文档与代码一致性**：见问题 1、2、3。其余核对项（`gapExportSecretRef` 用途、迁移序号/manifest、表说明）一致，见必答问题 4。

---

## 必答问题

### Q1. 会不会改变模型已经见过的请求开头？发给模型的内容是否仍只在末尾追加、每轮变化值是否都在最后一条消息？

**不会。** 本次增量只改了三处：`production-observation.ts:322-323` 的数据库取消标记路径、ADR 文字、集成测试；没有触碰系统提示、工具定义、历史消息、提示词目录或模型发送/遮盖链路。这个 PR 的差距线/案例功能也明确不新增模型或嵌入请求（ADR 决策 8），新增的两个文件 `production-gap-cases.ts` / `production-gap-export.ts` 都是读数据库、加解密载荷和 HTTP 导出，没有 `modelRuntime.stream` 之类调用。

- 因此“发给模型的内容仍只在末尾追加、每轮变化的值仍在最后一条消息”这一点没有被本次改动破坏；本次改动不涉及该链路。
- **未核实**：规则里说的阻断检查 `npm run check:prompt-prefix` 我无法运行（本轮只允许 git 命令），所以门禁的实际执行结果未核实；以上是基于改动范围的判断。

### Q2. 会不会让同一段文字在不同请求里变成不同的字节？

**对模型可见内容：不会。** 本次没有新增模型请求；`gapCaseId` 是 `sha256(pairedMessageId)` 的固定前 20 位（`production-gap-cases.ts:39-41`），快照是对象字面量顺序固定的 `JSON.stringify`（`production-observation.ts:331-332`），导出列表顺序固定为 `ORDER BY marked_at, case_id`（`sqlite-decision-ledger-operations.ts:483-486`），案例列表顺序固定为 SQL `ORDER BY e.muse_at, e.id`（`:512`）。遮盖走既有的确定性 `redactForEgress`。

需要单独说明：导出响应体里的 `generatedAt: this.#clock.now()`（`production-gap-export.ts:171`）和 `markedAt` 每次/每条不同，但导出是给定时开发会话的只读 HTTP 接口，**不是发给模型的内容**，不影响提示缓存。**读代码证实。**

### Q3. 有没有对应的自动检查，反向用例是否真的会失败？

有，且能失败：

- `test/integration/gap-cases.test.ts:522-537`：unmark 后断言 `payloadStore.get(ref)` 为 `undefined`。若把 `gapUnmark` 里的 `DELETE FROM payloads` 去掉，这个断言会失败——这就是“删载荷”的反向用例，即使生产层已经不再调用 `seal.release`，也能抓住。
- `test/integration/gap-cases.test.ts:565-588`（本轮改的）：新增 `statusCode === 200` 和 `cases.map(id) === [long.id]`。若导出变成 500 空体（例如快照读不出），旧断言 `body` 不含卡号会误通过，现在会失败。这个补强是有效的。
- `test/integration/gap-cases.test.ts:590-651`：覆盖全损坏 500、损坏跳过、id 不匹配跳过。
- 未覆盖点：没有测试断言“生产命令路径 unmark 后快照载荷必须不存在”（问题 5），也没有测试能察觉“多余地重新加回一次 release”（这种冗余不可观测）。
- **未核实**：我没有运行测试（只允许 git 命令），以上是从测试代码推断的结论。

### Q4. 改动产生或修改的每个值，每个使用它的地方都能接受吗？逐个核对产生端与使用端

已逐个核对（重点是新标识/字段/配置键/清单项/序列化格式）：

| 值 | 产生端 | 使用端 | 两端校验结论 |
|---|---|---|---|
| `caseId` = `gap_`+20 hex | `production-gap-cases.ts:39-41` | 命令契约 `machineString`（`contracts-v2.ts:939`）→ `#markGapCase` 只在 `found.id` 匹配时写库（`production-observation.ts:326-334`）→ DB CHECK `GLOB 'gap_*' AND length=24`（`0082_gap_case_marks.sql:4`）→ 导出比对 `parsed.id === mark.caseId`（`production-gap-export.ts:147`） | 一致；24 位满足 CHECK；测试 fixture `gap_0123456789abcdef0123` 也是 24 位（`gateway-v2.fixture.ts:300-304`） |
| `proactive.gapcase.mark` 操作 | 命令契约 `contracts-v2.ts:936-943,2359` | 控制中心发送 `proactive.ts:171-179`；审批网关路由 `production-approval-gateway.ts:219-220`；安装操作清单 `production-observation.ts:41-45`、`production-http-composition.ts:668`；fixture `gateway-v2.fixture.ts:300-304` | 一致 |
| `gapExportSecretRef` / purpose `gap-export` | 配置类型 `configuration.ts:237`；解析 `strict-configuration.ts:1064-1077` | 启动校验“恰好一个、purpose 相符”`strict-configuration.ts:1421-1427`；运行时再按 ref+purpose 取密钥 `service-main.ts:1688-1694`；测试正反例 `startup-configuration.unit.test.ts:1442-1462` | 一致 |
| `gap_case_marks` 表/迁移清单 | `migration-engine.ts:647-653`（sequence 82） | `schema-catalog.ts:820-826` 同名登记；`0082_gap_case_marks.sql` 定义 | 一致 |
| 快照序列化（`GapCaseSnapshot`） | `production-observation.ts:331-332` 写入加密载荷 | `production-gap-export.ts:53-70` `isGapCaseSnapshot` + `:147` id 比对；只用被校验的 `museTitle/himawariReason/attribution/ownerRating/memoryHits/relatedMessages/himawariOutcome/museAt/weekStart/weekEnd` | 一致；未校验字段不参与输出，`attribution` 用 `Object.hasOwn` 白名单 |
| `unmark` 返回值 `snapshotRef \| null` | `sqlite-decision-ledger-operations.ts:461-477` | 现在唯一生产使用点是 `production-observation.ts:322-323` 的 `ref === null`；测试 `gap-cases.test.ts:531` 仍验证返回值 | 一致；删掉 release 后没有其他调用方依赖它去释放（全仓 grep 确认只有这一处生产调用） |

**结论**：本次改动涉及的值在产生端与使用端的校验是匹配的，没有发现 I-73 那类“清单里的 id 过不了后端校验”的问题。上表均“读代码证实”。
