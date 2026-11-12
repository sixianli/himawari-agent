# PR 455 第 2 轮复核结论

核对范围：`1338704..74c6457` 全量改动，重点看 `9d499a3..74c6457` 增量。仓库只读，未运行测试。

## 一、读代码证实的问题（按严重度）

### 1. 中：提议入口同步抛错会绕过超时与 catch，和「抛错都不影响这次检查」不符

- 文件：`packages/application/src/services/proactive-mail-check-service.ts:1816`
- 问题：`this.#options.observations.receive(observations)` 在 `Promise.race([...])` 的数组求值阶段就被调用。如果实现是同步 `throw`（而不是返回 rejected Promise），异常会在进入 `.catch` 之前抛出，直接逃出 `#finish`。此时 `store.record` 已经提交，检查却按失败处理，`onDecision` 也不会被调用。
- 证据：

```ts
1816:      await Promise.race([
1817:        this.#options.observations.receive(observations),
1818:        new Promise<void>((resolve) => {
1819:          timer = setTimeout(resolve, this.#options.limits.perCheckMs);
1820:        }),
1821:      ])
1822:        .catch(() => undefined)
1823:        .finally(() => clearTimeout(timer));
```

新增的反向用例只覆盖了 `Promise.reject` 和永不 resolve 两种异步路径，没有覆盖同步 `throw`。
- 建议：改为 `Promise.resolve().then(() => this.#options.observations.receive(observations))` 或整段包 `try/catch`，并补一条同步抛错的反向用例。

### 2. 中：新配置允许 `perCheck` 到 10,000，但存储层把 `sourceIds`/`observations.handedOff` 限死在 500；真正用到时整次检查会被丢弃

- 文件：
  - `packages/application/src/ports/proactive-sources.ts:80`
  - `packages/persistence-sqlite/src/sqlite-proactive-operations.ts:62,828,856`
- 问题：登记表允许把 `perCheck` 配到 `maximum: 10_000`，设置命令和 `proactive.sources.read` 也照此展示；但 `record` 校验仍用 `MAX_INPUT_IDS = 500`。一个按 `perCheck` 返回超过 500 条的 reader，会让 `sourceIds` 或 `observations.handedOff` 超限，`record` 整体报 `Proactive check inputs are invalid`，本轮所有 processed/insights 都写不进去，cursor 也不前进。这正是 I-73 说的「产出的值能通过产生端，却过不了使用端校验」。
- 证据：

```ts
// proactive-sources.ts
82:    perCheck: Object.freeze({ defaultLimit: 500, minimum: 1, maximum: 10_000 }),

// sqlite-proactive-operations.ts
62: const MAX_INPUT_IDS = 500;
828:      !ids(inputs?.sourceIds, MAX_INPUT_IDS) ||
856:      (inputs.observations !== undefined &&
857:        (!Number.isSafeInteger(inputs.observations.handedOff) ||
859:          inputs.observations.handedOff > MAX_INPUT_IDS ||
```

生产 Gmail reader 目前 `MESSAGE_LIMIT = 300`，所以今天不会触发；但本 PR 新注册的 reader 来源或以后提高 Gmail 上限就会触发。测试里没有 `perCheck > 500` 且实际判超过 500 条的用例。
- 建议：让 `MAX_INPUT_IDS` 与 `perCheck.maximum` 对齐，或把 `perCheck.maximum` 降到存储能接受的上限；至少补一条 >500 条的边界用例。

### 3. 低：程序写入入口不校验 `dueAt`/`deliverAt`，畸形值会抛错而不是返回 `entry_invalid`

- 文件：`packages/application/src/services/proactive-source-runtime.ts:183,262`
- 问题：`summary`/`reason`/`link` 都有长度校验，但 `dueAt`/`deliverAt` 没有时间格式校验。`deliverAt` 直接按字符串比较，畸形字符串可能被当作合法未来时间；`dueAt` 非法时最终在 `store.record` 的 `this.time(insight.dueAt)` 抛 `PORT_INVALID_OPERATION`，调用方拿到异常而不是 `{kind:"not_recorded", reason:"entry_invalid"}`。
- 证据：

```ts
183:  const wanted = entry.deliverAt !== null && entry.deliverAt > now ? entry.deliverAt : now;
...
262:          dueAt: entry.dueAt,
```

- 建议：在入口用与存储一致的 `Date.parse` + `toISOString` 校验，非法直接返回 `entry_invalid`；比较用解析后的毫秒值。

### 4. 低：`onlyIfNew` 的每日上限和「今天」起点是事务外快照，并发改配置时可多写一条

- 文件：`packages/application/src/services/proactive-source-runtime.ts:272-276` 与 `packages/persistence-sqlite/src/sqlite-proactive-operations.ts:916`
- 问题：`guard.perDay` 和 `guard.since` 在进入 `store.record` 事务前算好。若另一请求在此期间把 `perDay` 调低，或正好跨过当地零点，事务内仍按旧值和旧起点判断，最多可多记一条。对「上限」语义来说是边界漏洞，不是主流程错误。
- 证据：

```ts
272:      onlyIfNew: {
273:        source: entry.source,
274:        since: startOfZonedDay(now, options.timeZone),
275:        perDay: sourceSettings?.perDay ?? null,
276:      },
```

- 建议：`onlyIfNew` 只传 `source`，在事务内重新读取当前 `perDay` 并计算 `since`；或至少把设置读取放进同一事务。

## 二、推测 / 未核实

- 未运行 `check:proactive-sources` 及任何测试；下面关于「反向用例会不会失败」的判断来自读断言和代码路径，不是实测。
- 未在真实升级库上执行 0097 迁移；只读了 SQL 和迁移契约测试，未复现生产迁移。
- `.agents/reviews` 下的 brief/judgments 读取被工具规则拒绝，只能依据题面提供的作者说法核对。

## 三、侧重检查

查过下面这些路径，结论如下：

- **错误路径 / 同步异常**：发现第 1 条同步抛错逃逸。超时和异步 rejection 路径确实被 `.catch` 吞掉，检查继续返回 `decision`。
- **不可信 / 不规范输入**：`source` 名称在登记表、gateway、DB、导出/导入四端都有限制；`changeId` 长度 1–100、生产 id 实际约 51 字符、ledger id ≤109 <128，能通过。程序入口的 `dueAt`/`deliverAt` 未校验（第 3 条）。
- **安全**：`sqlite-decision-ledger-operations.ts`、`sqlite-observation-operations.ts` 用 `'${GMAIL_SOURCE.name}'` 拼 SQL。当前是冻结常量 `"gmail"`，没有实际注入；但若以后这里换成可配置来源名，就是注入点。建议直接参数化或继续用字面量。
- **资源耗尽**：`perCheck` 上限 10,000 与存储 500 的错配（第 2 条）；提议入口最多再等一个完整 `perCheckMs`，会把一次 tick 的总时长推到接近 2×`perCheckMs`，生产当前没有传 `observations`，暂不生效。
- **不可撤销操作**：`clear_records` 仍忽略 `source`、删除全部来源记录，但设计文档 `docs/execution/specs/2026-10-29-proactive-loop-v1-gmail-design.md:302` 明写「删除全部记录」，作者说法与文档一致；现在先做登记检查，未登记来源不能触发。多来源下用任一来源名都会清掉其他来源，建议至少保持文档/UI 明确说「全部来源」。
- **规则与文档一致性**：`prompt-prefix.md` 要求的「固定在前、会变的在后」没有被本次改动破坏；`proactivePrompt` 仍是固定指令 → 摘要/记忆 → 邮件 → 当前时间。`check:proactive-sources` 已加入 `check:steps`，`ci/operations-pending.json` 和 `SUPPORTED_SCHEMA_MAX=97` 也同步更新。

## 四、必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。`proactivePrompt` 仍是固定 `MAIL_JUDGMENT.text` 在最前，`renderPrompt(MAIL_JUDGMENT_NOW, ...)` 在最后（`proactive-mail-check-service.ts:468-495`）。本轮新增的 `sourceId`/`observedAt`/等待逻辑在 `store.record` 之后（`1796-1824`），不进入 prompt；`mailItem`/`mailOf` 是字段可逆的转换，`gmailItem` 只是把 `"gmail"` 换成同一个常量。发给模型的内容仍然只在末尾追加，每轮变化的值仍在最后。唯一保留意见：新 golden 文件是本 PR 里新增的，本身不能证明「和改动前逐字节相同」，但逐段 diff 未发现 prompt 文字或顺序变化。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   不会。新增的 `generatedAt`、`resetsAt`、`observedAt` 都不进入模型输入；`observations` 顺序由 `input.insights` 决定，是确定的；遮盖、related 排序、mail 序列化都没有改。`proactivePrompt` 的 `now`/时区仍只出现在末尾。

3. **有没有对应的自动检查，反向用例真的会失败吗？**
   有：`check:proactive-sources` 已加入 `check:steps`，覆盖登记表校验、DB 未登记拒绝、上限范围、事务回滚、同一 entry 并发、每日上限、超时/拒绝、文本长度、未登记来源的 `clear_records`。按代码路径推断，去掉对应修复后这些用例会失败。缺口：同步 `throw` 没有反向用例；>500 条检查的存储上限没有用例；`dedupKey`→`item.id` 和 `sourceId`→`groupKey` 对当前 Gmail/测试来源取值相同，没有能区分回退的测试。测试本身未运行，属未核实。

4. **改动产生/修改的每个值，两端都接受吗？**
   - `source` 名称：登记表 `^[a-z][a-z0-9_]{0,63}$`、gateway 同名 pattern、DB `length 1-64 + GLOB`、导出 schema、import 登记检查，一致。
   - `changeId`：上限 100，生产 `ids.next` 约 51 字符，ledger id 最长 109，DB id 限 128，能过。
   - `limit_change` 的 key/subjectRef：`proactive.source.<name>.<perDay|perCheck>` 最长约 93，小于 256，能过。
   - `observations.sink`：`not_connected`/`port` 两端一致。
   - `proactive.sources.snapshot` 字段与 gateway schema 一致，`perCheck` 确实没有 `used`/`resetsAt`。
   - **不一致**：`perCheck` 最大 10,000 对存储层 `MAX_INPUT_IDS=500`（第 2 条）；`observations.handedOff` 也复用 500 上限。
   - **边界**：`onlyIfNew.perDay`/`since` 是事务外快照（第 4 条）；`dueAt`/`deliverAt` 未校验（第 3 条）。
   - 作者说法 6 的「2000 个字符」实际是 JS `.length`，按 UTF-16 代码单元计，补充平面字符会算 2；严格说不是 Unicode 字符数。
