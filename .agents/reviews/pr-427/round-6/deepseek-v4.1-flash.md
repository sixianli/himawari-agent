## 结论与发现

### 已读代码证实

**1. 严重度：中 — `docs/execution/specs/2026-11-11-apple-device-body-design.md:208`、`:213`、`:216`、`:217`（ADR 指向的 `f7cbbf` 版本）**
- 问题：改名没有改全。ADR 0250 现在写退回图标是 `puzzle`、三个名字已改，但 ADR 自己链接的详细设计仍写旧名字和旧退回图标。将来 Apple 客户端若照这份设计实现，会与服务器端校验值不一致。
- 证据（`git show f7cbbf...:docs/execution/specs/2026-11-11-apple-device-body-design.md`）：
  - 第 208 行：“模型没给、或给的名字不在表里时，图标用 `tools`”
  - 第 213 行：`phone`、`checklist`
  - 第 216 行：`users`、`tools`
  - 第 217 行：`current-location`、`heart-rate-monitor`
- 当前工作区检出的这份文档还没有 PR 405 的“过程行”一节，所以工作区全文搜索搜不到旧名；但 ADR 明确链接到 `f7cbbf`，那里确实还是旧值。
- 建议：在 PR 405 的设计文档里同步改成 `clipboard-list`、`puzzle`、`heartbeat`，并把 ADR 0250 的链接换到更新后的提交；或者在该节加一条 2026-11-12 的改名更正，避免客户端按旧表实现。最好再加一条文档/代码一致性检查，把图标表与 `PROCESS_ACTIVITY_ICONS` 对齐。

**2. 严重度：低 — `apps/control-center/test/execution-view.unit.test.ts:575`**
- 问题：这条测试把 `activityIcon: "tools"` 改成 `"puzzle"`，但它不校验图标白名单，改不改都会通过，不能作为“改名改全”的证据。
- 证据：`apps/control-center/src/execution-view.ts:214` 只是 `activityIcon: record.activityIcon || previous?.activityIcon || ""`，不检查值；测试只断言后续合并结果。
- 建议：如果要让这条测试也守住改名，断言该值属于 `PROCESS_ACTIVITY_ICONS`；否则在改动说明里不要把它列为改名验证，真正的守卫是 `[ICON-1]`、`[ICON-2]` 和 golden fixture。

**3. 严重度：低（材料核对）— 作者说的测试提交 `5bd7c`**
- 问题：`git show 5bd7c` 返回 unknown revision；实际补测试的是 `18298c662`（“test(prompt): 按第 5 轮复核锁住退回图标名，并改掉测试里的旧名”）。
- 建议：更正材料里的提交号。

### 推测与未核实
- `clipboard-list`、`puzzle`、`heartbeat` 是否是 Tabler 图标库中真实存在的名字，以及 Apple 客户端是否接受这些名字：代码里只使用了字符串，仓库内没有 Swift 端图标映射，**未核实**。
- 作者说“2002 例测试全过、`check:prompt-prefix` 通过”：无法运行测试，**未核实**。
- 我无法用允许的命令重新计算 manifest 的 SHA-256；但两个变更的哈希恰好对应 `chat.process-icons-section` 和 `tools.activity-icon-parameter`，且清单有反向用例，**未复算**。

## 侧重检查

- **不可信输入 / 错误路径**：模型给的 `activityIcon` 先 `trim()`，再用 `PROCESS_ACTIVITY_ICONS.includes` 精确匹配；`puzzle` 本身在 36 个名字之内，未知值（测试里的 `rocket`）退回 `puzzle`。这条路径没有被改名破坏。
- **资源耗尽**：图标白名单固定 36 项，改名没有新增循环、动态集合或无界缓存；`activity` 的 80 字符截断和空白归一化没有变化。
- **不可撤销操作**：本次只改字符串常量、提示词、清单和测试，不涉及删除、迁移、对外发送或持久化格式变更。
- **安全**：没有新增密钥、日志或出口路径；提示词仍是静态文字，不引入每轮变化值。
- **规则 / 文档一致性**：发现上述详细设计旧名问题；工作区代码与 ADR 0250 本身一致。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   - 对老对话：不会。系统提示和工具按对话冻结（`.claude/rules/prompt-prefix.md` 第 6 条），这次只改提示词文字和参数说明文字，不改变工具名或去掉说明后的参数结构；而且整个过程图标功能在本 PR 才引入（`0d989` 上根本没有 `activity.ts`），尚未上线，所以没有生产老对话见过旧文字。
   - 对新对话：会使用新的系统提示和工具描述，但这属于新请求的开头，不是对已有请求的修改。
   - 请求排序仍只在末尾追加；没有把每轮变化的值放进系统提示或工具定义。改名本身没有新增任何每轮变化值。

2. **同一段文字会不会在不同请求里变成不同字节？**
   - 不会。图标名是固定常量，数组和提示词表格顺序固定；没有依赖前后文的遮盖、时间字段或无序集合。
   - 提示词文字变动会改变“自己写的固定文字”清单，理论上可能影响老对话的遮盖；但新旧图标文字里没有长数字串或敏感关键词，实际不应改变遮盖结果。

3. **有没有自动检查，反向用例真的会失败吗？**
   - 有：`prompt-catalog.unit.test.ts` 的 manifest 摘要检查，其反向用例 `PROMPT_MANIFEST_STALE` 在哈希未更新时确实会失败；`[ICON-1]` 用提示词表格与 `PROCESS_ACTIVITY_ICONS` 逐项相等，任一边漏改会失败；`[ICON-2]` 用真实 SQLite 和未知图标 `rocket` 锁住退回 `puzzle`；golden fixture 做完整请求体相等比较，漏改 fixture 会失败。
   - 新增的 `都不贴近时用 ${PROCESS_ACTIVITY_FALLBACK_ICON}。` 是正向字符串断言，不是反向用例；如果常量和文字一起错成旧值，它不会单独发现，需要靠 `[ICON-2]` 和 golden fixture 的硬编码期望兜底。
   - 文档与代码的一致性没有自动检查，所以上述旧设计文档不会让任何测试失败。

4. **改动产生的每个值，使用它的地方都能接受吗？**
   - `clipboard-list`、`puzzle`、`heartbeat` 产生于 `PROCESS_ACTIVITY_ICONS`，服务器端所有消费点都接受：`thread-execution-projection.ts:92-94` 按同一数组白名单放行，`thread-contracts-v3.ts:606` 的 `activityIcon` 是 `displayText`，接受任意有界字符串；网页 `execution-view.ts:214` 原样合并，不校验名字。
   - 退回值 `puzzle` 产生于 `PROCESS_ACTIVITY_FALLBACK_ICON`，同时用于参数说明、投影退回和 `[ICON-2]` 期望；这些两端目前一致。
   - 新增/修改的清单项 `chat.process-icons-section`、`tools.activity-icon-parameter` 的 SHA 已更新，清单测试能接受；`tools.activity-parameter` 不变，符合它没有改文字的情况。
   - 序列化方面，`d4-golden-requests.json` 两条请求体都改了，golden 比较能接受。
   - **例外**：ADR 指向的 Apple 客户端详细设计仍是旧值，那个消费端目前不能接受新名字，见发现 1。
