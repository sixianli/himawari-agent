## 作者说法核对（先给结论）

| 作者说法 | 核对结果 |
| --- | --- |
| recall 和 MCP `find_memories` 在日期不存在或先后颠倒时回新说明 | **基本成立**。runtime 确实把 `MEMORY_RECALL_INPUT_INVALID` 映射成新提示；MCP 也确实返回这句 note。但 MCP 这条路径被记成了“成功读取”，见发现 2。 |
| 整天起点改为取目标当地日期的最早时刻 | **有反例**。普通时区、午夜切换和半小时时区大体对；正 UTC 偏移、凌晨 01:00 回拨夏令时的时区仍会晚一小时，见发现 1。 |
| 网页从 Himawari 导出文件导入时保留合法 `sensitiveTopic` | **代码成立，前提未核实**。解析器确实保留合法 topic，但测试用的是手写的 `sensitive: true` 形状；当前仓库的真实 data-export schema 用的是 `classification`，旧 `himawari-memories.json` 的格式不在仓库里。 |
| 分类时级别已高于 private 的内容不再解密 | **成立**。`readText`（内部会 `unprotect`）只在低级分支调用。 |
| 检索评测反向检查改为同一向量模式对比 | **成立**。`scoped` 和 `unscoped` 都用 `HASH_DIMENSIONS` + term-hash。 |
| ADR 0260、0262 文字同步 | **大体同步，有两处偏差**：ADR 0262 的“第一个时刻”有反例；ADR 0260 决定 1 没有明确写“高分级不解密”。 |

---

## 发现（按严重度）

### 1. 中：凌晨 01:00 回拨夏令时的时区，整天起点仍会晚一小时

**证据性质：算法逻辑读代码证实；具体时区结果属推测，建议用 tzdb 验证。**

文件：`packages/memory-engine/src/time-scope.ts:56`

```ts
56: function startOfLocalDay(utcMidnight: number, timeZone: string): number {
57:   const before = utcMidnight - offsetMs(utcMidnight, timeZone);
58:   const after = utcMidnight - offsetMs(before, timeZone);
59:   const day = new Date(utcMidnight).toISOString().slice(0, 10);
60:   const onTheDay = [before, after].filter((instant) => localDate(instant, timeZone) === day);
61:   return onTheDay.length > 0 ? Math.min(...onTheDay) : after;
62: }
```

问题：算法只看两个候选。对于 **正 UTC 偏移、在当地 01:00 回拨一小时** 的时区（例如 `Asia/Gaza`、`Asia/Hebron`，UTC+3 → UTC+2）：

- 真正的当地日期第一刻是回拨前的 `00:00 +03`；
- 但 `utcMidnight` 已经落在回拨之后，`before = utcMidnight - 新偏移` 正好等于回拨瞬间；`offsetMs(before)` 又取到新偏移，于是 `before` 和 `after` 都是回拨后的 `00:00 +02`；
- 结果整天起点晚一小时。用 `from` 查这一天会漏掉 00:00–01:00；用 `to` 查前一天会把下一天 00:00–01:00 多算进来。

这不是只影响 recall：`localDayStart` 还被提醒时间计算使用，`apps/agent-service/src/production-memory-capture.ts:256` 的 `reminderSchedule` 也会受影响，凌晨的提醒会被整体推后一小时。

现有测试只覆盖了：

- `packages/memory-engine/test/time-scope.unit.test.ts:56-59`：Santiago 午夜切换、Beirut 春季午夜切换、New York 春季切换；
- 没有覆盖“正偏移 + 凌晨 01:00 回拨”这一类。

建议：不要只试两个候选。可以额外采样目标日期前后约 26 小时的偏移各算一个候选，再按 `localDate === day` 过滤取最小值；或者使用 `Temporal.PlainDate.toZonedDateTime({ disambiguation: "earlier" })` 一类有明确回拨语义的接口。补测试时至少加：

- `Asia/Gaza` / `Asia/Hebron` 的 01:00 回拨日；
- `America/Havana` 作为负偏移 01:00 回拨的对照（按现在算法应通过，用来证明新增测试真正区分问题）；
- `Asia/Kolkata`、`Australia/Lord_Howe` 的普通日和切换日；
- 同时测 `from` 在切换日、`to` 在切换前一天，确认不会漏算/多算第一小时。

---

### 2. 中：MCP 参数错误仍被记成一次成功的外部读取

**证据性质：读代码证实。**

文件：`apps/agent-service/src/production-mcp-read.ts:1170`

```ts
1170:     } catch (error) {
1171:       if (error instanceof Error && error.message === "MEMORY_RECALL_INPUT_INVALID")
1172:         return {
1173:           output: {
1174:             error: "MEMORY_RECALL_INPUT_INVALID",
1175:             note: TOOL_RESULT_RECALL_INPUT_INVALID.text,
1176:           },
1177:           memoryIds: [],
1178:         };
```

这会把 `memoryIds: []` 交给 `#call`；而 `#record` 用数组真值判断成功/失败：

```ts
1107:       outcome: "read",
1108:       reasonCode: memoryIds ? name : `${name}_failed`,
...
1111:         memoryIds: memoryIds ?? [],
```

空数组在 JavaScript 里是真值，所以 `reasonCode` 是 `find_memories`，不是 `find_memories_failed`。同时 `#call` 因为 `delivered` 被赋值，返回结果也不带 `isError`：

```ts
1088:     return delivered
1089:       ? { content: [{ type: "text", text: delivered.text }] }
1090:       : { content: [{ type: "text", text: MCP_TOOL_RESULT_FAILED.text }], isError: true };
```

影响：

- 参数错误的调用在 `external_read` 账本里和“查了但没结果”的正常读取无法区分；
- 不会触发 `onFailure`，失败监控看不到；
- 改之前这条错误会抛到 `#call`，被记成 `find_memories_failed` 并返回 `isError: true`；本次改动把账本语义从“失败”变成了“成功空结果”。

建议：给 `ToolOutcome` 增加明确的 `failed`/`reasonCode` 字段，或在无效参数时返回 `memoryIds: undefined`（相应放宽类型），让 `#record` 记成 `find_memories_failed`。同时补 `test/integration/mcp-read.test.ts` 用例，断言无效日期时：

- 返回内容包含新说明；
- 账本 `reasonCode` 是失败类而不是 `find_memories`；
- 是否 `isError` 按产品决定，但必须与账本一致。

---

### 3. 低：`requestedTimeScope` 的任何异常都被当成“参数错误”

**证据性质：读代码证实。**

文件：`apps/agent-service/src/production-memory-recall.ts:133`

```ts
133:     try {
134:       scope = requestedTimeScope(input, timeZone);
135:     } catch {
136:       throw new Error("MEMORY_RECALL_INPUT_INVALID");
137:     }
```

问题：`requestedTimeScope` 内部会调用 `Intl.DateTimeFormat`。如果配置里的 `timeZone` 无效，或 ICU 抛出其他错误，也会被包成 `MEMORY_RECALL_INPUT_INVALID`。模型随后收到“参数不对，改日期再查”，会反复改日期，而真正的问题是配置/环境错误；同时也不会走“记忆暂时查不到”的失败说明。

建议：只把日期校验错误映射为参数错误，例如：

```ts
catch (error) {
  if (error instanceof RangeError && error.message === "MEMORY_TIME_SCOPE_INVALID")
    throw new Error("MEMORY_RECALL_INPUT_INVALID");
  throw error;
}
```

或者让 `requestedTimeScope` 抛一个有明确类型的 `MEMORY_TIME_SCOPE_INVALID` 错误，调用方只识别这一种。

---

### 4. 低：新说明只讲日期，但同一个错误码还覆盖其他参数错误

**证据性质：读代码证实。**

`argumentsOf` 在以下情况都抛 `MEMORY_RECALL_INPUT_INVALID`：

`apps/agent-service/src/production-memory-recall.ts:70`

```ts
70:   if (
71:     query.length === 0 ||
72:     query.length > 500 ||
...
75:     (args["includeHistory"] !== undefined && typeof args["includeHistory"] !== "boolean") ||
76:     typeof limit !== "number" ||
...
80:     Object.keys(args).some(
81:       (name) => !["query", "from", "to", "includeHistory", "limit"].includes(name),
82:     )
83:   )
84:     throw new Error("MEMORY_RECALL_INPUT_INVALID");
```

而新提示只说：

`packages/prompt-catalog/src/tools.ts:198`

```ts
198:   text: "参数不对，没有查。from、to 要写日历上真实存在的日期（YYYY-MM-DD），from 不能晚于 to；改正后再查一次。",
```

如果模型是因为 `query` 为空、`limit` 越界或带了未知字段被拒，却收到“改 from/to”的建议，可能做无效重试。建议把说明改成覆盖所有参数问题，或把日期错误和通用参数错误拆成两个提示/错误码。

---

### 5. 低：MCP 路径和凌晨回拨缺少自动检查

**证据性质：读代码证实。**

- `test/integration/mcp-read.test.ts` 在 `e4df…5d44` 之间没有改动；现有失败用例只覆盖 `failRecall`：

  `test/integration/mcp-read.test.ts:840-850`

  ```ts
  840:   it("answers a failed read as a tool error and records it as failed", async () => {
  841:     const f = await setup({ failRecall: true });
  ...
  847:     expect(row).toMatchObject({ reasonCode: "find_memories_failed", outcome: "read" });
  ```

  没有覆盖 `MEMORY_RECALL_INPUT_INVALID`，所以发现 2 的账本回归不会被测试抓住。

- `includeHistory` 加到 MCP schema 和说明（`apps/agent-service/src/production-mcp-read.ts:501-507`）也没有集成测试验证它真的传到 recall。
- `packages/memory-engine/test/time-scope.unit.test.ts:52-60` 没有凌晨 01:00 回拨用例，发现 1 不会被抓住。
- 分类“不解密”的测试：

  `test/integration/production-memory-capture.test.ts:3356-3366`

  只断言高分级 ref 没有再产生模型调用（`classifyPrompts` 长度仍为 1），没有 spy `protector.unprotect`，所以“没有被解密”这一点没有直接门槛。代码读起来是对的，但如果以后有人仍调用 `readText` 然后丢弃结果，这条测试仍会通过。

建议补上述用例。尤其是 MCP 无效参数的账本断言和 01:00 回拨的 `localDayStart` 用例。

---

### 6. 低 / 未核实：给 `memory.create`、`memory.import.commit` 增加的是必填的 `topic` 键

**证据性质：读代码证实仓库内两端；外部客户端未核实。**

`packages/gateway-contracts/src/contracts-v2.ts:1762`

```ts
1762:     contentRef: machineString,
1763:     category: enumeration(MEMORY_CATEGORY_NAMES),
1764:     subCategory: nullable(memoryLabelSchema),
1765:     topic: nullable(enumeration(MEMORY_SENSITIVE_TOPICS)),
```

`packages/gateway-contracts/src/contracts-v2.ts:1791`

```ts
1791:     contentRef: machineString,
1792:     category: enumeration(MEMORY_CATEGORY_NAMES),
1793:     subCategory: nullable(memoryLabelSchema),
1794:     topic: nullable(enumeration(MEMORY_SENSITIVE_TOPICS)),
```

`nullable` 只是允许值为 `null`，不表示键可以省略；`object` 实现要求所有键都存在：

`packages/gateway-contracts/src/validation.ts:179`

```ts
178:       const result: Record<string, unknown> = {};
179:       for (const key of expectedKeys) {
180:         if (!Object.hasOwn(record, key)) fail(`${path}.${key}`, "missing required field");
```

仓库内网页生产方都补了 `topic`（`apps/control-center/src/memory.ts:296`、`:316-319`），契约 fixture 也补了。但任何还按旧契约发送、不带 `topic` 的客户端（例如仓库外的 iPhone 端或旧网页版本）都会直接收到 `missing required field`。这正是 I-73 那类“只看改动本身，没核对所有产生处”的风险。

建议：如果外部客户端不能保证同时升级，把 `topic` 做成“可缺省、缺省当 null”的可选键（需要扩展校验辅助函数），或者在发布说明里明确这是破坏性契约变更并核对所有客户端。

---

### 7. 低：文档与代码有两处不一致

**证据性质：读代码证实文档文字；行为影响见发现 1、分类实现。**

- `docs/adr/0262-memory-time-scope-comes-from-the-model.md:50` 写“整天的起点取当地日期的第一个时刻”，但发现 1 的凌晨 01:00 回拨时区取不到第一个时刻。文档要么改弱为“普通时区和午夜切换时区”，要么等代码修正后再保留这句话。
- `docs/adr/0260-memory-classification-on-the-server.md:51` 写“服务端读出文字，逐条回答……受保护内容的级别已经高于 private 的条目直接按敏感回答，不发给模型”。代码现在对高分级条目连 `readText` 都不调用，即**不解密**；文档只说了“不发给模型”，没有写“不读取/不解密”。建议补上一句，避免以后有人按文档恢复解密。
- ADR 0262 前提 3 仍写 MCP `find_memories`“没有 includeHistory”，而决定 3 又加了它。作为“改前前提”可以理解，但最好写成“改前没有”，避免读者误以为现状如此。

---

## 侧重检查

- **错误路径**
  - recall 无效日期 → runtime 新说明：代码路径正确（`production-runtime-tools.ts:642-648`）。
  - 其它 recall 失败 → runtime 仍是 `TOOL_RESULT_RECALL_UNAVAILABLE`（“查不了记忆”），未被本次改动影响。
  - MCP 其它失败 → 仍是 `MCP_TOOL_RESULT_FAILED`（“这次没能从 Himawari 读到内容”），不是新说明；这条是改前就有的行为。
  - MCP 无效参数 → 返回新说明但账本记成功，见发现 2。
  - `requestedTimeScope` 的宽泛 catch，见发现 3。
- **不合规范/不可信输入**
  - MCP schema 只校验 `YYYY-MM-DD` 形状，`2026-02-30` 会进入 `calendarDay` 被拒；`from > to` 也被拒（`time-scope.ts:81`）。
  - 导入 JSON 只接受 `status === "active"`、类别白名单、topic 白名单；没有发现新的注入或越权路径。
  - `memory.classify.read` 的 `contentRefs` 上限 500，由契约校验（`contracts-v2.ts:1316-1322`）。
- **安全/隐私**
  - 高分级 payload 不再 `readText`/`unprotect`，代码确认；`#sensitiveJudgments` 只加不降，保存时只升不降。
  - `sensitiveTopic` 在 parser 和 gateway contract 两端都是同一组枚举；`packages/application/src/ports/automatic-memory.ts:117` 与 `MEMORY_SENSITIVE_TOPICS` 一致。
  - 未发现新增不可撤销操作。
- **资源耗尽**
  - 分类最多 500 条、按字数分批、每日额度、敏感判断缓存上限 5000；没有新增无界循环。500 条逐条 `payloads.get` + `readText` 的上限由契约控制，未发现新的无界增长。
- **规则文件与文档**
  - 请求开头只追加规则（`.claude/rules/prompt-prefix.md` 第 4、6、10、11 条）没有被本次增量破坏；文档偏差见发现 7。
- **未核实**
  - `Asia/Gaza`/`Asia/Hebron` 在 2026 年的具体时区规则（本容器里没有可读 tzdb；结论是按代码逻辑和已知规则推演）。
  - 旧 `himawari-memories.json` 的真实字段是 `sensitive` 还是 `classification`；当前 `packages/persistence-sqlite/src/data-export/schemas.ts:79-94` 的新导出格式用的是 `classification`。
  - 仓库外客户端是否都已带 `topic`。
  - 新提示词 manifest 的 sha256 是否与实际 `segments` 一致：未运行测试，但 `apps/agent-service/test/prompt-catalog.unit.test.ts:172-193` 会检查 stale hash。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**本次增量 5d44 不会。**

- `TOOL_RESULT_RECALL_INPUT_INVALID` 只被当作工具结果的文本使用：`production-runtime-tools.ts` 放进失败结果，`production-mcp-read.ts` 放进 MCP 工具返回。没有进入系统提示或工具定义。
- recall 的日期范围、检索结果、错误说明都是在工具结果里，也就是对话末尾追加的内容。每轮会变的值（时间范围、记忆列表、查询结果）仍然只在最后一条工具结果/用户消息里，不在系统提示或工具定义里。
- 同一对话的历史消息、遮盖结果没有被重写。

需要单独说明的是：整个 PR 从基准 `e4df…` 看，`7f60…` 改过 `TOOL_RECALL` 和 `MCP_TOOL_FIND_MEMORIES` 的文字，这是工具定义（请求最前面）。但按 `.claude/rules/prompt-prefix.md` 第 6 条，同一对话的工具定义按对话冻结，已发出的对话继续用旧字节；只有新对话会拿到新工具定义。这不是“已经见过的请求开头”变了。
- 第 11 条的固定文字清单因为新增提示词多了一条，但新文字没有出现在旧历史里，也没有敏感值，所以不会实际改变旧请求的遮盖字节。

### 2. 同一段文字会不会在不同请求里变成不同字节？

**本次改动没有引入这类问题。**

- 新说明是固定字符串；MCP 返回的 `{ error, note }` 和 runtime 的 `{ error, note }` 键顺序固定；没有时间、随机数、无序集合。
- `memory.classify.read` 的返回顺序跟随输入 `contentRefs` 的顺序；没有依赖对象遍历或数据库返回顺序。
- `requestedTimeScope` 对同一组日期、同一时区、同一 ICU/tzdb 是确定性的；它不是“同一段文字依赖前后文变成不同字节”的遮盖逻辑。
- 新增固定文字进入 trusted 清单，理论上会改变“历史里恰好出现这段新文字”时的遮盖判断，但这段文字是新加的、不含敏感内容，旧历史里不可能出现，实际无影响。

唯一的环境依赖是 `Intl.DateTimeFormat`/tzdb：同一部署内稳定，不同 Node/ICU 版本之间可能不同。这不是同一请求上下文内的非确定性。

### 3. 有没有自动检查，反向用例是否真的会失败？

**有一部分，但不完整。**

成立的部分：

- runtime 无效参数的新说明有单测：`apps/agent-service/test/production-runtime-tools.unit.test.ts:1497-1503`，反向断言了结果不含“查不了记忆”。如果错误码映射回旧说明，这条会失败。
- recall 日期非法/先后颠倒有单测：`apps/agent-service/test/production-memory-recall.unit.test.ts:416-423`。
- 新提示词进入 manifest，hash 不对时 `prompt-catalog.unit.test.ts:187` 会报 `PROMPT_MANIFEST_STALE`。
- 导入 topic：合法值保留、非法值变 null 有单测：`apps/control-center/test/memory-interactions.unit.test.ts:1940-1965`。
- 分类高分级不发给模型：`test/integration/production-memory-capture.test.ts:3356-3366` 的 `classifyPrompts` 长度断言会失败，如果高分级文本被送进模型；但它不检查是否调用过 `unprotect`。
- 检索评测反向检查是真的：`test/integration/memory-evaluation.test.ts:660-668` 用同一 `HASH_DIMENSIONS` 比较 `scoped` 和 `unscoped`；如果时间范围被忽略，`unscoped.time_window` 不会比 `scoped` 低 0.3，测试会失败。

不成立/缺口：

- MCP 无效参数的新说明和账本记录没有集成测试，所以发现 2 这种回归不会被 CI 抓住。
- MCP `includeHistory` 是否真的传到 recall 没有测试。
- 01:00 回拨的整天起点没有测试，发现 1 不会被抓住。
- 导入 topic 只有 parser 单测，没有“parser → importCommit → gateway 契约 → 服务端存 attributes”的端到端测试；而且测试用的导出形状与当前仓库真实 data-export schema 不一致（见发现 5/6 的相关说明）。

### 4. 每个新值/改动值，两端是否都能接受？

逐项核对结果：

- **`tool-result.recall-input-invalid`**
  - 产生：`packages/prompt-catalog/src/tools.ts:189-199`，并写入 `prompt-manifest.json`。
  - 使用：`production-runtime-tools.ts` 和 `production-mcp-read.ts`。
  - 两端校验：prompt catalog 的 manifest 测试检查 hash/reason；没有后端 schema 约束。未发现不匹配。
- **`MEMORY_RECALL_INPUT_INVALID`**
  - 产生：`production-memory-recall.ts` 的参数校验和日期校验。
  - 使用：runtime 映射为 `errorCode` + 新说明；MCP 映射为 `{ error, note }`。
  - 两端：runtime 的 `errorCode` 没有枚举约束；MCP 这里没有错误状态约束。MCP 账本语义不匹配，见发现 2。
- **MCP `includeHistory`**
  - 产生：MCP 输入 schema（`production-mcp-read.ts:501-507`）和 `recallArgs` 透传。
  - 使用：`argumentsOf.go` 接受 boolean；`requestedTimeScope` 在给了 from/to 时强制 `includeHistory: true`，只给 includeHistory 时按传入值。
  - 两端类型一致；缺测试。
- **`topic`（`memory.create` / `memory.import.commit`）**
  - 产生：网页 `memory.ts:296`、`:316-319`。
  - 契约：`contracts-v2.ts:1765`、`:1794`，nullable enum，和 `MEMORY_SENSITIVE_TOPICS` 一致。
  - 使用：`production-memory-control.ts:1134` 存入 `attributes.sensitiveTopic`。
  - 仓库内两端一致；但 `topic` 现在是必填键，外部旧客户端有破坏性风险（发现 6）。
- **`sensitiveTopic`（网页导入）**
  - 产生：旧 `himawari-memories.json`（格式不在仓库，未核实）。
  - 消费：`memory-import.ts:140-150` 按 `MEMORY_SENSITIVE_TOPICS` 白名单校验；`memory.ts:316-319` 透传；契约再校验一次 enum；服务端消费。
  - 两端校验一致；如果旧文件实际用 `classification` 而不是 `sensitive`，这条路径不会生效，且会按 private 导入（发现 5 的未核实项）。
- **`memory.classify.read` / `memory.classify.snapshot`**
  - 契约：`contracts-v2.ts:1316-1348` 定义查询和快照；`PRODUCTION_MEMORY_OPERATIONS` 加入 `memory.classify.read`。
  - 网页：`memory.ts:183-212` 分批最多 500，按 `contentRefs` 顺序匹配返回。
  - 两端字段、枚举、顺序一致；未发现不接受的地方。
- **`localDayStart`**
  - 产生：`time-scope.ts:64-67`。
  - 使用：`requestedTimeScope` 的 from/to，以及 `production-memory-capture.ts:256` 的提醒时间。
  - 两端类型一致；但发现 1 的时区问题会同时影响 recall 和提醒。
- **评测 fixture `MODEL_SCOPES.now` / `timeZone`**
  - 产生：`evals/memory-time-scope/result.json` 和脚本写出的 `model-time-scopes.json`。
  - 使用：`test/integration/memory-evaluation.test.ts:597` 断言与 dataset 一致；`:660-668` 用同一 hash 模式做反向比较。
  - 两端一致；反向检查有效。
- **`evals/memory-time-scope/result.json`**
  - 只是评测产物，没有测试消费；没有后端校验问题。
