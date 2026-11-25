本轮查过的范围：`70357f5..787a33f` 的增量（只动了这份规格和复核记录），以及规格 `232-271`、`655-658`、`175`、`465`、`550` 几处；对照读了 `production-inbox.ts`、`sqlite-inbox-operations.ts`、`production-inbox-worker.ts`、`context-external-content.ts`、`production-run-composition.ts`、`production-runtime-tools.ts`、`pi-runtime-adapter.ts`、`intelligence.ts`、`inbox_events` / `thread_messages` 迁移和 ADR 0285。旧代码没有被增量改变的部分没有整份重读，证据指向时才跟下去。作者列出的代码引用逐条核对，除 `clip` 的“去控制字符”外都对。

### 1. 中 — 叫醒/“等不到了”/改版通知虽带 `external_content`，现有代码却不按这一列打标，生产里也没有消费端

文件:行：`docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md:248`；`apps/agent-service/src/context-external-content.ts:85-90`；`apps/agent-service/src/production-http-composition.ts:1336`；`apps/agent-service/src/service-main.ts:3522-3525`；`packages/persistence-sqlite/src/sqlite-inbox-operations.ts:19-20`

问题：规格写“事件带上那一条的标记（收件箱表已有 `external_content` 一列）……收到的对话照外来的事写进对话时的做法打上标记”。但现有“外来事件打标”只看运行的 `sourceType`，不看收件箱行的 `external_content`。生产组合里又没有传 `delivery`（`production-http-composition.ts:1336` 只在 `options.inbox.delivery` 存在时才传，而 `service-main.ts:3522-3525` 的 `inbox` 只有 `onDiagnostic`），所以这一列目前没有生产消费端。若第 3 步把结果板事件按 `external_event` 投递，所有叫醒都会被标成外来内容（过度标记）；若按别的来源投递，这一列又会被忽略。上一轮第 2 条只修到了“写入时带上标记”，没有接上读取端。

证据：
```
// context-external-content.ts:88
if (source?.sourceType !== "external_event" || source.ownerApprovedTask) return null;
```
```
// production-inbox.ts:229
externalContent: input.externalContent === true || source.externalContent,
```
```
// sqlite-inbox-operations.ts:19-20
const columns = `id, source_kind AS sourceKind, source_ref AS sourceRef,
  source_version AS sourceVersion, external_content AS externalContent,
```

建议：明确投递结果板事件时必须读 `entry.externalContent` 并按该值给目标对话/运行打标，不能只说“照已有做法”；补正反两条测试（带标记的事件要打标，不带标记的叫醒不应误标），并在条目删除前先取出标记。

### 2. 中 — 看目录返回简要，却没有要求把条目的数据分级带到工具结果

文件:行：`docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md:243-244`；`packages/application/src/ports/intelligence.ts:489`；`apps/agent-service/src/production-runtime-tools.ts:1010-1014`

问题：第 1 条只写“读正文时，工具结果带上这条存下的分级”；第 2 条的目录会返回兄弟写的“名字、简要”，但没有任何一句要求目录工具结果也带分级。简要里可能有敏感内容，子线程只读目录时，运行级的分级不会因此升高。`contentClassification` 是可选项，不返回就没人处理。

证据：
```
// 规格:243
读正文时，工具结果带上这条存下的分级（`RuntimeToolSettledResult` 的 `contentClassification`...）
// 规格:244
不带参数时只返回目录，每条一行：哪个子线程、名字、简要、第几版、什么时候写的
// intelligence.ts:489
readonly contentClassification?: DataClassification;
```
```
// production-runtime-tools.ts:1011-1013
recorded = highestClassification(
  invocation.dataClassification,
  contentClassification ? [contentClassification] : [],
);
```

建议：目录工具结果也要携带所列条目中的最高分级；补一条“只读目录、目录含 sensitive 简要，运行分级被抬高”的反向测试。

### 3. 中 — “等结果”在结果已存在时直接返回，没写返回的是不是正文、要不要记已读和打外来标记

文件:行：`docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md:246-248`

问题：“等的那条结果已经在了，‘等结果’直接返回，不停下。”如果返回的是正文，它同样属于“读这一条的正文”，按第 5、6 条应当同时记下“读过第几版”、让读者拿到改版通知，并打上外来内容标记；如果只返回“已经有了”，那应明确让子线程再走“看兄弟结果”，否则实现者很容易做成返回正文但不记录。现在两种都没写清。

证据：
```
// 规格:246
等的那条结果已经在了，“等结果”直接返回，不停下。
// 规格:247
程序记下谁（子线程或主对话）读过哪条的第几版正文；只看过目录不算读过。取正文和记下读过哪一版放在同一个写事务里
// 规格:248
谁读这一条的正文（别的子线程或主对话），谁就打上这个标记
```

建议：二选一写死：要么“等结果”只返回已就绪，正文一律由“看兄弟结果”取；要么“等结果”返回正文时，同样在同一个写事务里记已读并打外来标记。补一条“结果早已存在时直接返回正文，仍能收到下一次改版通知”的测试。

### 4. 中 — 注册等待时不查兄弟已失败/已删，失败事件又没有定义版本，重复“等不到了”可能被唯一键去重后永久挂起

文件:行：`docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md:246-247`；`packages/persistence-sqlite/src/migrations/20261124153216_inbox_events.sql:7`、`:20`

问题：第 4 条只保证“等待过程中”兄弟失败/被删会叫醒等待者；没有写“等待者在兄弟已经失败/被删之后才调‘等结果’”该怎么办。此时没有结果存在，注册后会一直等一个已经不可能再来的事件。另一个洞是“等不到了”的来源编号和版本没有定义；`source_version` 在数据库里只限长、可以为空，唯一键又包含它。如果同一条等待记录第二次得到“等不到了”，用同一个空版本会被当重复挡掉，等待者收不到第二次叫醒。

证据：
```
// 规格:246
被等的兄弟子线程失败、被叫停、进入“做不下去”，交回结果时没写被等的那个名字，或者被等的子线程、条目被删，等它的子线程也被叫醒，收到“等不到了”
// 规格:247
收件箱表 `inbox_events` 的唯一键是主人编号、助手编号、来源种类、来源编号、版本
```
```
// 20261124153216_inbox_events.sql:7
source_version TEXT NOT NULL CHECK (length(source_version) <= 256),
// :20
UNIQUE (owner_id, agent_id, source_kind, source_ref, source_version)
```

建议：在“等结果”的同一个写事务里同时检查被等条目/子线程是否已失败、已删、已“做不下去”；是则直接返回“等不到了”，不登记。给失败事件定义稳定的来源编号（含接收者）和每次等待唯一的版本（例如等待记录编号），或者把等待记录编号放进来源编号。补“兄弟失败后才注册”“同一等待重复失败”两条用例。

### 5. 中低 — 名字的清洗只在写入端，查找端不跟着规范化；`clip` 也不会去掉控制字符

文件:行：`docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md:243-244`、`:246`、`:265`；`apps/agent-service/src/production-inbox.ts:53-56`

问题：规格写名字写入时“把换行和连续空白折成一个空格、去掉控制字符”，但“看兄弟结果”和“等结果”都按名字查找，没有要求对传入的名字做同一套规范化。子线程拿原始名字（例如含换行）去查，可能查不到，或另建出另一条。其次，规格说照 `clip` 去掉控制字符，`clip` 实际只做 `\s+` 折叠和 `trim`，C0/C1 及 Unicode 格式字符（如 U+202E）不会被去掉；新增的反向用例只测了换行。

证据：
```
// production-inbox.ts:53-56
function clip(text: string, maximum: number): string {
  const characters = [...text.replace(/\s+/gu, " ").trim()];
  return characters.length <= maximum ? characters.join("") : characters.slice(0, maximum).join("");
}
```
```
// 规格:265
名字里带换行，目录里它仍只占一行。
```

建议：抽一个 `normalizeName`，写入、目录过滤、按名字取正文、按名字等待全都用它；长度校验放在规范化之后；明确要剥掉的控制/格式字符集合（至少 C0/C1 和常用 bidi 控制符），并把反向用例扩展为“写入带换行和控制字符的名字后按原字符串读取/等待仍命中”。

### 6. 中低 — “被删时叫醒”没写删除路径怎么在级联删除等待记录之前找到等待者

文件:行：`docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md:246`、`:260`；`packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:92`；`packages/persistence-sqlite/src/migrations/20261124153216_inbox_events.sql:11`

问题：规格要求被等条目/子线程被删时给等待者放“等不到了”，并“那条等待记录同时删掉”。但如果等待记录和条目/子线程之间按本仓库常见的 `ON DELETE CASCADE` 建，删条目会先级联删掉等待记录，删除代码事后就找不到该通知谁；事件也读不到已删条目的外来标记。现在没有写删除顺序。

证据：
```
// 规格:246
被等的子线程、条目被删，等它的子线程也被叫醒，收到“等不到了”（写明是哪一种），那条等待记录同时删掉
```
```
// 0001_initial_product_schema.sql:92
thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
// 20261124153216_inbox_events.sql:11
thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
```

建议：把删除写成明确的删除事务：先在事务内查出所有等待者、记下条目的外来标记，给每个等待者入队“等不到了”，再删等待记录和条目；如果依赖外键级联，必须证明级联不会先吞掉等待记录。测试要经过真实删除命令，不要直接对表执行 `DELETE`。

### 7. 低 — 单板有上限，但结果板整体永不删除，长期总量仍无上限；版本到顶后也没有回收办法

文件:行：`docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md:243`、`:175`

问题：新增的条目数、版本数、目录行数上限只约束“一块结果板”。结果板又跟着不会到期的子线程保留，每一件大事都会留下最多“条目上限 × 版本上限 × 正文长度”的加密载荷，长期总量仍随大事数量增长。版本数到上限后规格只说“报错拒收，由写的子线程自己决定怎么办”，但子线程没有删旧版本、腾出版本位的工具，实际只能在“不再更新”和“告诉主对话”之间选。

证据：
```
// 规格:243
每块结果板的条目数、每个名字的版本数也有上限……到了上限“记下结果”报错拒收，由写的子线程自己决定怎么办
结果板跟着它的大事和子线程一起保留、一起删，不单独到期。
// 规格:175
子线程也是对话，存在聊天记录里，不会到期删掉
```

建议：至少给“整件大事收尾后”或“每主人/每件大事总量”一个上限或清理入口；若要禁止删旧版本，就明确版本到顶时子线程可以走“告诉主对话”或覆盖最新版的策略。上一轮第 5 条只解决了单板增长，没有解决总量。

### 8. 低 — ADR 0285 决定 8 仍未改写，规格里的“不冲突”澄清没有落到决策记录

文件:行：`docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md:251`；`docs/adr/0285-one-main-thread-subthreads-and-one-inbox.md:42`

问题：规格说“这和 ADR 0285 决定 8 的‘子线程结果不清’不冲突，那里说的是子线程交回主对话的结果”。但 ADR 原文只有“计划、子线程结果、同意卡片和记忆快照不清”，没有区分“交回结果”和“看兄弟结果的工具结果”。这条澄清只写进了规格，将来照 ADR 实现的人仍可能把 `contextRetention: "keep"` 加到“看兄弟结果”上，和这里允许清理相反。上一轮第 9 条只是部分改好。

证据：
```
// ADR 0285:42
计划、子线程结果、同意卡片和记忆快照不清。
// 规格:251
旧的“看兄弟结果”工具结果和其他工具结果一样，可以被清理旧工具结果清掉，要时再取；这和 ADR 0285 决定 8 的“子线程结果不清”不冲突，那里说的是子线程交回主对话的结果。
```

建议：在 ADR 0285 决定 8 加一句修订或注记，明确“子线程结果”指交回主对话的结果，“看兄弟结果”的工具结果不适用 `keep`；或者在规格里直接写 ADR 已由本规格解释，避免两处冲突。

## 上一轮意见核对

| 上轮意见 | 是否改好 | 说明 |
| --- | --- | --- |
| 1 高：正文/简要绕过加密载荷和分级 | 已改 | 改成载荷引用 + 数据分级，引用行核对正确；残留“目录不带分级”见第 2 条 |
| 2 高：叫醒/“等不到了”未继承外来标记 | 部分 | 事件写入可带标记，但现有读取端不按这一列打标，见第 1 条 |
| 3 中高：做不下去/被删不叫醒等待者 | 已改 | 第 4 条和用例已补；删除路径仍有级联风险，见第 6 条 |
| 4 中：成环检查不在同一写事务 | 已改 | 同事务 + `BEGIN IMMEDIATE`，核对通过 |
| 10 低：读正文和写已读不同事务 | 已改 | 第 5 条已写同事务；但“等结果”直接返回正文是否算读正文未写，见第 3 条 |
| 5 中：结果板无上限 | 部分 | 加了单板条目/版本/目录上限；总量和版本回收仍缺，见第 7 条 |
| 6 中：改版通知只写名字 | 已改 | 第 5 条改成“订机票的‘落地时间’改成第 2 版了” |
| 7 中低：名字/简要没有换行和控制字符处理 | 部分 | 换行会折叠，但 `clip` 不去控制字符，查找端也不规范化，见第 5 条 |
| 8 低：新值清单漏项、引用旧迁移 | 已改 | 已换成 `inbox_events` 新迁移，并补了来源种类、来源编号/版本长度 |
| 9 低：ADR 0285 未记录、有歧义 | 部分 | 规格加了澄清句；ADR 原文未改，见第 8 条 |

## 侧重检查

- **错误路径**：查了兄弟失败、被叫停、“做不下去”、交回没写名字、条目/子线程被删，以及“等待者在兄弟已失败后才注册”。后两种规格没写清，见第 4、6 条。
- **不合规范或不可信输入**：查了名字/简要的换行、连续空白、控制字符、按名字查找、目录行伪造。`clip` 的行为与规格说法不一致，查找端也没统一规范化，见第 5 条。
- **安全/权限**：查了外来内容标记的生产-消费两端、目录 vs 正文的数据分级、工具结果的 `contentClassification`。标记消费端缺失、目录分级缺失，见第 1、2 条。
- **资源耗尽**：单板条目/版本/目录行数有上限，但结果板不整体到期，总量无上限；正文“可以很长”只有编码时定的长度上限。见第 7 条。
- **不可撤销操作**：旧版本永久保留、删除大事时载荷要跟着删。规格有用例但新表和删除代码不存在，删除级联风险见第 6 条。
- **规则/文档一致**：本轮新加的 `thread_messages` / `inbox_events` / `BEGIN IMMEDIATE` / `contentClassification` / `clip` / ADR 0285 引用逐条核对；除 `clip` 去控制字符外引用正确；ADR 的“子线程结果”解释仍只在本规格里。
- **未核实**：结果板新表、读过记录、等待记录、投递实现、导出/删除清单、苹果端折叠界面都还是第 3 步的设计，仓库里没有对应代码；生产 `inbox` 当前也没接入 `delivery`。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。按规格，目录、正文、叫醒/改版通知都是工具结果或追加的内部消息，接在对话末尾；结果板变了只影响下一次读到的内容，不回头改已发内容（规格 251）。每轮会变的结果板版本、写入时刻、未列条数都在最后追加的工具结果里。唯一一次开头变化是第 3 步新增“记下结果/看兄弟结果/等结果”等工具定义，按 `prompt-prefix.md` 第 6 条和规格 465 换新一次并留记录，不是每轮变。依据规则第 4 条。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**
在同一个对话里，只要按规格实现固定排序、固定时间格式、固定名字/简要折算，同一块结果板生成的目录/正文是确定的，没有当前时间、没有无序集合。跨对话时，出口遮盖可能因为该对话前面记下的敏感值不同而遮出不同字节；这是既有规则第 11 条“只取决于自身和前面的内容”允许的，不是结果板新增的每轮变化。规格应写明结果板存原文、发送时按所在对话重新遮盖。名字写入和查找不统一则是另一个问题（第 5 条）。

**3. 有没有对应的自动检查，反向用例真的会失败吗？**
本次是纯文档改动，没有新增可运行的自动检查；规格里的反向用例属于第 3 步要写的测试，现在无法确认会失败。已列出的用例还缺：未标记叫醒事件不应误标、只读目录的敏感分级、兄弟已失败后才注册等待、真实删除路径、控制字符（现在只测换行）。`check:prompt-prefix` 的逐字测试也还是计划中的。

**4. 新值产生端和使用端都对得上吗？**
逐个核对结果：`source_kind`/`source_ref`/`source_version` 的生产校验（`production-inbox.ts:152-155`）、注册正则（`:20`）和数据库约束（迁移 `:5-7`、`:20`）一致；`external_content` 的生产端和数据库一致，但消费端缺失（第 1 条）；`contentClassification` 的正文消费端可用（`production-runtime-tools.ts:1010-1028`、`pi-runtime-adapter.ts:2312-2313`），目录没带（第 2 条）；唯一键和接收者进 `source_ref` 的设计与迁移 `:20` 一致，但“等不到了”的版本未定义（第 4 条）；结果板新表、读过/等待表和导出/删除代码尚不存在，未核实；名字规范化两端不一致（第 5 条）。
