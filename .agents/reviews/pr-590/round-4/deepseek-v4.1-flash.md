范围：本轮读取了 `git diff 5899d0d..22bdee4` 的增量（只改测试文件与 `.agents/reviews` 记录），并对照了 `packages/platform-node/src/capabilities/protected-runtime.ts`、`sandbox-host-verifier.ts`、`S7-startup-readback.mjs`、`verify-startup-readiness-fixtures.mjs`、`test_make_packet.py`、`ci/rules/semgrep.yml`、`scripts/ci/check-security.mjs`、`ci/policy.json`、`vitest.workspace.ts`。未运行测试或检查。

### 1. [低] 行为用例只把 `content_audit_failed` 的生产端接到读回端，`retryable` 等其余生产事件仍只是字面量
文件:行：`packages/platform-node/test/protected-runtime.unit.test.ts:583-588`、`:590-604`；`packages/platform-node/src/capabilities/protected-runtime.ts:449-455`；`scripts/delivery-mode/packet-template/systemd/S7-startup-readback.mjs:64-66`
问题：新增的端到端用例只真实产出 `sandbox_runtime.content_audit_failed`。`retryable` 只用硬编码字符串直接喂给读回函数，生产端把 `content_audit_retryable` 改名后，所有用例仍会通过，而 S7 启动读回将不再把它当成致命失败。上一轮低意见按提交信息明确未改。
证据：
```ts
expect(isFailure("sandbox_runtime.content_audit_retryable")).toBe(true);
...
expect(settledEvent()).toBe("sandbox_runtime.content_audit_failed");
expect(startupReadbackTreatsAsFailure()(String(settledEvent()))).toBe(true);
```
```ts
event: outcome.ok
  ? "sandbox_runtime.content_audit_completed"
  : outcome.superseded
    ? "sandbox_runtime.content_audit_superseded"
    : outcome.transient
      ? "sandbox_runtime.content_audit_retryable"
      : "sandbox_runtime.content_audit_failed",
```
读回侧匹配的是：
```js
/(?:failed|failure|error|timeout|lost|quarantined|child_exit|child_error|retryable)/i
```
【读代码证实】生产端 `retryable` 事件没有对应的端到端用例；`git grep` 只在读回脚本和测试字面量里找到它。【推测】若生产端把它改成 `content_audit_transient` 之类不含匹配词的名字，本次改动不会失败。
建议：改成表驱动，逐一让 `verifyProtectedRuntime` 产生 `completed`、`failed`、`retryable`、`superseded` 等结果，抓取真实 `console.error` 事件，再统一交给读回函数判断；或抽出“结果 → 事件名”的单一映射并对所有分支穷举。这样生产值和读回值两端都被覆盖。

### 2. [低] 作者说法与当前代码不一致：已不再“取正则”，也没有单独核对 nonFatal 名单
文件:行：`packages/platform-node/test/protected-runtime.unit.test.ts:565-581`
问题：材料里写“新用例按新写法取正则，核对 nonFatal 名单不含两个审计失败事件”。当前 head 的实际做法是从读回脚本截出整个 `startupFailureEvents` 函数并执行，不再提取正则；`nonFatal` 只是被间接执行，没有独立断言。若这段描述指第 2 轮历史，则与本次增量无关；若指当前 head，则记录不准确。
证据：
```ts
const start = readback.indexOf("function startupFailureEvents(");
const end = readback.indexOf("\nfunction ", start + 1);
...
const startupFailureEvents = new Function(
  `${readback.slice(start, end)}\nreturn startupFailureEvents;`,
)() as (records: readonly { event: string }[]) => string[];
```
【读代码证实】代码路径已改为执行完整函数；`nonFatal` 没有独立断言。
建议：更新复核记录描述；如需保留“nonFatal 名单不含审计失败事件”的门槛，在用例里显式断言 `memory.embedding_catch_up_failed` 不被当失败，或让第一张表覆盖该负例。

**上一轮意见核对**：上一轮“只截半个正则表达式、真实函数再加过滤会漏”的中等意见已改好，`startupReadbackTreatsAsFailure` 现在执行完整函数（`protected-runtime.unit.test.ts:573-579`）；上一轮“retryable 只有字面量检查”的低意见未改，见意见 1。增量本身未发现新的功能错误。

**侧重检查**
- 错误路径：摘要不一致 → 非瞬时错误 → `settled(false,false)` → `content_audit_failed` → 读回函数判失败，这条链已由新用例覆盖。瞬时/retryable 链的消费端代码已核对，生产端到消费端仍未闭环（意见 1）。
- 不可信输入与安全：新测试用 `new Function` 执行仓库内受控脚本片段，属于测试代码；semgrep 只扫 `apps/*/src`、`packages/*/src`、`scripts/ci/*.mjs`（`scripts/ci/check-security.mjs:521-526`），不会扫这个测试文件；仓库已有多个测试使用 `new Function`，不是新增的检查违规。
- 资源耗尽：Worker mock 不创建真实线程，`message`/`exit` 在同一 microtask 发出；`vi.waitFor` 有超时，未发现泄漏或无限等待。
- 不可撤销操作：测试只读文件、改的是被 `vi.stubGlobal` 替换过的 `process.env`，`afterEach` 会恢复；没有写文件或外部副作用。
- 规则/文档一致：不涉及模型请求组装，`prompt-prefix` 规则不适用；`ci/policy.json` 的 `unit` 项目包含 `packages/**/*.unit.test.ts`，新用例会进入 CI；`biome.json` 未排除该测试文件，semgrep 规则也不覆盖它。

**必答问题**
1. 不会。改动只涉及测试和复核记录，没有碰系统提示、工具定义、历史、遮盖或请求组装；发给模型的内容仍然只在末尾追加、每轮变化值仍在最后一条消息的判断依据未被本改动触及。
2. 不会。没有改动请求序列化；新测试里的 `durationMs`、`pid` 只出现在 `console.error` 日志，不进入模型请求。测试读取并执行同一份脚本片段，本身是确定的。
3. 有自动检查：新增读回函数用例和行为用例。反向设计上会失败：读回函数不把 `failed` 当失败、生产改成 `completed` 或无关名字，断言都会失败。未实际运行，标注为未核实；`retryable` 的生产端到端反向用例仍缺（意见 1）。
4. 增量没有新增生产值。新增的测试值已核对使用端：Worker mock 的 `message { protected: true }` 被 `auditProtectedRuntime` 的 `value?.protected === true` 接受（`protected-runtime.ts:70-73`），`exit 0` 被接受；helper 的 `records[].event -> string[]` 契约与读回脚本一致。生产事件值中 `failed` 两端已连接；`retryable` 等仍只有读回端，见意见 1。
