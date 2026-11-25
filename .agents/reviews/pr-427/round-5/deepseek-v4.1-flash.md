## 侧重检查

- **不可信输入、错误路径**：模型给的 `activityIcon` 是不可信字符串。投影层先 `trim`，再在 `PROCESS_ACTIVITY_ICONS` 里查；不在表里就用 `PROCESS_ACTIVITY_FALLBACK_ICON`。三个新名字都在表里，未知名字仍被兜底，不会让工具调用失败。读代码证实。
- **安全、资源耗尽、不可逆操作**：本次只改静态字符串，没有新增外部输入解析、循环、文件写入或不可逆操作。读代码证实。
- **规则、文档、代码一致性**：`activity.ts`、prompt manifest、golden 请求、`[ICON-2]` 和 ADR 的兜底名一致。网页自己的 `tool-icon.tsx` 里的 `review: "checklist"` 和 `glyphs.tsx` 的 `checklist` 是另一个图标命名空间（自动审查用的网页 glyph），不是本次遗漏。读代码证实。
- **未核实**：prompt manifest 的两个 sha256 无法用现有工具重算；作者说的 2002 例测试和 `check:prompt-prefix` 通过也无法实际运行验证；ADR 链接的外部设计提交 f7cbbf01 不在本地，无法核对它是否仍是旧名字。

## 问题（按严重度）

### 1. 低：还残留一个旧图标名，虽是测试但不是“改全了”

- 文件：`apps/control-center/test/execution-view.unit.test.ts:575`
- 问题：仍写 `activityIcon: "tools"`。`execution-view` 只做空值合并、不校验图标名，所以测试不会失败，也不会影响运行时；但这是仓库里除 ADR 历史说明外最后一处旧名字，和“改名改全了”的目标不一致。
- 证据（亲自读到）：

```ts
575:      record(1, 1, { ...tool, phase: "updated", activity: "搜索网页", activityIcon: "tools" }),
```

```ts
214:      activityIcon: record.activityIcon || previous?.activityIcon || "",
```

- 建议：改成 `"puzzle"` 或其他合法图标名；如果故意用任意字符串测合并，也应换成当前合法的名字，避免以后接入校验时误伤。

### 2. 提示：“老对话不受影响”只对这三个名字成立，对整个 PR 不成立

- 文件：`docs/adr/0250-tools-carry-model-written-activity-and-icon.md:37`；`.claude/rules/prompt-prefix.md:41`
- 问题：作者说“这几段文字还没上线，老对话不受影响”。就这三个名字本身，这是对的：基准 `12ce0d0` 里 `packages/prompt-catalog/src/activity.ts` 根本不存在，老对话没有见过旧名字。但这个 PR 给工具新增了 `activity`、`activityIcon` 参数，参数结构变了，按规则老对话会换新一次请求开头；ADR 自己也写明 Andy 已同意。若把作者的说法理解成“整个 PR 不影响老对话”，就与 ADR 和规则不一致。
- 证据（亲自读到）：

```md
37: ...工具的参数结构变了，每个老对话的请求开头换新一次（Andy 2026-11-12 同意）。
```

```md
41: ...只有下面这些情况才换新一次...工具集合变了（工具名，或者去掉说明文字后的参数结构）...
```

- 建议：把说明限定为“这三个图标名本身不会改变老对话已见内容；整个 PR 会按 ADR 0250 让老对话换新一次”。

### 3. 提示（测试缺口）：参数说明里的兜底名没有直接自动检查

- 文件：`packages/prompt-catalog/src/activity.ts:44`、`:64`；`apps/agent-service/test/prompt-catalog.unit.test.ts:442-449`；`packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts:3609-3635`
- 问题：`[ICON-1]` 只把系统提示图标表解析出来和 `PROCESS_ACTIVITY_ICONS` 比对，不检查 `TOOL_ACTIVITY_ICON_PARAMETER.text` 里的“都不贴近时用 …”是否等于 `PROCESS_ACTIVITY_FALLBACK_ICON`。D4 golden 会比整段请求体，但 golden 是手工维护的；如果代码说明和 golden 同时被改成同一个错误名字，现有测试可能都通过。
- 证据（亲自读到）：

```ts
444:    const told = [...catalog.CHAT_PROCESS_ICONS_SECTION.text.matchAll(/[，：]([a-z0-9-]+) /g)].map(
445:      (match) => match[1],
446:    );
447:    expect(told).toEqual([...catalog.PROCESS_ACTIVITY_ICONS]);
448:    expect(new Set(told).size).toBe(36);
```

```ts
44: export const PROCESS_ACTIVITY_FALLBACK_ICON: ProcessActivityIcon = "puzzle";
64:   text: "可选。...都不贴近时用 puzzle。",
```

- 建议：在 `[ICON-1]` 里加一条直接断言，例如 `expect(TOOL_ACTIVITY_ICON_PARAMETER.text).toContain(\`都不贴近时用 ${PROCESS_ACTIVITY_FALLBACK_ICON}\`)`，把参数说明和常量绑起来。

### 4. 未核实

- `packages/prompt-catalog/prompt-manifest.json:178`、`:737` 的新 sha256 无法用允许的工具重算，不能确认是否与 `activity.ts` 的新文本逐字节对应；作者声称 `check:prompt-catalog` 通过，但未实际运行验证。
- D4 golden 的两条请求体与测试运行结果未实际执行验证。
- 外部设计提交 f7cbbf01 里的图标名是否已经同步改过，未核实（本地设计文档没有该图标表）。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   - 对**已经存在的对话**：不会。系统提示和工具按对话冻结（`.claude/rules/prompt-prefix.md:41-43`），本次只改说明文字，不改工具名或去掉说明后的参数结构，所以不会因此触发换新；冻结的旧副本继续使用。
   - 对**新对话**：会使用新名字，这是新对话的第一次请求开头，不是对已发内容的改写。
   - 对整个 PR：会给工具新增参数，参数结构变化会使老对话按 ADR 0250 换新一次；这是 ADR 已记录的一次性换新，不是本次改名造成的。
   - **仍然只在末尾追加**：是。历史消息和工具结果没有改动；每轮会变的时间、资料、记忆等仍在最后一条用户消息里，本次改动没有把任何会变的值放进系统提示或工具定义。
   - 前提是“这些提示词还没上线”：基准提交里 `activity.ts` 不存在（`git show 12ce...:packages/prompt-catalog/src/activity.ts` 报路径不存在），仓库层面支持这个前提；生产是否已有未记录的部署，仓库无法证明。

2. **同一段文字会不会在不同请求里变成不同字节？**
   - 不会。这次改的是固定数组和固定字符串，顺序固定，没有时间字段、无序集合或依赖前后文的处理。`PROCESS_ACTIVITY_ICONS` 的顺序也没有重排。
   - 唯一需要留意的理论点是规则第 11 条的“固定文字清单”：改提示词会改变旧对话的遮盖清单。但这些文字没有上线，旧对话不存在这些冻结文本；新文本里也没有会被当成敏感信息的数字，因此没有实际影响。此点为按规则推断，未发现可复现的字节变化。

3. **有没有对应的自动检查，反向用例会不会真的失败？**
   - 有：
     - `[ICON-1]`（`apps/agent-service/test/prompt-catalog.unit.test.ts:442-449`）要求系统提示表里的名字与 `PROCESS_ACTIVITY_ICONS` 完全相等且共 36 个；只改数组或只改提示表一边，按逻辑测试会失败。
     - `[ICON-2]`（`test/integration/thread-run-lifecycle.test.ts:3848-3912`）用不存在的 `"rocket"` 验证兜底必须为 `"puzzle"`；如果兜底仍返回 `"tools"`，测试会失败。
     - D4 golden（`packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts:3609-3635`）逐字节比较请求体，参数说明或系统提示表过期会失败。
   - 缺口：没有直接把 `TOOL_ACTIVITY_ICON_PARAMETER.text` 的兜底名和 `PROCESS_ACTIVITY_FALLBACK_ICON` 绑起来的断言，见上面第 3 条。
   - 以上“会失败”是按测试逻辑推断；未实际运行测试。

4. **每个改动值的使用方都能接受吗？**
   - `clipboard-list`、`puzzle`、`heartbeat`：产生于 `packages/prompt-catalog/src/activity.ts:15/33/37`；被系统提示、`PROCESS_ACTIVITY_ICONS` 校验和投影层使用。投影层 `thread-execution-projection.ts:92-94` 用 `includes` 接受它们，未知值走兜底。
   - 兜底 `puzzle`：产生于 `activity.ts:44`；用于投影层兜底和 `[ICON-2]` 期望；它是数组成员，接受。
   - `activityIcon` 下游：网关契约 `thread-contracts-v3.ts:606` 是 `displayText`，不是枚举；网页合并 `execution-view.ts:214` 也只接受字符串，不拒绝新名字。仓库里没有 Apple 客户端代码，无法核对 Swift 端。
   - manifest 两个键仍存在，`changedIn`/`reason` 非空；但 sha 未重算核实。
   - 唯一旧名字残留是测试里的 `"tools"`（第 1 条），它不会被运行时拒绝，但属于漏改。
