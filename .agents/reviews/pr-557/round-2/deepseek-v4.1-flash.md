查过范围：`git diff 15d2ab530..4e02eda7f` 的全部增量（实际代码改动只有 `test/integration/product-path-browser.test.ts` 的 `accept-phone-send`，其余是复核记录）、`git show 5f2025ce5` 与 `1b3c672b9` 的提交说明、`.chat-turn` 的渲染代码、`UI.turn`/`PLAIN_ANSWER` 的定义与使用端、`DELIVERY_MODE` 和快速模式规则。未重读与本次增量无关的旧代码。

### 1. 低：代码提交 5f2025ce5 仍然缺少 `Fast-mode-checks:`，上一轮意见 5 没有改好
文件:行：`.agents/instructions/delivery-mode.md:32`；提交 `5f2025ce5`（`git show`）
问题：仓库 `DELIVERY_MODE` 是 `fast`，规则要求提交说明用一行 `Fast-mode-checks:` 写出实际运行过的基本检查、主机和版本。`5f2025ce5` 只有 `Layer-0-tests: none`，没有这一行；后面的 `4e02eda7f` 虽然有，但只是复核记录提交，不能替代码提交补检查声明。
证据（已读代码证实）：`DELIVERY_MODE` 内容为 `fast`；`git show 5f2025ce5` 的说明只有 `Layer-0-tests: none`，没有 `Fast-mode-checks:`。
建议：在代码提交或最终 squash 后的提交里补上 `Fast-mode-checks:`，如实写明实际跑过的检查、主机和版本；确实没跑也要明确写 none 及原因，不要把“靠 Hermes 重跑”写成已经检查过。

### 2. 低：本次材料里的作者说法描述的是已被替换的稳定循环方案，与当前代码不一致
文件:行：`test/integration/product-path-browser.test.ts:6021-6029`
问题：材料说“发送前循环数、连续三次间隔 500 毫秒不变后取基线，发送后断言基线+1，断言不变”；当前代码已经删除了循环和基线，改成按用户文本定位新轮次并在该轮里断言 `PLAIN_ANSWER`。旧说法对应提交 `1b3c672b9`，新代码对应 `5f2025ce5`，两者不是一回事。
证据（已读代码证实）：当前 `6021-6029` 没有 `answersBefore`、没有 `waitForTimeout`，而是 `sentTurn = phone.locator(UI.turn).filter({ hasText: text }).last()`，再断言 `sentTurn.getByText(PLAIN_ANSWER)`；`5f2025ce5` 的提交说明写的也是“按用户文本定位新的一轮”，与材料中的描述不一致。
建议：更新复核材料/PR 说明，避免后续按旧方案理解本次修复。

### 3. 低（推测）：按 `.last()` 取轮次时，乐观发送的 outgoing 轮会先被选中，建议显式排除
文件:行：`test/integration/product-path-browser.test.ts:6028`；`apps/control-center/src/components/chat-history.tsx:349-363`；`apps/control-center/src/thread-control-center.tsx:1542-1544`
问题：`.chat-turn-outgoing` 也是 `.chat-turn`，同样包含用户文本，而且渲染在真实轮次之后。点击发送后、用户消息提交前，`.filter({ hasText: text }).last()` 会先指向这个没有回答的 outgoing 轮。正常流程下用户消息提交后 outgoing 会被清除，Playwright 会重试并最终落到真实轮次，所以这不是已确认的失败；但如果 outgoing 的清理条件不成立（例如 messageId 不匹配），表现会是 120 秒超时，而不是直接暴露“发送未提交”。
证据（已读代码证实）：`chat-history.tsx:349-363` 渲染 `<div className="chat-turn chat-turn-outgoing">`，其中包含 `OwnerMessage content={outgoing.content}`；`thread-control-center.tsx:1542-1544` 只有在 `committedMessageIds` 包含 `outgoing.messageId` 时才清空 outgoing。上述时序属于由代码推出的风险，尚未在浏览器中复现。
建议：定位真实轮次时排除乐观轮，例如 `.chat-turn[data-run-id]` 或 `.chat-turn:not(.chat-turn-outgoing)`，这样就不依赖 outgoing 的清理时序。

## 侧重检查
- 错误路径：发送失败或回答不出现时，新代码有 20 秒和 120 秒的有界等待，不会无限循环；没有新增不可撤销操作。
- 不合规范/不可信输入：改动只使用固定测试字面量，不接收外部输入；`filter({ hasText })` 使用固定中文文本，不存在正则注入。
- 安全：没有新增网络、凭据、文件写入或日志输出。
- 资源耗尽：上一轮的无上界稳定循环已经删除，这是实质性改进；新的等待都由超时限制。
- 规则/文档一致性：发现两项，即上面的 `Fast-mode-checks` 缺失和作者说法与代码不一致。
- `UI.turn`/`PLAIN_ANSWER` 使用端：已用 grep 找到定义和直接使用端，未发现新的不一致。

## 未核实与推测
- 未核实：当前环境不能运行真实浏览器验收，无法确认 Hermes 上新场景的真实通过情况，也无法验证 Playwright 在实际页面上的重试表现。
- 推测：`outgoing` 轮与真实轮短暂重叠时的 `.last()` 选中问题，如意见 3 所述；按代码时序看正常流程应能恢复，因此不作为已确认缺陷。
- 未核实：重复出现同一句“手机上发一条消息”时用文本定位可能误选旧轮，但 `installProductPath` 每次在新建临时目录安装（`test/fixtures/product-path-harness.ts:571`），当前场景没有重复执行，因此该风险不成立。

## 逐条回答必答问题
1. 不改变。改动只在测试断言，没有修改系统提示、工具定义、历史消息或遮盖结果；发给模型的内容仍只在末尾追加，会变的本轮内容仍然只在最后一条用户消息里。
2. 不涉及。测试没有引入遮盖、时间字段或无序集合，文本是固定字面量，不会让同一段文字在不同请求里变成不同字节。
3. 该改动本身就是发布验收场景，没有独立的单元级反向用例；`test/tooling/release-walkthrough-coverage.test.mjs:91-100` 只检查场景名和场景体是否存在，不检查定位逻辑。答案不出现时理论上会超时失败，但真实反向运行在 Hermes 上，本轮未核实。
4. 增量没有新增导出函数、配置键、字段或序列化格式。它使用的 `UI.turn` 定义为 `.chat-turn`（`apps/control-center/test/release-walkthrough-ui.ts:31`），控制中心确实渲染该类（`apps/control-center/src/components/chat-history.tsx:190`、`:350`）；`PLAIN_ANSWER` 由普通文本触发（`test/integration/product-path-browser.test.ts:5552`），新断言读取的正是这个值，两端一致。
