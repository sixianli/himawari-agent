## 读代码证实的问题

### 1. 中 — `#writeText` 现在会静默接受已存在的 `restricted` payload，可能与 ADR 0213 的“按 sensitive 保存”不一致

- 位置：`apps/agent-service/src/production-owner-rules.ts:407-409`
- 问题：改动只删掉了 `payload.dataClassification === "restricted"` 的拒绝分支，改成只判断 payload 是否存在。新写入的文本确实最多只能到 `sensitive`，但如果同一 ref 已存在一条 `restricted` payload，现在会直接返回 `restricted`，随后被当作规则记忆的分类保存。
- 证据：

```ts
407:    const payload = await this.#options.payloads.get(ref);
408:    if (!payload) throw new OwnerRuleError("RULE_UNAVAILABLE");
409:    return payload.dataClassification;
```

```ts
428:    const classification = await this.#writeText(contentRef, input.text);
...
436:          dataClassification: classification as ProductMemoryRecord["dataClassification"],
```

`classificationWithIdentifiers` 对 `private` 输入最多返回 `sensitive`，这点作者没说错：

```ts
20: export function classificationWithIdentifiers<T extends string>(
...
24:   return (classification === "private" || classification === "public") &&
...
26:     ? "sensitive"
27:     : classification;
```

同一函数对已经是 `restricted` 的输入原样返回：

```ts
103:    expect(classificationWithIdentifiers("卡号 6222020200112233445", "restricted")).toBe(
104:      "restricted",
105:    );
```

所以正常新写入路径不会产生 `restricted`，但“ref 已存在”时确实可能。并且系统别处对 `restricted` 记忆有明确取舍：自动记忆候选遇到 `restricted` 会丢弃，而规则记忆路径现在不会：

```ts
165:      if (candidate.dataClassification === "restricted") {
...
168:        await this.discard(input, candidate, candidateOrdinal, "restricted_excluded", false);
```

- 影响：`restricted` 规则记忆不会进入 owner-rules 上下文（`owner-profile-service.ts:184-189` 按 ceiling 过滤），决策链也会把正文标成隐藏（`production-decision-chain.ts:260-263`），所以不是直接泄露；但它与 ADR 新增的“原话按 sensitive 保存”描述不一致，也绕过了旧代码原本的拒绝。
- 建议：明确二选一并在代码和 ADR 固定下来：
  1. 若不想接受 `restricted`，保留守卫但改报 `RULE_UNAVAILABLE` 或保留一个可达的错误码；
  2. 若决定接受，明确写出 `restricted` 时规则记忆也是 `restricted`，并补一条直接构造 `restricted` payload 的测试。
  不要像现在这样只在普通路径上隐含“最多 sensitive”。

### 2. 中 — 新增集成测试在基准提交上也会通过，不能防止旧行为回归

- 位置：`test/integration/production-memory-capture.test.ts:1813-1843`
- 问题：这个测试验证的是“带卡号的原话能建规则、记忆是 sensitive”。但基准版本的 `#writeText` 只有在分类为 `restricted` 时才抛 `RULE_TEXT_REFUSED`；`classificationWithIdentifiers(text, "private")` 对卡号返回的是 `sensitive`，不会进入该分支。因此同一测试在 `6d63e1c` 上也会通过，不能证明本次删除的拒绝分支被正确移除，也没有覆盖 `!payload` 的新分支。
- 证据：基准版本的 `#writeText` 是：

```ts
if (!payload || payload.dataClassification === "restricted")
  throw new OwnerRuleError("RULE_TEXT_REFUSED");
return payload.dataClassification;
```

而当前测试的输入是银行卡号，分类函数把它提升为 `sensitive`：

```ts
1814:    const sentence = "尾号 6222 0212 3456 7890 的扣款邮件以后必须通知我";
...
1841:    expect(ruleMemory).toMatchObject({ status: "active", dataClassification: "sensitive" });
```

现有的 `RULE_UNAVAILABLE` 用例覆盖的是“出处记忆已删除”的路径，不是 `#writeText` 读不回 payload：

```ts
2102:    await expect(
2103:      command(
...
2109:    ).rejects.toThrow("RULE_UNAVAILABLE");
```

- 建议：
  - 增加一个反向/边界用例：在 `memory-content:rule:<key>` 预置 `restricted` payload，断言选定行为；如果应拒绝，就在基准上失败、修复后按选择通过。
  - 增加一个 payload store 假实现：`put` 成功但随后 `get` 返回 `undefined`，断言报 `RULE_UNAVAILABLE`。
  - 若 ADR 承诺“口令”也照常保存，补一条带口令的规则集成用例；目前只有卡号。

### 3. 低 — 同一 ref 已存在时既不校验旧文本，也不重新定级

- 位置：`apps/agent-service/src/production-owner-rules.ts:396-409`
- 问题：`#writeText` 发现 ref 存在时直接复用旧 payload 的文本和分类。若同一 key 对应的 ref 被复用而文本已经不同，新文本里的卡号/口令不会触发重新定级；更糟的是旧文本可能与新原话不同。
- 证据：

```ts
396:    if (!(await this.#options.payloads.get(ref)))
397:      await this.#options.payloads.put(...)
...
407:    const payload = await this.#options.payloads.get(ref);
408:    if (!payload) throw new OwnerRuleError("RULE_UNAVAILABLE");
409:    return payload.dataClassification;
```

- 可达性：正常工具调用中 key 由 `runId + toolCallId` 派生，且执行层有 fingerprint 校验，**推测**很难通过正常工具路径制造“同 key 不同文本”。因此列为低。直接调用 `ProductionOwnerRuleWriter.create`、部分失败后的重试，或 MCP 固定 proposal key 的路径是否可能触发，**未逐一核实**。
- 建议：若该函数语义是“按这次 text 返回分类”，应校验已存在 payload 的内容，或在文本变化时重新分类；否则至少在函数注释/测试中明确“已有 ref 时忽略新 text”。

### 4. 低 — `RULE_TEXT_REFUSED` 已无引用，但 `RULE_UNAVAILABLE` 在网页端只有通用失败提示

- 位置：`apps/agent-service/src/production-runtime-tools.ts:615-620`，`apps/agent-service/src/production-memory-control.ts:1111-1117`，`apps/control-center/src/memory.ts:122-135`
- 问题：工具结果映射会原样返回 `RULE_UNAVAILABLE`，控制命令把它转成 `INVALID_OPERATION`，网页 `run()` 统一 `catch` 后只设置 `failed`。功能上能处理，但没有专门文案。这不是本次引入的错误，偏低。
- 证据：

```ts
615:      (error) => ({
616:        errorCode: error instanceof OwnerRuleError ? error.code : "RULE_UNAVAILABLE",
```

```ts
1111:        if (error instanceof OwnerRuleError)
1112:          throw new ApplicationPortError(
1113:            error.code === "RULE_NOT_FOUND"
1114:              ? PORT_ERROR_CODES.NOT_FOUND
1115:              : PORT_ERROR_CODES.INVALID_OPERATION,
```

```ts
122:  const run = useCallback(async (operation: () => Promise<unknown>) => {
...
128:    } catch {
129:      setFailed(true);
```

- 建议：如果 `RULE_UNAVAILABLE` 以后会经常出现在用户操作里，补一条具体提示；否则保持通用失败可以接受。

## 推测与未核实

- **推测**：同 ref 旧 payload 为 `restricted` 的情况在正常生产中很难出现，因为 `memory-content:rule:*` 和 `rule-proposal:*` 当前只在 `production-owner-rules.ts` 写入，且写入分类来自 `classificationWithIdentifiers(text, "private")`。我没有找到其他写入方，也没有核实数据库被外部数据、旧版本或人工修复写入该 ref 的所有可能。
- **未核实**：没有实际运行测试（工具限制只允许读取和指定 git 命令），所以“新增测试在基准上通过”的结论来自代码路径分析，不是测试执行结果。
- **未核实**：MCP 固定 `mcp:<proposalId>` key 的重复提议路径是否可能产生同 ref 不同 quote；只读到 `production-mcp-rule-writer.ts` 的 key 生成方式，没有追完所有调用方。

## 侧重检查

- **错误路径**：检查了 `#writeText` 的 `!payload` 分支、`RULE_UNAVAILABLE` 的工具/控制命令/网页映射。映射可用，但新分支没有专门测试。
- **不合规范或不可信输入**：`quote` 仍有长度和代理字符校验；本次改动没有新增解析输入。主要风险是已存在 payload 的 `restricted` 分类被静默接受。
- **安全**：卡片/口令文本按 `sensitive` 保存符合 Andy 的决定；但 `restricted` payload 现在可以绑定成规则记忆，绕过了旧拒绝，也与自动记忆丢弃 `restricted` 的策略不一致。规则记忆进入 owner-rules 上下文块，敏感记忆本身对模型可见（`model-visibility.ts:10-25`），这是既有设计。
- **资源耗尽**：没有新增循环、集合扩张或外部调用；`quote` 上限 500、`summary` 上限 200，原话分类函数输入有界。未发现新增资源耗尽路径。
- **不可撤销操作**：规则仍可通过 `undo` 退休并归档出处记忆；本次没有改变撤销语义。没有新增不可撤销操作。
- **规则文件、说明文档和代码一致性**：`RULE_TEXT_REFUSED` 在当前工作树中已无引用；ADR 0213 新增段落与实际“新写入按 sensitive”一致，但未覆盖 `restricted` 已存在 payload 的边缘行为，二者存在说明缺口。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   - 读代码结论：本次 diff 没有改系统提示、工具定义、历史消息或遮盖逻辑。
   - 新规则记忆会进入 `owner-rules` 上下文块，而该块被拼进当轮最后一条用户消息：

```ts
623: function turnPrompt(projection: RuntimeProjection, timeZone: string): string {
...
634:     ...blocks.map((block) => contextBlockContent(block, timeZone)),
...
638:     "<owner-message>",
639:     projection.prompt.content,
640:     "</owner-message>",
```

   - 因此发给模型的内容仍然只在末尾追加；新增规则只改变新的最后一条消息里的上下文块，不改已发出的历史。每轮会变的 `owner-rules`、记忆、时间等都在最后一条消息里。依据 `prompt-prefix.md` 第 4、10、11 条，本次改动不触发请求开头变化。
   - 需要注意：如果 `restricted` 被接受，该规则记忆会被 owner-rules 过滤掉，但这是显示/上下文差异，不是历史前缀改写。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   - 本次改动新增的只有存储分类和错误码；分类函数只依赖文本本身，是确定性的，没有时间、随机数、无序集合或前后文依赖。
   - 规则记忆文本本身由 `quote + "\n" + summary` 决定；owner-rules 块的文本和顺序由记忆状态决定，不是本次新增的不确定性。
   - 结论：本次 diff 没有引入新的“同文字不同字节”来源。但既有出口遮盖对密码/验证码可能依赖点名消息和前后文，这属于既有机制，本次未改；对它在规则记忆跨多轮场景下的具体字节，我**未逐轮核实**。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   - 有新集成测试，但它验证的是旧代码本来就有的行为，**在基准提交上也会通过**，所以不是本次改动的回归测试。
   - `!payload -> RULE_UNAVAILABLE` 新分支没有测试。
   - 没有反向用例证明“恢复 `RULE_TEXT_REFUSED`/重新拒绝 restricted 时必须失败”。
   - 结论：自动检查覆盖不足。见问题 2 的建议。

4. **改动产生或修改的每个值，每个使用它的地方都能接受吗？**
   - `RULE_TEXT_REFUSED`：已从联合类型和分支删除；当前工作树中未发现任何引用，契约、网页、工具结果映射都不再依赖它，可接受。
   - `RULE_UNAVAILABLE`：由 `#writeText` 产生，经工具映射返回码，经控制命令映射为 `INVALID_OPERATION`，网页统一显示失败；调用链能接受，但没有专门提示。
   - `#writeText` 返回值：正常新写入最多 `sensitive`，`#writeMemory` 接受并写入 `ProductMemoryRecord.dataClassification`，下游：
     - 规则列表 `#rules` 只用规则摘要，不看记忆分类，正常；
     - 回执卡只用摘要/试算/回放，不看记忆分类，正常；
     - 决策链对 `sensitive` 可见，能显示；对 `restricted` 隐藏正文；
     - owner profile 对 `restricted` 会过滤掉该规则记忆，规则本身仍存在。
   - 所以“`sensitive`”值各端都能接受；但“`restricted`”这个可能返回的值，虽然类型和存储能接受，语义与 ADR 及自动记忆策略不一致。
