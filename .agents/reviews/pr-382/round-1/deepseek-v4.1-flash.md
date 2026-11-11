## 结论摘要

未发现高严重度的功能性缺陷。这个改动对 Himawari 自己发给模型的请求没有影响；外部 `today_context` 的新字段确实只在响应末尾追加。主要问题集中在文档/规则与代码不一致、通用写入路径的校验可被绕过，以及两处低风险的可观测性/结构问题。作者声称的 `npm run check`、集成测试结果我无法运行，标为未核实。

---

## 一、读代码证实的

### 中：已批准的决策记录写入约定没有随代码更新

- 文件:行：`docs/execution/specs/2026-11-09-decision-record-write-convention.md:35`、`:45`、`:54`
- 问题：约定明确写“其他种类经 `append` 目前只落四个键，其余字段在入库前被丢掉”“summary 六项只由 `proactive` 写”，并且要求“要让这些种类也记下别的字段，先改 `insertLedgerRow` 和它的校验，再改这份约定”。本次改了代码，却没有改这份约定；它现在和代码、以及 ADR 0219 决定 7 直接矛盾。
- 证据：
  - 约定原文（第 35 行）：“目前只落 `memoryIds`、`ruleIds`、`batchId`、`resultMemoryIds` 四个键……其余字段在入库前被丢掉。”
  - 约定原文（第 45 行）：六项 summary 字段的“谁写”一栏是“`proactive`，只在 Gmail 检查接上了对话日摘要读取时写”。
  - 代码 `packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:112-116` 明确允许 `external_read` 带六项，`sqlite-decision-ledger-operations.ts:183-192` 也确实把它们写进 JSON：
    ```ts
    ...(write.inputs.summaryRead === undefined
      ? {}
      : {
          summaryInjected: write.inputs.summaryInjected,
          summaryIds: write.inputs.summaryIds,
          ...
        }),
    ```
- 建议：更新这份约定：说明 `external_read` 经 `append`/`insertLedgerRow` 可写 summary 六项、六项必须齐全，其他类别仍拒绝；同时补上读取端对 `external_read` 的显示预期（见下一条）。

### 低：ADR 0216 和范围测试仍宣称摘要读取“只接在 Gmail 检查上”

- 文件:行：`docs/adr/0216-gmail-check-reads-recent-day-summaries.md:57`；`apps/agent-service/test/proactive-summaries-scope.unit.test.ts:31`
- 问题：ADR 0216 决定 7 原文是“读摘要、补生成和摘要块只接在 Gmail 检查上”，测试标题是 “recent conversation summaries reach only the Gmail check”。本次改动让外部 MCP 的 `today_context` 也通过 `memoryEpisodes.recent` 读摘要，这句话已不成立。测试仍然通过，只是因为它只按 `listDaySummaries`、`createProactiveRecentSummaries`、`recentSummaries` 等特定标识符扫描，没有覆盖 `sources.summaries` 这条新路径。
- 证据：
  - ADR 0216:57：“**聊天路径不改。** 读摘要、补生成和摘要块只接在 Gmail 检查上。”
  - `apps/agent-service/src/service-main.ts:1789-1796`：外部 MCP 的 sources 里新增了 `memoryEpisodes.recent(...)`。
  - 测试 `proactive-summaries-scope.unit.test.ts:21-28` 只扫描固定标识符；`summaries` 这个新键不在任何一条断言里。
- 建议：在 ADR 0216 决定 7 后注明“ADR 0219 决定 7 另把只读摘要接到外部 MCP”，并把范围测试改名为“不进入聊天/后台提示路径”，同时显式允许外部 MCP 这一条路径，防止以后有人把摘要接进聊天却没人发现。

### 低：`insertLedgerRow` 的六项序列化只按字段存在判断，不按 kind 判断；直接调用者可绕过“别的类别拒绝”

- 文件:行：`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:183-192`；直接调用点 `packages/persistence-sqlite/src/sqlite-memory-consolidation-operations.ts:92`
- 问题：`validateLedgerWrite` 里的 `write.kind !== "external_read"` 拒绝只覆盖 `append`/`appendIfChanged`。`insertLedgerRow` 本身只要看到 `summaryRead !== undefined` 就写六项，不检查 kind；而 `sqlite-memory-consolidation-operations.ts` 是直接调用 `insertLedgerRow`、没有走 `validateLedgerWrite` 的。现在还没有调用方给 consolidation 传 summary 字段，所以是潜在问题，不是已发生的数据错误。
- 证据：
  - `insertLedgerRow` 的条件只有 `write.inputs.summaryRead === undefined ? {} : {...}`。
  - consolidation 直接调用：
    ```ts
    insertLedgerRow(database, {
      ...
      kind: "consolidation",
      ...
      inputs: { memoryIds: basis, ruleIds: [], batchId: ..., resultMemoryIds: ... },
    });
    ```
- 建议：把“只有 `external_read` 可以带六项”的判断下沉到 `insertLedgerRow`，或让所有直接调用点也走 `validateLedgerWrite`；否则 ADR 里“别的类别带这六项一律拒绝”只在 `append` 路径成立。

### 低：新增了 `sqlite-proactive-operations.ts` 与 `sqlite-decision-ledger-operations.ts` 的文件级循环依赖

- 文件:行：`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:23`、`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:25`
- 问题：原来只有 `sqlite-decision-ledger-operations.ts` 单向引用 `sqlite-proactive-operations.ts` 的 `defaultRuleParameters`；本次后者又反向引用前者的 `summaryInputsValid`，形成循环依赖。当前不会报错，因为两边都是在方法调用时才使用函数声明，但结构变脆；`check:boundaries` 只检查 workspace 包级循环，不检查文件级循环。
- 证据：
  - `sqlite-proactive-operations.ts:23`：`import { summaryInputsValid } from "./sqlite-decision-ledger-operations.ts";`
  - `sqlite-decision-ledger-operations.ts:25`：`import { defaultRuleParameters } from "./sqlite-proactive-operations.ts";`
- 建议：把 `summaryInputsValid`（以及可能的 `defaultRuleParameters`）移到独立的共享模块，消除文件级环。

### 低：可恢复的摘要读取失败会写入 `mcp-read.failed` 诊断，但工具整体是成功的

- 文件:行：`apps/agent-service/src/production-mcp-read.ts:351-353`；`apps/agent-service/src/service-main.ts:1810-1815`
- 问题：`#recentDays` 捕获摘要读取错误后调用 `this.#options.onFailure(error)`，而生产接线把这个回调固定写成 `event: "mcp-read.failed"`。因此即使提醒照常返回、工具成功，日志里仍会出现一条“mcp-read.failed”，可能造成误报或掩盖真正的整次读取失败。
- 证据：
  - `production-mcp-read.ts:351-353`：
    ```ts
    } catch (error) {
      this.#options.onFailure(error);
      return { output: { recentDays: [], recentDaysComplete: false }, read: SUMMARIES_FAILED };
    }
    ```
  - `service-main.ts:1810-1815`：
    ```ts
    onFailure: (error) =>
      writeServiceDiagnostic(errorOutput, {
        component: "agent-service",
        event: "mcp-read.failed",
        code: stableErrorCode(error),
      }),
    ```
- 建议：给可恢复降级用单独的事件（例如 `mcp-read.summaries-failed` / `mcp-read.degraded`），不要把已处理的摘要失败记成整次读取失败。

---

## 二、推测 / 未核实

1. **`prompt-manifest.json` 的新 sha256 未独立验证。**
   `packages/prompt-catalog/prompt-manifest.json:342-345` 把 `mcp.today-context` 的 hash 从 `cdaf...` 改成 `565f...`。测试 `apps/agent-service/test/prompt-catalog.unit.test.ts:172-173` 用 `sha256(JSON.stringify(entry.segments))` 校验；如果新 hash 不对，`npm run check` 的 `check:prompt-catalog` 会报 `PROMPT_MANIFEST_STALE`。我无法在只允许 git/read 的工具条件下计算 sha256，标为未核实。

2. **摘要读取没有 AbortSignal/截止时间。**
   `#todayContext` 调用 `#recentDays()` 时不传 signal（`production-mcp-read.ts:357-360`），`MemoryEpisodeService.recent` 的签名也没有 signal（`packages/memory-engine/src/episodes.ts:206-212`）。如果摘要存储或解密很慢，外部 `today_context` 可能被拖住。现有提醒读取也没有 signal，所以不是本次独有，但本次新增了最多 8 次 payload 读取。是否有生产实际风险取决于存储和解密延迟，属于推测。

3. **未接摘要源时响应里完全没有 `recentDays`，但工具说明总是承诺该字段。**
   `#recentDays` 在 `this.#options.sources.summaries` 不存在时直接返回 `{ output: {} }`（`production-mcp-read.ts:334-335`），而新工具说明写着会返回 `recentDays`（`packages/prompt-catalog/src/tools.ts:240`）。这是否可接受取决于是否存在“启用了 MCP 读取但没有 memory episodes”的生产配置；我没有核实这种配置是否存在。

---

## 三、侧重检查

- **错误路径**
  - 摘要源抛错：`#recentDays` 捕获，返回 `recentDays: []`、`recentDaysComplete: false`，提醒照常返回，决策记录 `summaryRead: "failed"`。读代码证实。
  - 部分摘要读不到：`MemoryEpisodeService.recent` 把 `partial` 设为 true；`#recentDays` 输出 `recentDaysComplete: false`，记录 `summaryRead: "partial"`。读代码证实，但集成测试未覆盖该分支。
  - 遮盖或写决策记录失败：`#call` 捕获后把 `delivered` 置空，返回工具错误、不交内容（`production-mcp-read.ts:249-271`）。读代码证实。
  - 提醒先抛错：摘要尚未读取就整次失败，但 `#record` 仍会写 `summaryRead: "failed"`（`production-mcp-read.ts:259-262`）。这会让“读取失败”和“从未尝试”在审计上无法区分，属于轻微语义问题，未单列为缺陷。
- **不合规范或不可信输入**
  - `today_context` 的 schema 是空对象且 `additionalProperties: false`，没有可注入参数。
  - 摘要来源是内部服务；源返回畸形数据导致的异常会被 `#recentDays` 捕获，不会把原始错误发给外部。
  - 决策记录的六项有 SQLite 端校验：重复编号、日期格式、负数、非整数、未知状态、只写一部分、`summaryInjected` 与空编号矛盾都拒绝（`sqlite-decision-ledger-operations.ts:44-80`）。
- **安全/隐私**
  - 摘要正文和 `recentDays` 的 day 都进入 `maskForExternalRead`，与提醒、日期等一起遮盖（`production-mcp-read.ts:117-126`、`:252`）。测试确认 `Maple-7712` 不出现。
  - 只取模型可见分级：生产接线传 `modelVisibleClassifications()`（`service-main.ts:1795`），`MemoryEpisodeService.recent` 内部还会再过滤一次 `isModelVisible`（`episodes.ts:213`），属于双重限制。
  - 被删除对话的 episode 行由治理删除路径删除（`packages/persistence-sqlite/src/sqlite-governed-deletion.ts:781`），因此不会通过摘要把已删除对话重新暴露出来。
  - 静态 MCP 令牌现在能读到对话摘要，是 ADR 0219 决定 7 明确授权的范围扩大，不是越权实现；没有新增密钥或放宽鉴权。
- **资源耗尽**
  - 最多 2 天、8 段；单段生成上限 1200 字；外部读取不调用模型、不生成摘要，成本为 0。读取没有信号取消，见“推测”第 2 条。
- **不可撤销的操作**
  - 没有写记忆、没有补生成、没有删除；只追加决策记录，属于可接受的审计写入。
- **规则文件、说明文档与代码一致性**
  - 已确认不一致：决策记录写入约定、ADR 0216 决定 7、ADR 0219 第 66/106 行的旧说法，以及范围测试的标题。详见上面“读代码证实的”。

---

## 四、必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**对 Himawari 自己发给模型的请求：不会。**

- `MCP_TOOL_TODAY_CONTEXT` 的引用只有 `packages/prompt-catalog/src/tools.ts` 和 `apps/agent-service/src/production-mcp-read.ts`；它只用于外部 MCP 服务器的工具说明，不进入聊天、Gmail 检查或其他 Himawari 模型请求。
- 摘要读取只发生在外部 `today_context` 响应和外部读取的决策记录里；`#todayContext` 把 `recent.output` 放在最后展开（`production-mcp-read.ts:361-374`）：
  ```ts
  ...(listed.more ? { more: true } : {}),
  ...recent.output,
  ```
  因此对外部响应而言，新字段也是在末尾追加。
- 提示词目录文本变化会改变 `TRUSTED_PROMPT_TEXTS`，但旧/新 `mcp.today-context` 文本都不在 Himawari 的模型请求里，所以不会改变已有请求的遮盖结果。
- 唯一变化是外部 MCP 客户端看到的工具说明变了；如果外部客户端自己也缓存模型提示，它的开头会变。这是新增字段必须付出的代价，不属于 Himawari 自己的请求前缀。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**对 Himawari 自己的模型请求：不会。**

**对外部 MCP 响应：**

- `recentDays` 的顺序是确定的：`listDaySummaries` 使用 `ORDER BY e.day DESC, e.ended_at DESC, e.id ASC`（`packages/persistence-sqlite/src/sqlite-memory-operations.ts:1536`），`summaryDays` 用 `Set` 保序（`production-mcp-read.ts:346`），不是无序集合。
- 同一段摘要正文的遮盖通常只取决于它自己和本次返回的其他文字。ADR 0219 第 70-71 行已明确：如果本次返回的另一段文字把同一个值点名为密码/验证码，这个值在整次响应里都会被遮掉；这是既有的“一次返回内记住点名值”行为，测试也明确覆盖“无论顺序”。它不是随“无关内容”随意变化。
- `now`、`today` 每次请求会变，这是既有行为；决策记录的 `id`/`decidedAt`/`durationMs` 本来就会变，且不进入模型请求。
- 所以没有发现新增的、会让 Himawari 提示前缀字节漂移的序列化问题。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

有对应测试，但有覆盖缺口。

- `test/integration/mcp-read.test.ts:346-382`：成功路径检查 `recentDays`、遮盖、ledger 六项；`:384-404`：摘要源抛错时不挡提醒、标记 `recentDaysComplete: false`、记录 `summaryRead: "failed"`。如果把实现改回“摘要失败就整次失败”，第一组断言 `isError` 会失败；如果不记录六项，ledger 断言会失败；如果不遮 `Maple-7712`，遮盖断言会失败。
- `test/integration/decision-ledger.test.ts:453-501`：正向写六项；反向用例 `no-read-state`、`injected-without-ids`、`bad-day`、`bad-state`、`not-external` 都会在 `summaryInputsValid` 或 kind 检查处被拒，测试用 `rejects.toThrow()`，不是空跑。读代码证实这些反向用例确实会失败。
- 缺口：
  - 没有覆盖“部分可读、部分读不到”的 `partial` 路径在 MCP 集成层的表现（`recentDaysComplete` 和 `summaryRead: "partial"`）。
  - 没有覆盖受限分级摘要在外部 MCP 层被排除。
  - 这两个新测试是 `test/integration`，不在 `package.json` 的 `check:steps` 里；`npm run check` 会跑的只是 `check:prompt-catalog` 等，作者另外跑了集成测试。作者声称的“check 48 步、persistence-sqlite 全部通过”我无法运行核实。

### 4. 改动产生或修改的每个值，每个使用它的地方都能接受吗？

逐个核对如下：

- **`recentDays` / `recentDaysComplete`**
  - 产生：`production-mcp-read.ts:341-343`。
  - 使用：外部 MCP 客户端和工具说明。没有后端 schema 校验；JSON 字段名和内容与说明一致。可接受。
  - 注意：未接摘要源时字段完全缺失，见“推测”第 3 条。
- **`summaryIds`**
  - 产生：`found.summaries.map(({ id }) => id)`（`production-mcp-read.ts:345`）。
  - 后端校验：`text(item, 1, 256)` 且唯一（`sqlite-decision-ledger-operations.ts:55-59`）。标准 episode id 是 `episode:${source}:${threadId}:${firstSequence}`（`packages/memory-engine/src/episodes.ts:385`），`ThreadId` 最长 128（`packages/domain/src/identifiers.ts:39`），即使 sequence 取最大安全整数也远小于 256；最多 8 个，远小于 `MAX_IDS=200`。可接受。
- **`summaryDays`**
  - 产生：`[...new Set(found.summaries.map(({day}) => day))]`（`production-mcp-read.ts:346`）。
  - 后端校验：最长 31、唯一、`/^\d{4}-\d{2}-\d{2}$/`（`sqlite-decision-ledger-operations.ts:72-73`）。episode 入库时 `DAY` 已校验为同一格式（`packages/persistence-sqlite/src/sqlite-memory-operations.ts:1296`、`:134`）。可接受。
- **`summaryCharacters`**
  - 产生：按段落累加 Unicode 码点（`production-mcp-read.ts:347`）。
  - 后端校验：安全非负整数（`sqlite-decision-ledger-operations.ts:60`、`:75`）。可接受。
- **`summaryRead`**
  - 产生：`ok` / `partial` / `failed`（`production-mcp-read.ts:348`、`:353`）。
  - 后端校验：`off`/`ok`/`partial`/`failed`（`sqlite-decision-ledger-operations.ts:42`、`:77-78`）。可接受。
- **`summaryInjected`**
  - 产生：`memoryIds !== undefined && summaries.ids.length > 0`（`production-mcp-read.ts:296`）。
  - 后端校验：`summaryInjected === (summaryIds.length > 0)`（`sqlite-decision-ledger-operations.ts:74`，按 JS 优先级实际是后者，代码正确）。可接受。
- **`summaryGenerated`**
  - 固定 0（`production-mcp-read.ts:301`），后端只要求安全非负整数。可接受。
- **读取端**
  - `entryFromRow` 已为旧记录补默认值，并会读出这六项（`sqlite-decision-ledger-operations.ts:291-296`）。
  - `production-decision-chain.ts:156-170` 只在 `kind === "proactive"` 时构造 `mails`，所以 `external_read` 的摘要字段不会显示在依据抽屉的邮件区；这不算拒绝，但意味着写进 ledger 的六项对 `external_read` 目前在 UI 上不可见。若期望在依据抽屉显示，需要另改读取端。
  - 数据导出 schema 对 `decisions.inputs` 只要求 `{ type: "object" }`（`packages/persistence-sqlite/src/data-export/schemas.ts:208`），能接受新增字段。
- **例外**
  - `insertLedgerRow` 被 consolidation 直接调用时没有走 `validateLedgerWrite`，见上面“低”问题。当前调用方不传六项，所以不会实际出错，但“别的类别一律拒绝”的说法在那一层不成立。
- **未核实**
  - `prompt-manifest.json` 的 hash 是否正确，我无法计算验证。
