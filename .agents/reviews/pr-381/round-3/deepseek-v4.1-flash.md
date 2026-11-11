# PR 381 第 3 轮复核（0829c5e7 vs 432fe4b8 / 78e2289b）

> 说明：本轮只读了代码、文档和测试，没有运行测试。涉及“某反向用例会不会失败”的结论都是按测试断言推演，已标注。`.agents/reviews/pr-381/round-2/*` 在当前工作区不可读（记录目录被拒绝），第 2 轮判断未独立核实。

## 结论概览

- 作者的大多数说法与代码一致：补算多取候选、`whileHeld` 收紧 `NOT_AUTHORITATIVE`、MCP 取消信号、出包/上线前的新校验、Gemma 前缀拆分、ADR 文字都能在代码里对上。
- 但有两处实质问题：**补算的“失败满 3 条就停”会退回“坏条目挡住后面所有好条目”**；**`leaseLost` 的清理路径仍可能把真正的执行权错误换成一个不在集合里的错误**。
- 出包校验与服务启动校验仍不等价（I-73 类型）：重复分类/能力、未声明的 `secretRef`、`Infinity` 费用可通过出包，却会在服务启动时被拒。切换脚本又是先写配置再启动、失败不自动回滚配置。

---

## 发现（按严重度）

### 1. 中高：出包校验能接受服务启动会拒绝的目标，切换后才发现（I-73）

**文件:行**
- `scripts/delivery-mode/make-packet.py:284-298`
- `packages/platform-node/src/strict-configuration.ts:233-238`、`242-252`、`1422-1439`
- `scripts/delivery-mode/packet-template/systemd/S7-switch-start-readback.py:161-171`、`334-355`

**问题：读代码证实的**

`make-packet.embedding_target()` 新增的检查与服务启动的 `parseProductConfiguration()` 并不等价，至少四类目标能通过出包，却会在服务启动时被拒：

1. **重复的 `allowedDataClassifications`**
   - 出包只检查：
     ```python
     if not isinstance(classifications, list) or not classifications or not set(classifications) <= {'public', 'private', 'sensitive', 'restricted'} or not all(isinstance(value, str) for value in classifications):
     ```
     `['private', 'private']` 能通过。
   - 服务端 `classifications()` 明确拒绝重复：
     ```ts
     if (new Set(result).size !== result.length) throw invalid(field, "must not contain duplicates");
     ```

2. **重复或不合规的 `capabilities`**
   - 出包只要求每个值是非空字符串且包含 `embedding`。
   - 服务端 `stringArray()` 要求每一项都通过 `safeReference`，且不得重复：
     ```ts
     const result = value.map((entry, index) => safeReference(entry, `${field}[${index}]`));
     if (new Set(result).size !== result.length) throw invalid(field, "must not contain duplicates");
     ```
     `['embedding', 'image input']`、`['embedding', 'embedding']` 出包通过、服务拒绝。

3. **`cost` 为非有限的 `Infinity`**
   - 出包检查 `type(value) in (int, float)` 且 `value >= 0`；Python 的 `Infinity >= 0` 为真。
   - 服务端 `nonNegativeNumber()` 要求 `Number.isFinite(value)`。
   - 更糟的是 `json.dumps` 会把 `Infinity` 写成非标准 JSON 的 `Infinity`，服务端 `JSON.parse` 直接解析失败。

4. **网关目标的 `secretRef` 没有在 `secretReferences` 里声明，或声明了多份**
   - 出包只检查它是合法引用字符串（网关时非 `null`）。
   - 服务端启动时：
     ```ts
     if (descriptor.secretRef !== null && !secretReferenceNames.has(descriptor.secretRef))
       throw invalid("configuration.modelDescriptors", `model ${descriptor.ref} references an undeclared secret`);
     if (descriptor.secretRef !== null && secretReferences.filter(({ ref }) => ref === descriptor.secretRef).length !== 1)
       throw invalid("configuration.secretReferences", `model ${descriptor.ref} must resolve exactly one secret version`);
     ```

**后果：读代码证实的**

切换脚本 `static_root_configuration()` 只做字段比对，不调用产品解析器：`packet-template/systemd/verify-switch-config-fixtures.py:42-64` 也只比较期望 JSON 和 bytes。因此这类目标会在 `S7-switch-start-readback.py:166-168` 写进配置、`systemctl start` 后才失败。异常处理只 `systemctl stop`，并明确记录 `rollbackPerformed: False`（见同文件 `334-355`、`259`），配置不会自动恢复。也就是说，这不仅是“出包时漏拒”，而是**不可撤销的切换操作已经把坏配置写上去之后才失败**。

**建议**

- 出包侧至少补齐：分类/能力去重、能力引用写法、`math.isfinite(cost)`。
- `secretRef` 的声明关系最好在**切换时**用 `original_configuration['secretReferences']` 校验（出包时拿不到生产密钥清单），或在 packet 检查里直接拿切换后的配置跑 `parseProductConfiguration`——项目里已有 `check:product-path-configuration` 的先例。
- 反向用例要覆盖：重复分类、重复能力、`Infinity` 费用、未声明/多份 `secretRef`。

---

### 2. 中：补算的“失败满 3 条就停”会挡住后面的好条目，与 ADR 说法不符

**文件:行**
- `packages/memory-engine/src/episodes.ts:344`、`349-350`、`363-366`、`378`
- 调用方 `apps/agent-service/src/service-main.ts:1531-1548`
- `docs/adr/0224-memory-embedding-runs-on-the-host.md:57`

**问题：读代码证实的**

```ts
limit: Math.min(100, input.limit + FAILED_EPISODES_SKIPPED_PER_PASS),   // 344
...
for (const episode of episodes) {
  if (embedded >= input.limit || failed >= FAILED_EPISODES_SKIPPED_PER_PASS) break;  // 350
...
  } catch (error) {
    failure ??= { error };
    failed += 1;                                                        // 365
    continue;
  }
...
if (failure && embedded === 0) throw failure.error;                     // 378
```

三个问题叠在一起：

1. **停在第 3 条失败，根本没试第 4 条。** `failed >= 3` 在循环顶部判断，遇到第 3 条失败后下一次循环就 `break`，所以“多取 3 条候选”只能越过 **2 条**连续失败，不能越过 3 条。常量名和 ADR 的“每次最多跳过 3 条”都不准确。
2. **`limit=100` 时“多取 3 条”完全失效。** `Math.min(100, 100 + 3) == 100`，而 `SQLite listUnembedded()` 本身也把上限卡在 100（`sqlite-memory-operations.ts:1490`）。启动补算用的就是 `limit: 100`（`service-main.ts:1535`）。
3. **3 条连续坏条目会让整轮直接放弃。** 旧代码会遍历完这一页（最多 100 条），跳过任意数量的失败，把后面的好条目都算完。新代码在第 3 条失败时 `break`，若前面没有成功过，`embedded === 0` 就抛错；`catchUpLocalVectors()` 的 `for (;;)` 通过 `.catch(...)` 停止，后面的好条目再也不会被补算。这正好和 ADR 的“跳过它、接着算后面的”相反。

`listUnembedded()` 按 `ORDER BY e.created_at, e.id`（`sqlite-memory-operations.ts:1501`），坏条目会一直排在最前面，所以不是“下一轮自然越过”的问题。

关于作者特别问的“`for (;;)` 会不会不结束”：**不会**。每轮要么返回正数、要么返回 0、要么抛错；抛错被 `catch` 住后循环结束。问题是它会**过早结束/不前进**，不是无限循环。

**建议**

- 这一页本身就是有界的（≤100），不需要以失败条数作为循环终止条件。建议去掉 `failed` 相关的 `break`，只保留 `embedded >= limit` 和页面耗尽；这样 1 条坏、3 条坏都能越过，旧行为也不会退步。
- 如果确实想限制每轮失败尝试数，应取 `limit + N + 1` 条候选并允许 `failed > N` 后再停，而不是在第 N 条失败时提前停。
- 增加“3 条连续坏条目后面有 1 条好条目”的用例；当前 `episode-backfill.unit.test.ts:73-112` 只覆盖了 1 条坏条目的情况。

---

### 3. 中：`releaseReserved()` 可以替换掉真正的执行权错误，导致仍然写检索降级记录

**文件:行**
- `apps/agent-service/src/production-run-memory.ts:373`
- `packages/application/src/services/model-invocation-admission-service.ts:544-552`
- `packages/persistence-sqlite/src/sqlite-model-invocation-operations.ts:618-620`、`856-901`

**问题：读代码证实的**

`whileHeld` 包住了 `gate.begin`、`assertActive`、`markStarted`，但没包清理路径：

```ts
} else if (started && !settled) await markUnknownKeepingError();
else if (!started) await permit.releaseReserved();   // 373，没有 try/catch，也没有 whileHeld
throw error;
```

`releaseReserved` 内部同样做执行权检查：

```ts
releaseReserved: async () => {
  await this.#invocations.releaseReserved({ ... });   // model-invocation-admission-service.ts:544
}
```

落库时：

```ts
this.assertCurrentAuthority(scope, input.at);          // sqlite-model-invocation-operations.ts:618
this.assertExecutionLease(row, input.executionLease);  // :620
```

`assertCurrentAuthority()` 在产品授权过期/失效时抛 `PORT_NOT_AUTHORITATIVE`（`:891`），`assertExecutionLease()` 也会抛同码（`:897-900`）。

因此，当初始 `assertActive`（或 `markStarted`）因授权/租约失效抛出 `NOT_AUTHORITATIVE` 时：
- `whileHeld` 把**原错误**加入 `leaseLost`；
- 进入 `catch` 后 `releaseReserved()` 又因同样的授权失效抛出**另一个** `NOT_AUTHORITATIVE`；
- 这个清理错误没有被 `whileHeld` 记录，而且直接取代了 `throw error` 抛给上层；
- `searchCancelled()` 检查的是最终抛出的那个错误对象，不在 `leaseLost` 里，返回 `false`；
- `onVectorFailure` 于是写一条本不该有的“检索降级”记录，原始原因也被覆盖。

现有测试 `production-model-composition.unit.test.ts:942-954` 的 `releaseReserved: vi.fn(async () => {})` 是空实现，所以覆盖不到这条路径。

**建议**

- 清理阶段不要让清理错误替换原错误：给 `releaseReserved` 单独 `try/catch`，失败只记录诊断，最后始终 `throw error`；或把 `releaseReserved` 也纳入 `leaseLost` 记录但保留原错误再抛。
- 增加用例：`permit.assertActive` 和 `permit.releaseReserved` 都抛 `NOT_AUTHORITATIVE` 时，仍不得写检索降级记录，且抛出的错误应是原始错误。
- 如果判断 `settle` 也是执行权检查（它同样走 `assertCurrentAuthority`/`assertExecutionLease`），也应按同样方式处理，或明确说明为何不算。

---

### 4. 低：入口处直接抛出的 `NOT_AUTHORITATIVE` 没有被登记

**文件:行**
- `apps/agent-service/src/production-run-memory.ts:159-166`、`270-274`（另有 maintenance 分支的 `EMBEDDING_MAINTENANCE_REQUIRES_FREE_MODEL`）

```ts
if (!classification || (!projection && !mail && !maintenance && (!context?.runId || !context.executionLease)))
  throw new ApplicationPortError(PORT_ERROR_CODES.NOT_AUTHORITATIVE, "EMBEDDING_EXECUTION_CONTEXT_REQUIRED");
...
const gate = await options.admission({ ...context, runId: context.runId });
if (!gate)
  throw new ApplicationPortError(PORT_ERROR_CODES.NOT_AUTHORITATIVE, "EMBEDDING_ADMISSION_REQUIRED");
```

**问题：读代码证实的机制，推测的可达性**

这两处是执行上下文/准入检查，但发生在 `whileHeld` 之外。若它们经嵌入边界冒泡到 `HybridMemoryProvider.search()` 的 `onVectorFailure`，`searchCancelled()` 不会认；而它们显然不是“嵌入服务真出错”。作者把 `EMBEDDING_ADMISSION_REQUIRED` 归为执行权检查的话，这里就是“漏包”。

**建议**：把这两处也走一个记录器，或至少在测试里明确“准入缺失不应写检索降级”。可达性需要结合真实运行确认（正常工具调用时 `runs` 存在，`gate` 通常不为空），所以标为低。

**另外**：`EMBEDDING_EXECUTION_CONTEXT_REQUIRED` 在 `search()` 的正常路径上通常不会出现（`runId`/`executionLease` 由 `embedWithin` 提供），所以实际影响小于第 3 条。

---

### 5. 低：上线前检查对“合法目标”的误拒和未校验输入

**文件:行**
- `scripts/delivery-mode/make-packet.py:282`
- `scripts/delivery-mode/embedding-artifact-check.py:34`、`57-60`
- `scripts/delivery-mode/deploy-preflight.py:113-116`、`148`

**问题：读代码证实的**

1. **数值写法误拒（新规则）**
   - 出包：`type(target['dimensions']) is not int`，所以 JSON 里写成 `1024.0` 或 `1e3` 的目标被拒。
   - 服务端：`Number.isSafeInteger(1024.0)`、`Number.isSafeInteger(1e3)` 都为真，`integer()` 会接受。严格说这是“服务能启动、出包拒绝”。
   - 上线前检查把维度 `str()` 后要求 `[1-9][0-9]{0,4}`，也会把 `"1024.0"` 判成 `target-invalid`。

2. **所有权要求比服务加载更严（既有，但和新规则一起被当成“按服务加载规则”）**
   - `embedding-artifact-check.py:22-30` 要求 manifest 和每个文件 `uid == state_root owner`。
   - 服务端 `verifyLocalOnnxArtifact()` 只检查符号链接、是否普通文件、哈希和文件白名单（`packages/platform-node/src/local-onnx-embedding.ts:63-69`、`126-133`），不检查 owner。文件由 root 安装、服务账号可读时，服务能启动，上线前检查会拒。部署提示文案确实要求 owned by service account，所以这可能是刻意更严；若要声称“按服务加载规则”，应写明差异或改成与 loader 一致。

3. **未校验的 packet 输入会直接抛 Python 异常**
   - `deploy-preflight.local_embedding_target()` 只检查 `provider == 'local-onnx'`；`remote_script()` 直接访问 `embedding['model']`、`embedding['artifactSha256']`、`embedding['dimensions']`。旧包/手改包缺键会在本地构建脚本阶段 `KeyError`，而不是给出 `embeddingArtifact=check-failed`。

**建议**：`local_embedding_target()` 用与出包相同的形状检查（至少 `model/artifactSha256/dimensions` 存在且类型正确，并接受整数等价写法）；如果希望 owner 更严，在 ADR/提示里写明“比服务加载更严”。低优先级。

---

### 6. 低：测试与文档的缺口

**文件:行**
- `packages/memory-engine/test/episode-backfill.unit.test.ts:73-112`
- `apps/agent-service/test/production-model-composition.unit.test.ts:936-1025`
- `scripts/delivery-mode/test_make_packet.py:568-598`
- `scripts/delivery-mode/test_deploy.py:210-222`
- `docs/adr/0224-memory-embedding-runs-on-the-host.md:57-58`

**问题：读代码证实的**

- 反向用例确实能挡住作者声称的改动：
  - 还原“多取候选”：旧代码在 `[broken, next, later]`、`limit=1` 时会返回 2，测试期望 1，会失败（推演）。
  - 还原“只认 `leaseLost`”：第三个 `toolSearch` 抛的 `EMBEDDING_BOUNDARY_REQUIRED` 在旧代码下会被当成取消，`recorded` 会变成 `false`，测试期望 `true`，会失败（推演）。
  - 还原 MCP 取消判断：`mailScope` 那段会失败（推演）。
  - 还原 Gemma 前缀拆分：`embeddingTexts ∩ TRUSTED_PROMPT_TEXTS` 会多出 29 字符串，测试失败（推演）。
- 但以下没有对应用例，单独改坏不会变红：
  - `gate.begin` / `markStarted` / 发送后 `assertActive` 抛 `NOT_AUTHORITATIVE` 的登记（现有测试只覆盖第一个 `assertActive`）。
  - `releaseReserved` 抛 `NOT_AUTHORITATIVE` 的清理路径（第 3 条）。
  - 3 条连续失败后仍有好条目（第 2 条）。
  - 重复分类/重复能力/未声明 `secretRef`/`Infinity` 费用（第 1 条）。
  - manifest 里文件哈希写成非十六进制字符串（新增的 `re.fullmatch(r'[0-9a-f]{64}', expected)` 没有反向用例）。
- 文档与代码不一致：
  - ADR 0224:57 “每次最多跳过 3 条”，代码实际只能越过 2 条连续失败（第 3 条失败即停）。
  - ADR 0224:58 “费用是非负数字”，代码接受 `Infinity`，服务端不接受。
  - ADR 0224:87 “清单和改动前完全一样”这一条，就 Gemma 前缀而言是成立的（新片段都 <24 字符，main 本来也没有 Gemma 前缀），但它依赖“每段都短于 24”这个实现细节，没有把“以后某段变长”纳入持续检查。

---

## 侧重检查

- **错误路径**
  - 租约在 begin 前丢失：`whileHeld(gate.begin)` 能记录，好。
  - 租约在首次 `assertActive` / `markStarted` 丢失：能记录，但 `releaseReserved` 失败会替换原错误（第 3 条）。
  - 租约在发送后 / 结算后丢失：`assertActive` 被包住；`settle` 自身不在 `whileHeld` 里，但发送后的 `settle` 失败会被内层 `catch` 吃掉并保留原错误；`markUnknown` 也容错。可接受。
  - 超时重试：只对 `EMBEDDING_ATTEMPT_TIMED_OUT` 重试；`NOT_AUTHORITATIVE` 不重试，符合预期。
  - MCP 客户端取消：`mailScope.getStore()?.signal.aborted` 生效；测试覆盖 aborted 前后。
  - 补算失败：3 条连续失败会中止整页（第 2 条）。
- **不合规范/不可信输入**
  - packet 目标：重复分类/能力、`Infinity`、未声明 `secretRef` 能过出包（第 1 条）；缺键的旧包会让 preflight 抛异常（第 5 条）。
  - 模型目录：符号链接、非普通文件、哈希、文件白名单、维度都有核对；owner 比服务更严；manifest 文件哈希新增了十六进制格式检查。
  - 模型名/哈希：`SAFE_NAME` 允许大写和超长（服务端 `localOnnxArtifactDirectory` 只允许小写且 ≤128），这是放宽，不是误拒。
- **安全**
  - Gemma 前缀拆分后，`TRUSTED_PROMPT_TEXTS` 相对 main 没有新增/删除（新片段 19、10 个字符，都低于 24；main 原本没有 Gemma 前缀）。没有新的遮盖不确定性。
  - 出包和上线前检查仍只处理引用，不写密钥；packet 输出拒绝引号和反斜杠。
  - 新校验没有引入日志泄露；`leaseLost` 只存错误对象引用。
- **资源耗尽**
  - `listUnembedded` 每页硬上限 100，`limit + 3` 仍被 `min(100, …)` 卡住；不会有新的无限查询。
  - `catchUpLocalVectors` 的 `for (;;)` 在“返回 0 / 抛错”时结束，不会无限循环；但会因第 2 条提前结束。
  - artifact 校验按块流式计算哈希，没有整文件读入；manifest 本身仍是整体 `json.loads`，未加大小上限（既有）。
- **不可撤销操作**
  - 切换脚本先写配置、再启动服务，失败时只停服务，`rollbackPerformed: False`；因此出包放过的坏目标可能留下已切换但起不来的配置（第 1 条）。
- **规则/文档与代码一致性**
  - `prompt-prefix.md` 第 4、11 条：本轮没有改变请求开头，见必答问题 1。
  - ADR 0224 的“跳过 3 条”“费用是非负数字”与代码有偏差，见第 2、6 条。
  - `docs/incidents-and-gates.md#I-73` 的教训在本轮仍然存在：出包侧的 `embedding_target` 没有把同一份目标交给服务解析器验证。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会（就本轮改动而言）。**

依据：
- 本轮唯一和提示词有关的是 `packages/prompt-catalog/src/memory.ts:83`，它只改 **embedding** 层的查询前缀分段；渲染结果仍是 `task: search result | query: 晚饭`（`prompt-rendering-golden.unit.test.ts:267-270`）。
- 出口遮盖的固定文字清单来自 `trustedPromptTexts()`（`packages/prompt-catalog/src/entry.ts:61-75`），只收**单个 text 段 ≥24 字符**的文字。新拆出的 `task: search result`（19）和 ` | query: `（10）都低于 24；main 上本来也没有 Gemma 查询前缀（`git show 1222bc…:packages/prompt-catalog/src/memory.ts` 没有该条目）。因此 `TRUSTED_PROMPT_TEXTS` 相对 main 不变，不会让老对话历史被遮成不同字节。
- 本轮其他改动（补算、`leaseLost`、出包脚本）都不进聊天提示词。
- 没有新增“每轮会变”的值进入系统提示或工具定义；会变的内容仍只在最后一条消息里。满足 [prompt-prefix.md#rules](../../.claude/rules/prompt-prefix.md#rules) 第 4 条和 [#deterministic](../../.claude/rules/prompt-prefix.md#deterministic) 第 11 条。

补充：拆段会改变 `embeddingIdentityFor()` 的 `recipe()`（`packages/application/src/embedding-profiles.ts:149-164`），从而改变 Gemma 的向量身份；但 Gemma 是本次 PR 新引入的模型，main 上无旧向量，且这也不是发给聊天模型的请求前缀。ADR 0224:87 已记录“升级本身会重算一次向量”。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**不会引入新的不确定性。**

- 固定文字清单的生成是 `Set` + 确定性排序（`entry.ts:61-75`），本轮成员不变。
- 出包的 `embedding_target()` 用 `json.dumps(..., sort_keys=True, separators=(',', ':'), ensure_ascii=True)`（`make-packet.py:299`），顺序固定。
- 补算的候选顺序取决于 SQL `ORDER BY e.created_at, e.id`（`sqlite-memory-operations.ts:1501`），但补算结果不进入模型请求字节；同一页内处理顺序是确定的。
- 没有新增带时间的提示词字段。
- 唯一“会变”的是向量身份（因为分段结构变了），但它对该构建是确定的；不会同一段文字在不同请求里时好时坏。

### 3. 有没有对应的自动检查？反向用例真的会失败吗？

**有，但不完整。**

能真正挡住回退的（按断言推演）：
- 补算候选数：`episode-backfill.unit.test.ts:100-111`，旧逻辑会返回 2 而不是 1。
- 任意 `NOT_AUTHORITATIVE` 不得被当租约丢失：`production-model-composition.unit.test.ts:1007-1012`，旧逻辑会把它当取消。
- MCP 取消：同文件 `1013-1024`，旧逻辑不检查 `mailScope`，会失败。
- Gemma 前缀不进入 trusted 清单：`prompt-rendering-golden.unit.test.ts:273-290`。
- 出包新增非法目标用例：`test_make_packet.py:581-583`。
- 上线前维度/多文件：`test_deploy.py:210-222`。
- 出包档案与运行档案一致：`test_make_packet.py:588-598`。

没有覆盖/改了也不会红的：
- `gate.begin`、`markStarted`、发送后 `assertActive`、`settle` 后的 `assertActive` 抛 `NOT_AUTHORITATIVE`（只有首次 `assertActive` 有测试）。
- `releaseReserved` 抛 `NOT_AUTHORITATIVE`（第 3 条）。
- 3 条连续失败之后还有好条目（第 2 条）。
- 重复分类/能力、未声明 `secretRef`、`Infinity` 费用（第 1 条）。
- manifest 文件哈希为非十六进制字符串。
- 切换后的配置交给 `parseProductConfiguration` 校验（现有 fixture 只做 JSON 比对，这正是 I-73 的缺口）。

### 4. 每个新值/修改值，生产端和使用端都能接受吗？

**大部分能，但有三处断链。**

能对上的：
- `EMBEDDING_PROFILES`（`make-packet.py:264-269`）与 `packages/application/src/embedding-profiles.ts` 一致，且有 `test_make_packet.py:588-598` 的源码比对测试。
- `TARGET_EMBEDDING_JSON` 的键集合、引用写法、维度、本机 `artifactSha256`/`secretRef` 约束，与服务端 `parseModel()` 的 embedding 分支基本对齐。
- 上线前新增的 `dimensions` 参数：生产端 `deploy-preflight.py:148` 传入，使用端 `embedding-artifact-check.py:59-60` 比较 `manifest.dimensions`；服务端 `verifyLocalOnnxArtifact()` 也做同样比较（`local-onnx-embedding.ts:124`）。
- `OPTIONAL_FILES = ('model.onnx_data',)` 与服务端 `OPTIONAL_FILES` 完全一致（`local-onnx-embedding.ts:21`）。
- `prompt-manifest.json` 的 Gemma digest 更新与 `digest = sha256(JSON.stringify(segments))` 的定义一致（`prompt-catalog.unit.test.ts:167-174`），但该具体 hash 我没有独立计算，标“未核实”。
- `mail.dataClassification ?? "private"` 的默认值在服务端分类白名单检查之前使用（`production-run-memory.ts:157`、`168`），私有默认是保守的。

对不上的（详见发现 1）：
- **`secretRef`**：出包只验证“像引用”，服务启动还要求它在 `secretReferences` 中恰好声明一次。切换脚本不检查，属于最典型的 I-73 断链。
- **`allowedDataClassifications`/`capabilities` 的唯一性**：出包不查，服务查。
- **`cost` 的有限性**：出包不查，服务查；`Infinity` 还会生成服务端 JSON 解析不了的配置。
- **`dimensions` 的数值表示**：出包要求 Python `int`，服务接受 `Number.isSafeInteger`，`1024.0`/`1e3` 会被出包误拒（反向的断链）。
- **`local_embedding_target` 的形状**：只校验 `provider`，缺 `dimensions` 的 packet 会让 preflight 在构建脚本阶段抛 `KeyError`，而不是走 `embeddingArtifact=check-failed`。

建议优先修第 1 条的 `secretRef` 声明校验与重复项校验，并让切换 fixture 真正跑一次产品解析器；这会把“出包放过、上线后才炸”的窗口关掉。
