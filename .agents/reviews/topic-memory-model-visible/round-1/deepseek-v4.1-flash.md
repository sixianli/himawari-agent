# 方案审核：存入记忆的内容必须能被模型看到

结论先行：方案的出发点（“存了就要能用上”）可以理解，但这一版把“能用上”实现成了“全部分级都进索引和上下文”，其中有 3 处确认的功能/安全缺口会让验收直接失败，另有几处判断与代码不符。最严重的是：**已归档记忆按现方案根本拿不到**，以及**把 sensitive 记忆塞进 private 运行会造成分类降级**。

---

## 一、证实的（按严重度）

### 1.【高】步骤 3“已归档记忆可被 recall 找到”按现有代码不可能成立

方案说“`includeHistory` 放开后同时返回已归档”，但：

- 索引查询的作用域硬性要求 `m.status = 'active'`，`includeHistory` 只影响 `valid_to`：
  `packages/persistence-sqlite/src/sqlite-memory-operations.ts:240-244`
  ```sql
  const indexScope = `... AND m.status = 'active'
    ... AND (@includeHistory = 1 OR m.valid_to IS NULL OR m.valid_to > @now)`;
  ```
- 记忆一归档，投影任务就是 `delete`，索引行会被删掉：
  `sqlite-memory-operations.ts:653-660`
  ```ts
  input.job.operation !== (input.memory.status === "active" ? "upsert" : "delete")
  ```
- recall 自己又过滤一次 `status !== "active"`：
  `apps/agent-service/src/production-memory-recall.ts:213-215`
- 自动上下文的通用服务也过滤 `status !== "active"`：
  `packages/application/src/services/durable-memory-service.ts:394-398`
- 补索引只扫 active：
  `sqlite-memory-operations.ts:1467-1479`

而且 `includeHistory` 现在表达的是“`valid_to` 已过期的历史版本”（被更正但仍是 active 的旧记录），和“归档”是两回事。方案把两者混在一起了。

**建议**：先定义“归档”的检索语义（`includeHistory` 是否代表归档、是否也代表被更正），然后同时改：归档时保留索引行、`indexScope` 接受 archived、recall/durable-memory 的 status 过滤、`listUnindexed` 覆盖 archived，并为“本次改动前已归档、且索引已被删”的老数据做一次补建。否则验收第 3 条必失败。

### 2.【高】sensitive 记忆进入档案块后，档案块会被标成 `public`

`packages/application/src/services/owner-profile-service.ts:328-332` 只考虑 private/public：

```ts
const dataClassification =
  floor === "private" ||
  memories.some(({ dataClassification }) => dataClassification === "private")
    ? "private"
    : "public";
```

现在因为 `PROFILE_CLASSIFICATIONS` 和 ceiling 把 sensitive 挡在外面，这段不会遇到 sensitive；方案一旦放行，含健康、财务文字的档案块会以 **public** 分类写入 payload（`:337-343`），这是明确的分类降级。方案完全没提这里。

同时还有三层门槛要一起改，方案只笼统说“档案块也可选入”：

- `PROFILE_CLASSIFICATIONS`：`owner-profile-service.ts:17`
- ceiling 再压到 private：`owner-profile-service.ts:149-151`
- `compose` 的 `maxClassification = min(maxMemoryClassification, dataClassification)`：`packages/application/src/services/context-formation-service.ts:236-240`

**建议**：`#block` 的分类改成“包含的所有记忆的最高分级”，并保证不低于 sensitive；下游 payload、trace、推送、导出都必须能接受 sensitive。不能靠“运行是 private”把内容标成 private。

### 3.【高】把 sensitive 内容注入 private 运行，会系统性地绕过披露/授权检查

方案的取舍是“运行仍是 private，sensitive 内容当作 private 用”。但分类是贯穿全链路的：

- 模型披露检查只比较 `request.dataClassification`：
  `apps/agent-service/src/production-model-composition.ts:560-565`
- 嵌入请求按 `projection.memory.dataClassification` 或运行分类检查：
  `apps/agent-service/src/production-run-memory.ts:120-139`
- 运行完成时取 runtime/context 两者最高分类：
  `packages/application/src/services/run-coordinator.ts:727-734`

因此只要内容被塞进 private 的上下文/工具结果，它在 trace、payload、push、exports、完成分类里都会继续被当作 private。方案只在“风险 1”里提到 trace 和工具结果，且把决定留给 ADR；ADR 不能替代分类修正。对未参与本轮对话、从历史/导入/Gmail 得来的健康、财务、证件类记忆，这是实质的数据外发，且发出后不可撤回。

**建议**：把“存储分类”和“本轮可发给模型的范围”分开：记忆内容、上下文块、工具结果保持 sensitive；另设显式的“主人已授权模型读取”策略位。若工具授权确实挡不住 sensitive 运行，用专门的记忆读取授权，而不是把整轮运行的分级降下来。

### 4.【高】后台无人值守任务会把 sensitive 记忆发给模型，方案的“对外部服务代价”漏了这三条

方案只说“聊天模型和嵌入模型”。改成放行后，以下都会把 sensitive 原文发到后台模型：

- 每日整理：`packages/memory-engine/src/consolidation.ts:35,252`（`REVIEWABLE` 目前只 public/private）
- Gmail 主动检查：`apps/agent-service/src/production-proactive-memory.ts:51`（`allowedClassifications: ["public","private"]`）
- 情景摘要：`packages/memory-engine/src/episodes.ts:19,152,236`（`SUMMARIZABLE`）

这些是无人值守、周期性、可能发生在主人不在场时。健康/财务正文只会被出口遮盖掉凭证，不会遮健康词。这是比聊天更敏感的自动外发。

**建议**：把这三条单列为需要 Andy 明确授权的决定，并优先落到零保留/本地模型；至少加总开关和“只对当次请求相关且主人明确问起时”的限制。不要让它们随主改动默认放开。

### 5.【中高】`maxMemoryClassification` 被“只记日志”地忽略，等于悄悄关掉一个隐私配置

- 生产模板就是 `private`：`scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json:16`
- 配置校验接受并校验这个字段：`packages/platform-node/src/strict-configuration.ts:1110-1132`
- 运行输入校验也接受：`packages/application/src/services/run-execution-input-service.ts:72-78`
- 它现在还管**历史与摘要**，不只是记忆：`context-formation-service.ts:148-151,182-197,427`

方案说“保留字段兼容旧配置，若低于 sensitive 只记日志或拒绝启动，待审核意见定”。如果只记日志，运维以为设了 private 就限制了读取，实际被忽略——这不是“兼容”，是静默改变安全语义；如果只对记忆条目改用常量、字段仍管历史，语义会变得非常难解释。

**建议**：把字段拆成两个语义（记忆读取上限 / 历史摘要上限），或直接删除/改名并迁移配置；启动校验应当在冲突时失败（fail closed），并在配置说明里写明“记忆读取上限已由程序固定”，不要只记日志。不要用“运行分类”这一条同时承担两种职责。

### 6.【中高】规则集 1 对话的“recall 只返回遮盖后文字”不可实现为可还原

方案说老对话召回含凭证的记忆时“只返回遮盖后的文字”。但：

- 可还原的占位符需要同一把出口密钥和同一个 tag：`packages/application/src/services/model-egress.ts:121-126`
- `maskSensitiveText` 产出的 `[密码]` 没有编号，无法还原：`packages/sensitive-capture/src/redaction.ts:542-544`，而提示词图例承诺“同一个值始终是同一个编号”“显示时换回原值”：`packages/prompt-catalog/src/chat.ts:255,267`
- 如果把遮盖后的文本写进工具结果历史，后续请求的还原表里没有“原文→占位符”的映射，主人永远看不到原值；如果 recall 用规则集 1 来遮，则“Wi-Fi 密码 abc12345”这种宽松写法根本遮不住（`redaction.ts:350-363`）。

而且老对话的历史里可能本来就有主人打的原文，光遮 recall 结果并不能阻止模型看到它。

**建议**：不要改 recall 的返回文本。二选一：(a) 规则集 1 的对话暂时不返回“含凭证”的记忆（用当前检测能力判断，而不是规则集 1），并用工具结果里的说明告诉主人“这类记忆暂时不可用”；(b) 走“老对话一次性升级规则集”的方案，并保留 ADR 0188 的字节测试。绝不能在 recall 里自造无编号占位符。

### 7.【中高】`check:memory-visible` 的静态检查和反向用例抓不到真正的读取上限

真正的读取上限不是字面量 `["public","private"]`：

- recall：`production-memory-recall.ts:160-163` 用 `CLASSIFICATIONS.slice(0, indexOf(run)+1)`
- 自动上下文端口：`production-run-memory.ts:357-362` 动态 filter
- 上下文拼装：`context-formation-service.ts:279-286` 用 `CLASSIFICATION_RANK[...] <= ...`

把任一处改回只取 public/private，grep 一个“只含 public、private 的名单”都不会失败。反过来，这个检查会误伤合法的 public/private 名单，例如推送正文必须继续排除 sensitive（`apps/agent-service/src/production-web-push.ts:486-498`）、Gmail 主动检查（`production-proactive-memory.ts:51`）、测试夹具。方案里没有区分“模型读取通道”和“合法的非读取用途”。

**建议**：定义一个导出的 `modelReadableMemoryClassifications()`（或 `memoryReadCeiling()`），所有读取通道必须调用它；用一张“调用点白名单 + 每个调用点必须引用该函数”的检查，而不是 grep 分级字面量。再加每个通道的集成测试（真实捕获模型请求体），反向用例直接改该函数或改单个通道的调用。这样才符合 I-73 的教训：不只核对改动本身，还要核对每个使用点。

### 8.【中】置顶 sensitive 对健康/财务基本无效，且与验收第 4 条冲突

- `PINNABLE_CATEGORIES` 只含 identity/preference/relationship/goal/project/rule：`apps/agent-service/src/production-memory-control.ts:57-64,904-906`
- 档案只取 `PROFILE_SECTIONS` 的五类 + rules：`owner-profile-service.ts:24-30,193-202`
- 设计规格本来就写“敏感记忆和事件、健康、财务、其他类不能打开”：`docs/execution/specs/2026-10-25-self-built-memory-engine-design.md:112`

所以“允许置顶 sensitive 记忆”只对少数类别有意义，健康/财务既不能置顶也不会进档案。更关键的是：`rule` 类记忆会无条件进入 `owner-rules` 块，`identity/preference` 类置顶后也会无条件进入档案块——这与验收第 4 条“不相关的问题不带出 sensitive 记忆”直接矛盾。

**建议**：明确区分“按相关度检索”和“常驻档案”。常驻档案默认不接收 sensitive（尤其健康/财务），除非 Andy 明确选择“每轮都带上”；如果接受常驻，就要删掉验收第 4 条，不能两边都写。

### 9.【中】索引改动只对“之后保存”的记忆生效，老数据不会自动变干净

方案说“所有记忆都进全文词项和向量，但词项用遮盖后的文字”，并说现有 sensitive 记忆会被 `listUnindexed` 选中补一次。问题：

- 现有 public/private 记忆里若已存了密码/证件号，旧 FTS 词项里仍是明文；`listUnindexed` 只在“无索引行/修订号变了/可嵌入但无向量”时才重投影（`sqlite-memory-operations.ts:1467-1479`），不会因为“遮盖规则变了”而重算。方案没有一次性的重建/回填。
- 实体表不是投影任务写的，而是保存记忆时写的：`sqlite-memory-operations.ts:798-805`。补索引不会给现有 sensitive 记忆补 `memory_entities`，所以“实体表不再排除敏感”对老数据无效。
- 方案说“全文词项和实体表……先遮盖再分词”，但实体表使用 `attributes.entities` 原值插入，根本不经过遮盖。

**建议**：单独做一次“索引重建 + 实体回填”的一次性迁移，带预算、分批、可暂停、可观察；或者在方案里明确承认“老索引里的旧值不回填”，不要把它写成已经满足。实体表要么同样遮盖，要么明确它只存名字、不承诺遮凭证。

### 10.【中】改提示词图例“只对新对话生效”不完整，且可能影响老对话的遮盖字节

方案的图例修改会改 `CHAT_EGRESS_LEGEND_WITH_RESTORE`，而出口遮盖的 trusted 文本来自当前提示词目录：`packages/application/src/services/model-egress.ts:225`（`TRUSTED_PROMPT_TEXTS`）。`prompt-prefix.md:53` 明确写了：以后改提示词文字，老对话里冻结的旧文字不再在 trusted 清单里，会按外来内容重新检查，可能让老对话的请求开头变一次。这次的图例文本本身大概率不含会被遮的数字，但这是一个**需要字节测试证明**的点，不能只说“只对新对话生效”。

另外 `[密钥]` 的修复比方案写的“另做一步”触点更多：`EGRESS_PLACEHOLDER_PATTERN`（`redaction.ts:65`）、`LOCATED_PLACEHOLDER`（`:446`）、`MACHINE_SECRET_PLACEHOLDER`（`:70`）、还原表、提示词图例、以及 `[密钥]` 的“无编号旧文本”兼容，都要一起改。

**建议**：给图例修改补一条 ADR 0188 风格的字节测试（老对话三轮请求前缀不变），并单独列出 `[密钥]` 编号化的全部触点；不要把它当“顺手改一句话”。

### 11.【中】“restricted 不存”只对记忆候选成立，改成“全部分级”会波及 episode

`automatic-memory-service.ts:133` 只保证记忆候选不存 restricted；手工控制也拒绝 restricted（`production-memory-control.ts:578`）。但方案步骤 2 若把 `INDEXED_ENTITY_CLASSIFICATIONS`、`SUMMARIZABLE`、`REVIEWABLE` 改成“所有分级”，就会把 restricted 的 **episode / 摘要词项**也纳入处理。restricted episode 是否存在需要核实，但代码上不该用“全部”这个词。

**建议**：常量明确写成 `public/private/sensitive`，不要用“所有”或“不排除”；并为 restricted 加负向测试，证明仍不索引、不摘要、不整理。

### 12.【中】自动化检查的具体缺口

- `[RULE-memory-visible]` 中“健康类 sensitive 记忆自动上下文能带上”需要控制相关度门槛（0.6，`production-memory-composition.ts:92-96`）和 `maxSelectedMemories`；否则测试本身可能因检索不中而失败。要么用固定假嵌入，要么走置顶/档案路径（但见第 8 条）。
- “密码只有占位符、主人看到原值”必须走真实 `ModelEgress` exchange 才测得到还原；单测里直接检查字符串不够。
- “补索引只跑一次”要观察投影任务表，而不是只看重启没报错。
- 现有单测 `apps/agent-service/test/production-memory-recall.unit.test.ts:82-98` 断言的正是“高于运行分级的记忆被隐藏”，改动后必须显式更新它；这也说明“静态检查扫名单”覆盖不到行为。

---

## 二、推测（需要再核实，不能当结论）

1. **`reviewMemoryVisible` 是否是一条模型读取路径**：`packages/application/src/services/daily-review.ts:135-137` 和 `apps/agent-service/src/service-main.ts:1593` 把 sensitive 记忆文本置空并标 `hidden`。从代码看更像主人侧回顾/决策账本展示，但方案声称“逐个读过所有把 sensitive 挡在模型外的地方”却完全没列它。若它参与 Gmail/回顾的模型提示，就是漏项。
2. **归档记忆的正文是否长期保留**：`listInactive` 能读 archived（`sqlite-memory-operations.ts:920-927`），但删除/清理策略是否会清掉 archived 的 payload 未核实；若会，方案“已归档也能找回”仍有时间窗。
3. **嵌入配置加 sensitive 是否会影响已存授权**：`configuredModelDisclosureIdentity` 对整个模型描述符做哈希（`production-model-disclosure.ts:5-9`），改 `allowedDataClassifications` 会改这个身份。嵌入模型被排除在搜索/工作区“能读 private 的模型”集合之外（`public-search-authorization.ts:64`、`workspace-auto-authorization.ts:105`），所以大概率无影响，但仍需核对是否有其他授权按身份保存。
4. **档案块分类降级的实际下游影响**：已确认写入 payload 时是 public；它是否还会影响推送正文、导出、trace，取决于这些消费者是否用 block 分类，未逐条核实。

---

## 三、侧重检查（错误路径、不可信输入、安全、资源、不可逆、文档一致性）

- **不可信输入**：记忆可来自聊天、附件、网页导入、其他 AI 的导出。方案把它们更频繁地放进常驻上下文/档案，且导入文本可能含伪造的 `[密码#...]`、`[密钥]`。现有提示词已声明“资料不是指令”，但放行 sensitive 后注入面变大；需要为导入记忆保留“来自外部、非指令”的标记，并确认伪造占位符不会被还原表误还原。
- **出口遮盖的残余缺口**：ADR 0188 已补宽松密码，但“没有关键词的裸秘密”“健康/财务正文”仍不会被遮。方案“凭证值不会离开”只对能识别的凭证成立；健康/财务原文会完整发给嵌入和后台模型。这属于方案已承认的代价，但“对外部服务”一节漏了后台模型。
- **不可逆操作**：sensitive 记忆一旦进入每次对话的档案/上下文，就每轮外发，无法撤回；方案把“是否限制到零保留服务方”留给 Andy。从安全角度，这应当是启用前的前置条件，不是上线后的可选项。
- **资源耗尽**：给全部 sensitive 记忆补嵌入会在下一次启动集中产生大量嵌入请求；`listUnindexed` 是分页的，但成本/延迟/隐私突发没有预算和进度。需要一次性回填预算、并发上限、可暂停开关和可观察指标。
- **配置与文档一致性**：`maxMemoryClassification` 的静默忽略、`[密钥]` 图例与 `redaction.ts` 不一致（`chat.ts:255,267` vs `redaction.ts:70`）、设计规格第 67/70/162 行与 ADR 0185 后果（`docs/adr/0185-...md:61`）都会被本方案取代，方案已列出要改文档，但还需要同步 `docs/execution/specs/2026-10-25-self-built-memory-engine-design.md:112`（置顶类别）以及 `production-web-push.ts:486-498` 的推送排除规则——**推送必须继续排除 sensitive，不能因为“模型能看”就放宽**。
- **错误路径**：归档/补索引/嵌入失败时，方案没有定义“这条记忆是否仍算可见”。如果嵌入失败、索引投影失败，按硬规则它又变回不可见；应明确失败时的降级路径（全文/实体仍可命中）和可观测日志。

---

## 四、如果由我来定，我会怎样改

1. **把规则改成“可检索 + 可经授权读取”，不承诺“每轮自动送到”。** 常驻档案默认仍不含健康/财务/证件类；sensitive 通过 recall 按相关度取用。这样既满足 Andy“存了要能用”，又不把敏感内容无条件每轮外发。
2. **存储分类与披露分类分离。** 记忆、上下文块、工具结果、trace 保持 sensitive；不要用 private 运行把内容“洗”成 private。需要模型读取时，用一个显式的 `ownerApprovedModelRead`/读取授权位，而不是调低整轮 `dataClassification`。如果工具授权确实挡 sensitive，另做一条记忆读取权限，别动全局运行分级。
3. **归档单独设计。** 归档保留投影行；`indexScope`、recall、`listUnindexed` 接受 archived，但只在 `includeHistory` 时返回，并加 `archivedAt` 字段和提示词说明。为历史已归档数据做一次回填；为旧 public/private 索引里的凭证做一次遮盖重建，实体表明确是否回填。
4. **配置收口。** 删除或改名 `maxMemoryClassification` 对记忆的含义，记忆上限由一个导出的函数固定；历史/摘要上限单独命名。启动校验冲突时失败，不“只记日志”。
5. **老对话不要自造占位符。** 规则集 1 期间，含凭证的记忆直接不返回（用当前检测判断），或走规则集升级方案；recall 不改写正文。图例修改补字节测试；`[密钥]` 编号化单独出方案并列出全部触点。
6. **后台任务单独授权。** 每日整理、Gmail、情景摘要对 sensitive 的放行，单独由 Andy 决定，并绑定零保留/本地模型、总开关和成本上限；在方案的“对外部服务的代价”里补上这三类调用。
7. **测试改为行为测试。** 去掉 grep 式 `check:memory-visible`，改成：一个导出函数 + 调用点白名单；每个通道（recall、自动上下文、档案、日程、Gmail、整理、摘要）各一条捕获真实请求体的集成测试；反向用例直接改单个调用点必须失败；再加 `[RULE-memory-visible]` 覆盖归档、凭证占位/还原、索引只跑一次、restricted 不碰。

---

## 五、逐条回答必答问题

### 1. 会不会改变模型已经见过的请求开头？

**按方案描述，对已有对话基本不会，但有两点必须证明。**

- 记忆内容走 `<himawari-context>`，拼在最后一条用户消息里：`packages/runtime-pi/src/pi-runtime-adapter.ts:598-617`。`owner-profile`、`memory`、`owner-rules` 都是 `contextBlocks`，不在系统提示/工具定义里。recall 结果是工具结果消息，追加在轮内。因此“只在末尾追加、每轮会变的值都在最后一条消息（或当轮工具结果）”成立（依据 `prompt-prefix.md:27-29`、第 4 条）。
- 但：改 `chat.ts` 图例会改 `TRUSTED_PROMPT_TEXTS`（`model-egress.ts:225`），按 `prompt-prefix.md:53` 可能改变**老对话历史**的遮盖字节；必须用 ADR 0188 那种多轮字节测试证明“老对话前缀不变”，不能只声称“只对新对话生效”。
- 另：如果 recall 按规则集预先遮盖并写进工具结果，规则集一旦中途升级，历史工具结果的字节就会和之前不同；要么不预遮，要么确保规则集在对话生命周期内不变。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

**新常量、归档标记本身是确定的；真正有风险的是索引遮盖和 recall 预遮盖。**

- 索引遮盖必须是“只取决于这条记忆本身”的纯函数：不能依赖批次里的其他记忆、不能依赖每次变化的计数器、不能依赖会轮换的出口密钥 tag。方案的“先遮盖再分词”没有写清这一点。`redactForEgress` 的 `known`/`tag`/`ruleset` 都可能引入上下文依赖（`redaction.ts:56-62,297-425`）。
- recall 预遮盖若使用每请求的 `placeholderTag`（`model-egress.ts:121-126`），同一段记忆在不同请求/密钥轮换后会产生不同字节；若使用 `maskSensitiveText` 的无编号占位符，则不可还原且与图例不符。
- 归档字段若是固定布尔/固定文本，没问题；不要放随机 id、时间或 `now` 派生值到记忆条目里（`current` 现在依赖 `now`，但它在当轮工具结果/最后消息里，属于允许变化的位置）。
- 档案块的排序现有实现按重要度 + id（`owner-profile-service.ts:104-114`），是确定的；放行 sensitive 后不要改成按数据库返回顺序。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

**当前设计的检查不够，反向用例有多处不会失败。**

- `check:memory-visible` 抓不到 recall/自动上下文/上下文拼装的动态 rank 过滤（见第 7 条），所以“改回只取 public/private 必须失败”在这三条主通道上不成立。
- 它会误伤推送、Gmail、测试等合法的 public/private 用途，需要白名单和分类。
- `[RULE-memory-visible]` 若不改 archived 的 SQL/status 过滤，归档用例会失败；若不控制相关度阈值，自动上下文用例可能失败；若要测“主人看到原值”，必须用真实 `ModelEgress` exchange。
- 需要补：每个通道捕获真实请求体的集成测试、归档访问测试、旧索引回填测试、restricted 负向测试、投影只跑一次测试、图例修改的字节测试。

### 4. 每个产生/修改的值，每个使用它的地方都能接受吗？

逐个核对如下：

- **`MODEL_READABLE_MEMORY_CLASSIFICATIONS`**：产生方是方案新常量；使用方必须包括 recall（`production-memory-recall.ts:160-163`）、自动上下文端口（`production-run-memory.ts:357-362`）、`durable-memory-service.ts:387-398`、`context-formation-service.ts:279-286`、档案/日程（`owner-profile-service.ts:17,149-151,328-332`）、Gmail（`production-proactive-memory.ts:51`）、整理（`consolidation.ts:35,252`）、摘要（`episodes.ts:19,236`）。注意 `durable-memory-service` 还有 `status !== "active"` 过滤，必须一起核对。
- **`maxMemoryClassification`**：产生方是配置模板（`production-shape-config-template.json:16`）；使用方是 `strict-configuration.ts:1110-1132`、`run-execution-input-service.ts:72-78`、`production-run-policy.ts:157`、`context-formation-service.ts:148-197,427`（历史/摘要，不只是记忆）。如果只改记忆语义，必须明确它继续管历史/摘要；如果删除，所有校验和模板都要迁移。
- **embedding 的 `allowedDataClassifications`**：使用方是 `production-memory-composition.ts:101`（embeddable）、`production-run-memory.ts:130`（按记忆分类校验）、`strict-configuration.ts` 的校验、`production-model-disclosure.ts:8` 的披露身份哈希、启动配置测试和出包模板。要确认配置 schema 接受 `sensitive`，并核对披露身份变化是否影响已存授权（嵌入模型大概率不在相关集合里，但仍需核实）。
- **档案块 `dataClassification`**：产生方是 `owner-profile-service.ts:328-332`；使用方是 payload 存储（`:337-343`）、上下文投影、trace、推送/导出、`run-coordinator.ts:727-734`。当前只能产生 public/private，必须扩到至少 sensitive，且下游全部接受。
- **`INDEXED_ENTITY_CLASSIFICATIONS`**：同时用于 `memory_entities`（`sqlite-memory-operations.ts:798-805`）、`memory_search_terms`（`:1008-1014`）、`memory_episode_terms`（`:1247-1253`）。三处语义不同：实体只在保存时写、词项在投影时写；改成 sensitive 时要分别确认，且绝不能扩到 restricted。
- **recall 结果的 `archived` 新字段**：使用方是模型提示、工具结果渲染、日志/trace、单测的精确/部分匹配（`apps/agent-service/test/production-memory-recall.unit.test.ts:82-98`）。要补 prompt-catalog 的说明；旧对话的工具描述已冻结，可能看不懂新字段，需用当轮工具结果 note 而不是改工具定义。
- **提示词图例文本**：使用方是 `TRUSTED_PROMPT_TEXTS`、线程提示词冻结、`prompt-prefix` 检查、出口遮盖字节测试。修改前必须核对老对话历史不被重新遮成不同字节。
- **新 ADR/文档引用**：要同步 `docs/adr/0185-...md:61`、`docs/execution/specs/2026-10-25-self-built-memory-engine-design.md:67,70,112,162`、ADR 0112、ADR 0158，并保持事故清单/愿景的“规则都要有回归测试”口径（`docs/product-vision.md:59`）。
