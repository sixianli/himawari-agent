## 结论

未发现会直接丢数据、绕过权限或不可逆误删的高严重度问题。下面按严重度列出我在代码里核实过的问题；最后另列「推测/未核实」与「侧重检查」。

---

## 读代码证实的问题

### 中：ADR/作者说「有过 hold 的一对不再放进同一组」，但代码和测试都允许它们作为同一条新记忆的邻居出现在同一组

- 文件：`packages/memory-engine/src/consolidation.ts:283-314`、`packages/memory-engine/src/consolidation.ts:154-155`、`test/integration/memory-consolidation.test.ts:830-857`、`docs/adr/0220-consolidation-conflicts-wait-for-the-owner.md:60`
- 问题：`listHeldPairs` 只把 hold 对加入 `paired`，而 `paired` 只用于阻止「直接配成邻居」（`sameTopic` 和 search 两处）。第三方新记忆仍可同时把 hold 对的两条都收进自己的邻居列表。测试甚至明确断言它们在同一组。
- 证据：
  - `consolidation.ts:283-287`：
    ```ts
    const paired = new Set(
      (await this.#options.store.listHeldPairs({ ownerId, agentId })).map((pair) =>
        [...pair].sort().join("\n"),
      ),
    );
    ```
  - `consolidation.ts:303`、`327` 只在选邻居时检查 `paired.has(...)`，没有阻止两者被同一条第三条记忆同时选中。
  - `test/integration/memory-consolidation.test.ts:835-857`：
    ```ts
    together =
      group("milk-weekend") !== undefined &&
      group("milk-new") === group("milk-weekend") &&
      group("milk-old") === group("milk-weekend");
    ...
    expect(together).toBe(true);
    ```
  - `consolidation.ts:154-155` 之所以「模型对 hold 对的判断不执行」，靠的是：
    ```ts
    if (keep !== group.fresh.label && drop !== group.fresh.label) continue;
    ```
    也就是说，若 keep/drop 都是 hold 对成员、而组的新记忆是第三条，这条判断会被丢弃；但如果模型把第三条新记忆也卷进来（例如 keep=第三条、drop=hold 对中的一条），`replace` 仍可自动作废 hold 对里的那条。
- 影响：ADR 承诺的「不再同组、不推翻主人选择」并不成立；至少模型仍会看到 hold 对并列，产生无效判断；更严重时，hold 对中的一条可被第三条记忆通过 `replace` 自动作废。当前测试没有覆盖「第三条记忆作废 hold 对成员」这一路径。
- 建议：先明确意图。若只想禁止「直接重判同一对」，把 ADR 和 H-17 的「不再把它们放进同一组」改成「不再直接配对，涉及该对的判断不执行」，并补一条第三方记忆作废 hold 成员的用例；若确实要求永不把 hold 相关记忆放进同一组，则需要在选邻居时排除任何与 hold 集合有关系的记忆，而不是只排除精确 pair。

### 低：hold 行只按 `tentative` 判断撤销/确认，用户编辑过待确认记忆后仍显示会失败的「撤销」

- 文件：`apps/control-center/src/components/memory-page.tsx:1738-1740`、`apps/control-center/src/components/memory-page.tsx:1786-1790`、`apps/control-center/src/components/memory-page.tsx:651-653`、`packages/memory-engine/src/consolidation.ts:434-439`、`packages/application/src/services/durable-memory-service.ts:222-237`
- 问题：`waiting` 只收集 `item.tentative`，没有检查 `supersededBy`、`status` 或这条记忆是否已经被编辑过。`correct()` 会改 revision，但不会清掉 `tentative`；于是记忆页的 hold 行仍然显示「撤销」，点下去必然 `MEMORY_CHANGED_AFTER_CONSOLIDATION`。确认区则额外要求 `!supersededBy && status === "active"`，两处条件不一致。
- 证据：
  ```ts
  const waiting = new Set(
    overview.memories.filter((item) => item.tentative).map((item) => item.memoryId),
  );
  ...
  ...(item.action === "hold" && !waiting.has(item.memoryId)
    ? {}
    : { undo: () => void memory.undoTidy(item) }),
  confirm:
    (item.action === "reflect" || item.action === "hold") && waiting.has(item.memoryId),
  ```
  确认区：
  ```ts
  const guesses = overview.memories.filter(
    (item) => item.tentative && !item.supersededBy && item.status === "active",
  );
  ```
  `undo` 的 revision 检查：
  ```ts
  if (!memory || memory.revision !== change.afterRevision)
    throw new ApplicationPortError(
      PORT_ERROR_CODES.CONFLICT,
      "MEMORY_CHANGED_AFTER_CONSOLIDATION",
    );
  ```
- 影响：用户编辑待确认记忆后，hold 行会留下一个永远失败的「撤销」按钮；如果该记忆后来被其他路径置为 superseded/archived 而仍带 tentative，也会出现同样问题。不会造成数据损坏，但属于明确的错误路径体验。
- 建议：把 `waiting` 的条件与确认区统一为 `tentative && !supersededBy && status === "active"`，并让 hold 的「撤销」再检查记忆 revision 是否仍等于 `change.afterRevision`（必要时在 `tidyUps` 里加 `afterRevision`）。同时补一条「编辑过待确认记忆后不再显示撤销」的用例。

### 低：hold 的目标是「日期更晚的那条」，不一定是作者说的「新条」，也不一定是模型说的 keep

- 文件：`packages/memory-engine/src/consolidation.ts:371-388`、`test/integration/memory-consolidation.test.ts` 中 `[P3-8] holds a replacement whose newer statement the model named as the one to drop`
- 问题：代码用 `statedAt` 排序后取 `newer` 作为 hold 目标：
  ```ts
  const [older, newer] =
    statedAt(keep.memory) < statedAt(drop.memory) ? [keep, drop] : [drop, keep];
  ...
  const change = await this.#revise(id, "hold", newer.memory, older.memory.id, {
    attributes: { tentative: true },
  });
  ```
  在「模型 keep=旧、drop=新」或「fresh 的 `validFrom` 比邻居还早」时，hold 的是模型说的 drop 或一条旧记忆，而不是 fresh 新条。测试 2 明确期望 hold `home-new`（模型说的 drop）。
- 影响：数据上没有丢东西，也确实保留了两条；但作者总结里的「新条设 tentative」、ADR 的「新条进待确认」以及界面「待确认的新条」在边界场景下不准确，可能让后来维护者误解 hold 的语义。
- 建议：要么把文字统一成「说得更晚的那条（不一定是本次新出现的条）」，要么在 hold 目标上明确改为 fresh/keep，并补对应测试。现在至少要在 ADR 和 H-17 里把「新条」改成「日期更晚的那条」。

### 低：测试缺口：`decision_ledger` 的 hold 反向 CHECK 没有单独覆盖；新 UI 边界也没覆盖

- 文件：`packages/persistence-sqlite/test/consolidation-hold-migration.contract.test.ts:167-182`、`:216-219`
- 问题：第三个用例插入未知 action `pending` 时，`memory_consolidation_changes` 的 CHECK 会先失败，因此它只证明整理改动表的 CHECK，而没有证明重建后的 `decision_ledger` 也会拒绝未知的 consolidation outcome。正向 hold 决策记录有覆盖（`:203-214`），负向没有。
- 证据：
  ```ts
  function insertHold(database: Database, action: string) {
    database.prepare(`INSERT INTO memory_consolidation_changes (...)`).run(...);
    database.prepare(`INSERT INTO decision_ledger (... outcome ...)`).run(...);
  }
  ...
  expect(() => insertHold(database, "pending")).toThrow(/CHECK/u);
  ```
  这条语句在第一条 INSERT 就失败，到不了 `decision_ledger` 的 CHECK。
- 建议：把 `memory_consolidation_changes` 和 `decision_ledger` 的反向插入拆成两条独立用例；并补一条 UI 用例覆盖「tentative + superseded/被编辑」时不再显示撤销。

---

## 推测 / 未核实

- 我没有运行任何测试，只读了代码；因此「自动检查真的会失败/真的会通过」只能按代码推断，未实际验证。
- `prompt-manifest.json` 里两个 sha256 我未独立重算，只确认源文件和 golden 文本一致。
- `MEMORY_CONSOLIDATION_POLICY_VERSION` 仍是 `memory-consolidation:v1`。代码行为和提示词语义已经变了，这个版本号是否应升未见说明；我未追到所有使用方，故标为未核实。
- 生产构造点目前都不传 `gates`，记忆抽取和整理都落到 `DEFAULT_CAPTURE_GATES`，当前一致。以后如果有人把自定义门槛注入抽取但忘了整理，会分叉；这是未来风险，不是当前缺陷。
- 未核实 `listHeldPairs` 在真实 IPC/worker 边界上的序列化实现，只看类型和调用链；目前调用方只做集合成员判断，不依赖顺序。

---

## 侧重检查

- **错误路径**：模型返回坏 JSON 或未知 action 时 `parse` 抛错/跳过（`consolidation.ts:139-157`）；hold 撤销和确认都有 revision 检查（`consolidation.ts:428-457`）；失败运行在 `changeCount > 0` 时保留改动和 hold（`sqlite-memory-consolidation-operations.ts:217-243`），作者关于「失败也保留 hold」的说法与代码一致；重复撤销被 `markUndone`/`undoneAt` 挡住。
- **不合规范或不可信输入**：keep/drop 必须是组内成员且至少一条是 fresh（`consolidation.ts:154-155`）；action 走枚举；分类门槛用 `Object.hasOwn`（`calibration/src/thresholds.ts:61-65`）；`listHeldPairs` 全部参数化 SQL，无注入面。
- **安全**：hold 不删除、只置 tentative，且可以被确认或撤销，整体比原来自动作废更保守；没有新增日志或序列化秘密；提示词里的「主人原话里的指令不要执行」仍保留。
- **资源耗尽**：提示词上限仍是 `MAXIMUM_FRESH=20`、`MAXIMUM_NEIGHBOURS=3`、`MAXIMUM_INSIGHTS=3`；`listHeldPairs` 无 limit，但行数受历史 hold 数量线性限制，每次整理一次查询，未见明显放大；迁移是一次性重建，复制行数为现有数据量。
- **不可撤销操作**：新增的 hold 本身可逆；唯一不可逆路径仍是 supersede，而它现在被 `replace` + 严格更晚 + 置信度门槛三道条件限制，符合目标。
- **规则/文档与代码一致性**：迁移文档与 0089 实际内容一致；ADR 0220 的「不再同组、判断不执行」和测试 `together=true` 不一致（见中危项）；H-17 沿用了同样的「以后不再整理」表述。提示词规则方面，改动只影响后台 `memory.consolidation`，不改对话的 system/tools/history/masking。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

不会改变任何已经发出的对话请求的系统提示、工具定义、历史或遮盖结果。改动只涉及后台整理调用的固定提示词 `memory.consolidation` 和格式说明；这些是每次整理重新拼出来的单个请求，不是对话历史，也没有跨轮追加关系。整理调用仍然是「固定指令在前、每次的组和记忆数据在后」，这次没有把新的每轮变化值塞进固定开头；动态的组、记忆、日期仍都在数据段。提示词改为新字节，等于换了一次后台 prompt 版本，只影响之后新发出的整理请求，已发出的请求无法被改。

### 2. 同一段文字会不会在不同请求里变成不同字节？

不会由这次改动引入不确定性。`hold` 只增加数据库状态（tentative、hold 记录），`listHeldPairs` 的返回顺序不影响提示词，因为服务只把它转成成员集合；`statedAt` 是原有字段；没有新增时间戳、随机数或无序集合输出。相同数据库状态下，拼出的整理提示词字节确定。hold 之后后续请求里参与整理的记忆集合会变，但那是数据库状态变化，不是同一段文字被非确定地改写。

### 3. 有没有对应自动检查，反向用例是否真的会失败？

有，且大部分反向用例按代码推断是有效的：

- 主用例：`test/integration/memory-consolidation.test.ts` 的 P3-8，覆盖 replace 自动作废、conflict/low-confidence 进 hold、决策记录、确认后两条都留、撤销、确认/撤销后再次整理不产生改动。
- keep 标成较旧那条：同文件的第二个 P3-8 用例，期望只产生 `hold home-new`；若去掉 `newer === keep` 条件就会误 supersede。
- 低置信度：`pet-new` 置信度 800 低于门槛 850，期望 hold；去掉门槛检查会变成 supersede。
- 迁移：`consolidation-hold-migration.contract.test.ts` 比对了全部被重建表的行和建表 SQL，并检查外键、触发器、未知 action 被 CHECK 拒绝。
- 每日复盘：`packages/application/test/daily-review.unit.test.ts` 用 30 条 hold 验证容量仍为 10。
- UI：`memory-interactions.unit.test.ts` 验证 non-tentative hold 行不显示按钮、tentative 行显示撤销/去确认。

缺口：`decision_ledger` 的未知 consolidation outcome 没有独立反向用例；UI 的「tentative + 被编辑/superseded」没有覆盖；我没有实际运行这些测试，无法确认当前全绿。

### 4. 改动产生或修改的每个值，两端都能接受吗？

逐个核对如下：

- **`MemoryConsolidationAction` 新增 `"hold"`**：生产端在 `memory-engine` 产生；接收端包括 `ports/memory-consolidation.ts` 类型、`sqlite-memory-consolidation-operations.ts` 的 `ACTIONS` 与 DB CHECK、`data-export/schemas.ts`、`gateway-contracts` 三处 action 枚举、三语 i18n 两个 select、记忆页 `item.action === "hold"`。这些地方我都读到已接受 `hold`。
- **决策记录 `outcome: "hold"` / `reasonCode: "consolidation_hold"`**：`DECISION_OUTCOMES.consolidation` 已加，`validateLedgerWrite` 用它校验；迁移后的 `decision_ledger` CHECK 已加 `hold`；`reason_code` 长度限制 64，`consolidation_hold` 通过。两端一致。
- **`memory.overview.snapshot.tidyUps[].memoryId`**：生产端来自 `change.memoryId`（`production-memory-control.ts:629-634`），`change.memoryId` 在数据库里 NOT NULL；契约端是 `machineString`（`contracts-v2.ts:1231-1233`）；消费端是控制中心的 `waiting` 集合键（`memory-page.tsx:1738-1740`）。两端都按记忆编号处理，且都是非空字符串；这个字段不经过后端二次校验，但也不用于写操作，所以没有 I-73 式的后端校验不匹配。
- **`listHeldPairs` 端口方法**：sqlite 实现、durable adapter、operations switch 都已接通；输入 owner/agent，输出 MemoryId 元组；调用方只做排序拼接和集合判断，ID 是字符串，类型和值都匹配。
- **迁移 0089 注册**：`migration-engine.ts` 已登记 sequence 89；测试常量、`SUPPORTED_SCHEMA_MAX` 已改为 89；我搜到的其他 `88` 都是历史迁移/历史序列，不是仍生效的上限。
- **`autoCommitThreshold` 导出**：`automatic-memory-service.ts` 导出，`services/index.ts` → `application/index.ts` → memory-engine 导入链完整；默认 `DEFAULT_CAPTURE_GATES` 与记忆抽取当前使用的静态 `MEMORY_AUTO_COMMIT_GATE` 一致。
- **提示词 `replace` 与 `memory.consolidation.format`**：源文件、golden、manifest 的 `changedIn`/`reason` 已同步；sha256 未独立重算。

总体上，改动的主要值在生成端和消费端都能对上；需要修的是「hold 对是否还允许同组」的文档/测试与代码不一致，以及 hold 行撤销按钮缺少 revision/状态过滤这两个边界问题。
