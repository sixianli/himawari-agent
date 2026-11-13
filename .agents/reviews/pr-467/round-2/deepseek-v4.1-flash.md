## 侧重检查

- **错误路径**：查了 recall 参数校验、`requestedTimeScope` 历法校验、`#ownerScoped` 失败映射、MCP `find_memories` 的转发路径。确认非法日期会抛 `MEMORY_RECALL_INPUT_INVALID`，但模型看到的说明是“记忆暂时查不到”，见下文。
- **不可信/不合规输入**：查了网页传的 `contentRefs`、`topic`、导入文件里的类别/敏感标记、`memory.classify.read` 的 500 条上限。`topic` 有枚举校验；受保护内容的 payload store 是按 owner/agent 取的，跨用户读不到。
- **安全与敏感级别**：查了“已敏感内容是否进模型”“只升不降”“网页复用 ref 是否可能把敏感内容存成 private”。正常网页路径不会降级；但进程内记录有明确的边界。
- **资源耗尽**：查了分类分批、500 条上限、每日费用上限。单次 classify 最多可触发约 500 次模型调用，只有每日费用兜底，没有单请求硬上限。
- **不可撤销操作**：查了导入提交、导入撤销、敏感副本。导入中途失败会留下已建批次/部分记忆（这是既有行为）；敏感副本会成为不再被引用的内容（ADR 已写明）。
- **规则/文档一致性**：ADR 0260 与代码大体一致；ADR 0262 的“只用模型填的 includeHistory”与代码不一致；夏令时没有测试覆盖。

---

## 一、读代码证实的问题

### 1. 中：历法校验失败时，模型看到的是“记忆查不到”，无法据此改日期

- 文件:行：`apps/agent-service/src/production-runtime-tools.ts:641-649`，`packages/prompt-catalog/src/tools.ts:180-187`，`production-runtime-tools.ts:730-737`
- 问题：`requestedTimeScope` 对 `2026-02-30`、`from > to` 抛错后，`#recall` 转成 `MEMORY_RECALL_INPUT_INVALID`；但失败映射只把 `errorCode` 放进结果，说明文字仍是 `TOOL_RESULT_RECALL_UNAVAILABLE.text`。模型虽然能看到 `{"error":"MEMORY_RECALL_INPUT_INVALID",...}`，但同一结果又告诉它“记忆暂时查不到。不要编造，告诉主人现在查不了记忆”，等于阻止它改正日期后重试。
- 证据：
  ```ts
  // production-runtime-tools.ts:642-648
  const errorCode =
    error instanceof Error && error.message === "MEMORY_RECALL_INPUT_INVALID"
      ? "MEMORY_RECALL_INPUT_INVALID"
      : "MEMORY_RECALL_UNAVAILABLE";
  return { errorCode, note: TOOL_RESULT_RECALL_UNAVAILABLE.text };
  ```
  ```ts
  // tools.ts:186
  text: "记忆暂时查不到。不要编造，告诉主人现在查不了记忆。",
  ```
- 建议：为 `MEMORY_RECALL_INPUT_INVALID` 增加单独的 tool-result 说明，例如“from/to 必须是真实存在的 YYYY-MM-DD，且 from 不能晚于 to，请改正后重试”；不要复用“记忆不可用”。MCP `find_memories` 也应给出同样的可纠正错误（目前 `production-mcp-read.ts:1130-1156` 直接抛，未见专门映射）。

### 2. 中低：`includeHistory` 在有日期时被强制为 true，和作者/ADR 的“只用模型填的值”不一致

- 文件:行：`packages/memory-engine/src/time-scope.ts:64-73`，`packages/prompt-catalog/src/tools.ts:36`
- 问题：只要模型给了 `from` 或 `to`，`requestedTimeScope` 就返回 `includeHistory: true`，完全不看模型填的 `includeHistory`（包括显式 `false`）。作者说法是“recall 只用模型填的 from/to/includeHistory”，ADR 0262 决定 1 也写“只用模型填的……”，但代码实际是“有日期就自动带上历史”。这不是新引入的语义（旧代码对显式日期也强制 true），但本轮说明与代码不一致；对“问现在但给了日期”的请求，可能把已失效的旧记忆带进来。
- 证据：
  ```ts
  // time-scope.ts:69-72
  return Object.freeze({
    includeHistory: true,
    from: ...,
    to: ...,
  });
  ```
- 建议：二选一：要么尊重 `input.includeHistory`，要么在工具说明和 ADR 里明确写成“只要填了日期就包含历史”，并让评测 fixture 里那些带日期的 `includeHistory` 值有意义。

### 3. 中低：`topic` 变成 `memory.create` / `memory.import.commit` 的必填字段，旧客户端/已打开的旧页面会被契约拒绝

- 文件:行：`packages/gateway-contracts/src/contracts-v2.ts:1759-1767`、`1789-1795`，`packages/gateway-contracts/src/validation.ts:178-184`
- 问题：契约把 `topic` 写成 `nullable(...)`，但对象校验要求字段必须存在；旧版网页（或部署时浏览器里缓存着旧 JS 的页面）不发送 `topic`，会得到 `$.payload.topic: missing required field`，手动添加/导入直接失败。仓库内两端都改了，但这属于版本偏差问题，不是数据校验问题。
- 证据：
  ```ts
  // contracts-v2.ts:1761-1766
  contentRef: machineString,
  category: enumeration(MEMORY_CATEGORY_NAMES),
  subCategory: nullable(memoryLabelSchema),
  topic: nullable(enumeration(MEMORY_SENSITIVE_TOPICS)),
  pinned: booleanValue,
  ```
  ```ts
  // validation.ts:179-180
  for (const key of expectedKeys) {
    if (!Object.hasOwn(record, key)) fail(`${path}.${key}`, "missing required field");
  ```
- 建议：将 `topic` 设为可选（缺省按 `null`），或在发布说明里明确要求 web/server 同时更新并刷新旧页面。

### 4. 低：Himawari 导出的敏感记忆重新导入时丢失 `sensitiveTopic`

- 文件:行：`apps/control-center/src/memory-import.ts:145-156`，`apps/control-center/src/memory.ts:311-319`，`packages/persistence-sqlite/src/data-export/export.ts:263`
- 问题：导出文件本身有 `sensitiveTopic`，但 `parseMemoryExport` 固定写 `topic: null`；导入提交时回退到类别或 `"other"`。例如导出时主题是 `finance`/`beliefs`、类别是 `other` 的敏感记忆，重新导入后主题变成 `other`。敏感级别不降，但主题语义丢失。
- 证据：
  ```ts
  // memory-import.ts:149
  topic: null,
  ```
  ```ts
  // export.ts:263
  sensitiveTopic: optionalString(row["sensitive_topic"]),
  ```
- 建议：`parseMemoryExport` 读取并校验 `entry.sensitiveTopic`，合法时作为候选的 `topic` 传给导入；不合法再回退。

### 5. 低：分类查询可能一次触发大量模型调用，只有每日费用上限兜底

- 文件:行：`packages/gateway-contracts/src/contracts-v2.ts:1313-1326`，`apps/agent-service/src/production-memory-classification.ts:169-188`，`apps/control-center/src/gateway-client.ts:503-515`
- 问题：单次 `memory.classify.read` 最多 500 个 ref；每条文本最多 64 KiB；分类器按字符数 6000 分批。理论上一次请求可产生接近 500 次模型调用和很大的输入量。网页导入路径通常每条只有 500 字，实际约几十次调用，但直接调用 API（持 owner 会话）可以触发极端情况；每日费用上限只能限制花费，不能限制请求时长/调用次数。
- 证据：
  ```ts
  // contracts-v2.ts:1324-1325
  if (refs.length < 1 || refs.length > MEMORY_CLASSIFY_MAXIMUM)
    throw new ContractValidationError(path, "must hold 1 to 500 refs");
  ```
  ```ts
  // production-memory-classification.ts:174-181（按字符数切批）
  if (current.length > 0 && size + length > this.#options.batchCharacters) { ... }
  ```
- 建议：在 classify 查询上加总字符/总批次上限，或按请求设置 deadline；超限的条目直接按 `UNCLASSIFIED`（敏感）返回。

### 6. 低：已高于 private 的条目虽然不发给模型，但仍被解密读取

- 文件:行：`apps/agent-service/src/production-memory-control.ts:1014-1019`、`235-243`
- 问题：`#classify` 先无条件 `readText(ref)`，再判断 payload 级别；对于本来就不该送模型的敏感/受限内容，仍会走一次解密。功能上安全，但多做无谓工作；如果解密失败，整个 classify 查询失败，而不是直接返回“敏感”。
- 证据：
  ```ts
  const payload = await this.options.payloads.get(ref);
  const text = await this.readText(ref);
  if (payload && classificationRank(payload.dataClassification) > classificationRank("private"))
    results[index] = DETERMINISTIC_SENSITIVE;
  else pending.push({ index, text });
  ```
- 建议：先判断级别，只有要送模型的分支才调用 `readText`。

### 7. 低：评测反向用例的比较对象不完全对等，存在偶发通过/失败风险

- 文件:行：`test/integration/memory-evaluation.test.ts:659-667`
- 问题：`unscoped` 固定用 `HASH_DIMENSIONS`，而 `results.at(-1)` 在真实向量齐全时可能是 1024 维真实向量；两者不是同一 embedding 模式，`time_window` 的 `0.3` 阈值和 `history` 的严格小于可能受模式差异影响。它能抓住“重新引入正则兜底”，但不是一个干净的 A/B 对照。
- 证据：
  ```ts
  const unscoped = await evaluatePhaseTwo(HASH_DIMENSIONS, null, () => undefined);
  ...
  expect(unscoped.engine["time_window"]?.recallAt5 ?? 0).toBeLessThan(
    (results.at(-1)?.engine["time_window"]?.recallAt5 ?? 0) - 0.3,
  );
  ```
- 建议：用与 `results.at(-1)` 相同的维度/向量模式跑无 scope 对照，或直接对固定数据做“有无 scope 的同一 provider 比较”。

---

## 二、推测 / 未核实

### 1. 中低：当地午夜因夏令时不存在时，整天起点会偏一小时（按算法推导，未实机验证）

- 文件:行：`packages/memory-engine/src/time-scope.ts:6-49`、`69-73`
- 问题：`startOfLocalDay` 用“先按 UTC 午夜估一次 offset，再用该 offset 回算”的两遍法。对于切换发生在当地 00:00 的时区（例如 America/Santiago、America/Havana、Asia/Beirut 一类），本地 00:00 不存在：第一次 offset 取切换前、第二次取切换后，结果会落在前一天 23:00 而不是当天首刻。以 Santiago 2026-09-06 为例，推导结果是 `from` 比当地日首早 1 小时，单日窗口会包含前一天 23:00–24:00。普通 2:00/3:00 切换的时区（America/New_York、Europe/London 等）按推导是正确的。
- 证据：
  ```ts
  function startOfLocalDay(utcMidnight: number, timeZone: string): number {
    return utcMidnight - offsetMs(utcMidnight - offsetMs(utcMidnight, timeZone), timeZone);
  }
  ```
- 未核实点：没有在真实时区数据库上运行验证；仓库里的 `time-scope.unit.test.ts` 只测了 `Asia/Tokyo` 和 `UTC`，没有任何夏令时用例。
- 建议：要么加针对午夜切换时区的用例并改为“找到本地日期等于目标日期的第一个瞬间”（可枚举 00:00 前后的候选、用 `Intl` 校验本地日期），要么改用可靠的时区库/`Temporal`。同时给 `localDayStart` 也补同样的 DST 用例。

### 2. 低：进程内敏感判断记录目前不会跨用户/跨内容串用，但 key 本身不含 owner

- 文件:行：`apps/agent-service/src/production-memory-control.ts:229`、`1026-1035`、`1095`；`apps/agent-service/src/production-http-composition.ts:1055`、`1071-1073`、`1133`
- 结论（读代码）：当前不会串用。`ProductionMemoryControl` 在组合时绑定固定的 `configuration.ownerId/agentId`，`payloads` 是 `repository.payloadStore(ownerId, agentId)`；payload ref 由 `authenticationRef + idempotencyKey` 哈希生成，同一个 ref 不会被另一个用户或另一段文字复用。跨内容也不会，因为网页缓存 key 是 `level + "\0" + text`。
- 残余风险（推测）：`#sensitiveJudgments` 的 key 只有 `contentRef`，不含 owner。当前安全完全依赖“一个 control 实例只服务一个 owner”这个构造约定；若以后把该实例复用到多 owner，或把 payload store 换成全局存储，就会变成跨用户串用。另外服务重启后记录清空（ADR 0260 已写明），之后才保存的条目只靠网页 topic、类别和确定性检测。
- 建议：至少在注释/类型上把“per-owner 实例”写死；更稳妥的是 key 用 `ownerId\0contentRef`，或把 map 放到 owner 作用域内。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。改动只在两处接触“发给模型的内容”：`TOOL_RECALL` 和 `MCP_TOOL_FIND_MEMORIES` 的说明文字。recall 只有说明文字变了（工具名和参数结构未变），按 `prompt-prefix.md` 第 43 行只对新对话生效；老对话冻结旧文字。`find_memories` 是外部 MCP 工具，不在 Himawari 会话的冻结前缀里。分类提示是后台调用，固定文字在前、本次数据在后，没有进入会话历史。每轮会变的 `window`、召回结果、`now` 都在工具结果/最后消息里，没有塞进系统提示或工具定义。**依据：** `prompt-prefix.md#rules` 第 6、15 条；`production-memory-recall.ts:286-299`；`prompt-catalog/src/tools.ts:36`。

2. **同一段文字会不会在不同请求里变成不同字节？**
   不会因为这次改动引入上下文相关的遮盖、时间字段或无序集合。分类提示中的 items 按输入顺序生成，JSON 键固定；检索的时间范围只来自模型参数或固定 fixture；工具说明是静态文字。**但有一个存储层的不确定性**：`#sensitiveJudgments` 是进程内状态，同一段文字在“刚分类过”和“服务重启后”保存，可能得到不同的敏感级别（ADR 0260 后果已承认）。这不直接改变模型请求的字节，但会改变存储结果。

3. **有没有对应的自动检查，反向用例会真的失败吗？**
   有，且多数是真正的反向用例：
   - `packages/memory-engine/test/time-scope.unit.test.ts`：不存在的日期、`from > to`、无日期不猜窗口；删掉校验会失败。
   - `apps/agent-service/test/production-memory-recall.unit.test.ts`：查询文字里的“昨天/以前”不再产生 scope；恢复 `parseTimeScope` 会失败。
   - `test/integration/memory-engine-index.test.ts`：无 scope 的“我以前……”不返回被替换的旧记忆；恢复兜底会失败。
   - `test/integration/memory-evaluation.test.ts`：无模型 scope 时 `time_window`/`history` 必须变差；恢复兜底会失败（但见上文第 7 条的模式不对等问题）。
   - 分类：`production-memory-capture.test.ts` 覆盖“已敏感内容不进提示词”“模型判敏感但网页没报也能升级”“确定性检测/类别升级”；网页测试覆盖“分类中不能勾选/导入”“复用已有 ref 不多存”。
   缺口：没有夏令时/午夜切换时区用例；没有跨 owner 的敏感记录隔离用例；没有“旧客户端不传 topic”的兼容用例；“导出的 sensitiveTopic 重新导入”也没有用例。

4. **每个新值两端都能接受吗？**
   - `memory.classify.read.contentRefs`：网页按 500 条一批发，契约限制 1–500，服务端按 owner 的 payload store 读取，能对上。
   - `memory.classify.snapshot.items[].topic`：服务端只返回 `SENSITIVE_MEMORY_TOPICS` 里的值或 null，契约枚举一致，网页 `topicFor`/导入都接受。
   - `memory.create.payload.topic` / `memory.import.commit.items[].topic`：仓库内网页、测试、服务端都改了；但契约里是**必填**字段，旧客户端会失败（见第 3 条）。
   - 导出导入：`parseMemoryExport` 把 `topic` 固定为 null，服务端能接受，但会丢失导出文件里的 `sensitiveTopic`（见第 4 条）。
   - `requestedTimeScope.from/to`：返回完整 ISO 时间，`fusion.ts` 和 episode SQL 都按 ISO/时间戳比较，格式能接受；没有发现两端格式不一致。
   - `MEMORY_RECALL_INPUT_INVALID`：runtime-tools 能识别并回传 errorCode，但配套 note 不对（见第 1 条）。
   - `model-time-scopes.json`：按 `question.id` 消费，fixture 的 `timeZone`/`now` 字段实际未被测试使用（测试固定 `TIME_ZONE`），目前两边都是 Asia/Tokyo，不报错，但属于冗余且容易漂移的字段。
