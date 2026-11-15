**本轮范围**

本轮查看了 `git diff 5834935d..5899d0d4` 的全部代码改动（6 个文件：`packages/platform-node/test/protected-runtime.unit.test.ts` 加 5 个 `.agents/reviews/pr-590` 复核记录），以及 `git diff 4e4d1cb4..5899d0d4` 的增量（只有该测试文件新增 `node:worker_threads` mock，其余是复核记录）。通读了 `packages/platform-node/test/protected-runtime.unit.test.ts`、`packages/platform-node/src/capabilities/protected-runtime.ts`、`protected-runtime-audit-worker.ts`、`scripts/delivery-mode/packet-template/systemd/S7-startup-readback.mjs`、`verify-startup-readiness-fixtures.mjs`、`test_make_packet.py` 相关段落，以及 `vitest.workspace.ts`、`ci/policy.json` 的项目隔离设置。用 `git show`/`git blame` 核对了 PR 571 的 8de0a1697、281835ded 和本 PR 的 ccb2bd69d、4e4d1cb4。上一轮判断记录未带入，无法逐条对照；只按作者描述和当前代码核对。

**读代码证实的**

- 作者说“只改一个测试”：代码改动确实只有 `packages/platform-node/test/protected-runtime.unit.test.ts`，另外 5 个是 `.agents/reviews` 记录，不影响运行时。
- `S7-startup-readback.mjs` 当前是 `const nonFatal = new Set(["memory.embedding_catch_up_failed"]);`，两个审计失败事件都不在放过名单里（`S7-startup-readback.mjs:64-66`）。
- 生产端会产出 `sandbox_runtime.content_audit_failed` / `sandbox_runtime.content_audit_retryable` / `sandbox_runtime.content_audit_completed`（`protected-runtime.ts:444-458`），读回正则包含 `failed` 和 `retryable`，不包含 `completed`，两者匹配。
- 新测试确实让 `verifyProtectedRuntime(..., { deferContentAudit: true })` 走真实摘要不一致路径：mock Worker 返回 `{ protected: true }` 使安装审计通过，传入的 digest 返回 `"c"*64` 而清单 digest 是 `"a"*64`，最终走到非瞬态失败并产出 `content_audit_failed`（`protected-runtime.ts:70-87`、`370-380`、`444-458`）。
- 原三条断言（failed 为真、retryable 为真、completed 为假）保留在 `protected-runtime.unit.test.ts:587-589`。
- 作者说 PR 571 把 `assert(!records.some(...))` 改成 `records.filter(...)`：`git show 8de0a1697` 确实新增了 `startupFailureEvents` 并把调用点改成 `assert.deepEqual(startupFailureEvents(records), [], ...)`；`281835ded` 再删掉 `!Object.hasOwn(item, "retryInMs") &&`，说法基本吻合。
- 增量新增的 mock `Worker` 实现了 `EventEmitter` 的 `once` 和 `terminate()`，与 `auditProtectedRuntime` 的消费方式兼容（`protected-runtime.ts:60-87`），本文件其他用例都显式注入 `fixture.audit` 或自定义 `audit`，没有别的用例依赖真实 Worker。

**推测/未核实**

- 没有运行测试（工具限制），作者所说“整个文件 40 个用例通过”“把 failed 加进 nonFatal 后用例失败”未实际验证；只能按代码结构推断。
- 下面意见 1 里“真实函数增加额外过滤时新用例可能仍然通过”是按代码结构推断，不是运行结果。

### 1. 中 — 新用例是按正则重建读回谓词，没有执行真实的 `startupFailureEvents`，存在假通过空间

- 文件:行：`packages/platform-node/test/protected-runtime.unit.test.ts:565-583`、`606`；`scripts/delivery-mode/packet-template/systemd/S7-startup-readback.mjs:64-67`；`scripts/delivery-mode/packet-template/systemd/verify-startup-readiness-fixtures.mjs:55-71`
- 问题：测试名字和 PR 描述说“从读回脚本取出的判断”“deploy start-up readback treats ... as failures”，但实际做的是用正则从源码里截出 `!nonFatal.has(...) && /.../.test(...)` 再拼一个谓词，并没有执行真实的 `startupFailureEvents`，也没有确认 readback 真的调用了它。现有 `verify-startup-readiness-fixtures.mjs` 已经用 `new Function` 执行真实函数，但它的致命事件列表里没有 `sandbox_runtime.content_audit_failed`，也没有 `content_audit_completed` 的反向用例；因此对这两个事件，当前唯一的自动检查就是这段重建谓词。
- 证据：读回脚本实际是
  `return records.filter((item) => !nonFatal.has(item.event) && /(?:failed|...|retryable)/i.test(String(item.event))).map(...)`（`S7-startup-readback.mjs:66`）。测试只做了
  `return (event) => !nonFatal.has(event) && failureEvents.test(event);`（`protected-runtime.unit.test.ts:582`）。如果真实函数在匹配的 `.filter` 之后再加一个 `.filter(...)`（例如排除 `platform-node` 组件或带 `durationMs` 的事件），测试的正则仍然能截到前半段，谓词仍然返回 true，用例不会失败，但部署读回的行为已经不同。现有夹具则走真实函数：
  `const startupFailureEvents = new Function(\`${source.slice(...)}\nreturn startupFailureEvents;\`)();`（`verify-startup-readiness-fixtures.mjs:58`）。`test_make_packet.py:1836` 只检查了 `assert.deepEqual(startupFailureEvents(records), [], ...)` 这行字符串存在，不检查上面的额外过滤。
- 建议：把 `sandbox_runtime.content_audit_failed`（以及 `content_audit_completed` 的反向断言）补进 `verify-startup-readiness-fixtures.mjs` 的真实函数用例；或者在新测试里沿用该夹具的 `indexOf("function startupFailureEvents(")` + `new Function` 方式执行真实函数，而不是重建谓词。行为用例仍可保留，用来证明生产端确实产出该事件名。
- 读代码证实的：上述谓词和夹具写法均已读到。推测/未核实：额外 `.filter` 导致假通过是按代码结构推断，未实际构造运行。

### 2. 低 — 行为用例只真实产出 `failed`，没有真实产出 `retryable`/`completed`；PR 571 收紧的 `retryable` 仍只靠写死字符串检查

- 文件:行：`packages/platform-node/test/protected-runtime.unit.test.ts:585-590`、`592-610`；`packages/platform-node/src/capabilities/protected-runtime.ts:444-458`
- 问题：测试名“treats failed and retryable deferred audits as failures, completed ones not”覆盖了三类，但行为用例只构造了摘要不一致这一种非瞬态失败，实际只产出 `content_audit_failed`。`content_audit_retryable` 和 `content_audit_completed` 只作为字面量喂给谓词测试；如果生产端把 `retryable` 改名成不含失败关键字的字符串，行为用例不会发现，谓词测试也仍然会用它写死的旧名字通过。PR 571 恰好收紧了 `retryable` 的放过规则，这一路径值得端到端覆盖。
- 证据：`protected-runtime.ts:450-455` 的三元表达式分别产出 `completed`、`superseded`、`retryable`、`failed`；行为用例只传 `async () => "c".repeat(64)`，最终 outcome 是 `ok: false, transient: false`，只命中 `failed`（`protected-runtime.unit.test.ts:596-606`）。
- 建议：再加一条瞬态路径用例：让 digest 连续抛出 `new Error("SANDBOX_HOST_DIGEST_WORKER_EXIT:1")` 两次（触发一次 retry 后仍失败），断言实际日志事件是 `sandbox_runtime.content_audit_retryable`，且读回判定为失败；成功路径可断言 `content_audit_completed` 且读回判定为不失败。
- 读代码证实的：三元表达式和测试输入已读到。推测/未核实：未实际运行，不能确认新增用例在当前代码上会通过。

**侧重检查**

- 错误路径：摘要不一致走非瞬态失败，不会重试，事件为 `failed`；Worker mock 的 `message`/`exit` 顺序符合 `auditProtectedRuntime` 的监听顺序（`queueMicrotask` 在监听器注册之后执行）；abort/timeout 路径本用例未涉及，mock 也没有模拟 abort，若将来用真实 Worker mock 覆盖 abort，需要让 `terminate()` 真正阻止 `message`。
- 不合规范或不可信输入：测试用正则和 `JSON.parse` 解析仓库内的读回源码；源码格式变化或非 JSON 的 `nonFatal` 列表会让 `expect(pattern).not.toBeNull()` / `JSON.parse` 直接失败，属于失败即停，不会静默放过；但这也带来对源码格式的耦合（意见 1）。
- 安全：改动仅在测试进程；mock 只让测试里的安装审计恒真，真实 `auditProtectedRuntime` 仍由 `protected-runtime-audit-worker.unit.test.ts` 覆盖（真实临时目录、权限、符号链接），没有削弱生产审计的门槛。
- 资源耗尽：mock 不创建真实线程；`#bounded` 的 600 秒定时器在审计返回后清除；若审计永远不结束，测试会先按 Vitest 超时失败，但残留的 600 秒定时器可能拖住进程，这是既有设计，本次未触发。
- 不可撤销操作：没有。
- 规则/说明/代码一致：`prompt-prefix.md` 约束的是发给模型的内容，本改动不涉及；`I-73` 这次核对的是 mock 的 `Worker`、环境变量键、事件名三个值，产生端和消费端都对照过，见必答问题 4。作者的 PR 571 描述和 nonFatal 名单描述与代码一致。

**必答问题**

1. **会不会改变模型已经见过的请求开头？** 不涉及。改动只有测试和复核记录，生产端的系统提示、工具定义、历史消息、遮盖逻辑都没有改；没有新增每轮变化的值，也不存在把内容插入请求开头的情况。按 `prompt-prefix.md` 的“已经发出的内容只能末尾追加”，本改动没有触碰这条规则的适用范围。
2. **会不会让同一段文字在不同请求里变成不同字节？** 不涉及。没有改生产序列化、JSON 键序、集合顺序或遮盖；测试里的 `"a".repeat(64)`、`"c".repeat(64)`、固定 manifest 和固定 `nonFatal` 都是确定的，`new Set` 只用于成员判断，不用于序列化。
3. **有没有自动检查，反向用例真的会失败吗？** 有检查：`protected-runtime.unit.test.ts:585-590` 检查谓词，`:592-610` 检查真实日志事件；反向场景按代码结构应当失败（把 `content_audit_failed` 加进 `nonFatal` 会让谓词测试和行为用例的读回断言同时失败；生产端改成 `completed` 会让 `toBe("...failed")` 失败）。但行为路径只覆盖 `failed`，`retryable`/`completed` 不是端到端产生；而且谓词是重建的，真实函数新增过滤时可能假通过（意见 1）。**没有实际运行测试，未核实实际红绿结果。**
4. **改动产生/修改的每个值，使用端都能接受吗？** 逐项核对如下，没有发现不兼容：
   - mock 导出的 `Worker`（`protected-runtime.unit.test.ts:17-32`）只被 `protected-runtime.ts:60-87` 消费，需要构造、`once("message")`、`once("error")`、`once("exit")`、`terminate()`；`EventEmitter` 提供 `once`，`terminate()` 返回 `Promise.resolve(0)`，都能接受。
   - mock 发出的 `{ protected: true }` 被 `protected-runtime.ts:72` 以 `value?.protected === true` 接收，能接受。
   - mock 发出的 `exit` 0 只在没有 `message` 时用于 `SANDBOX_RUNTIME_AUDIT_WORKER_EXIT:${code}`，能接受。
   - 测试写入的配置键 `HIMAWARI_RUNTIME_PROTECTION_FILE=manifestPath` 被 `verifyProtectedRuntime`（`protected-runtime.ts:423`）读取；`manifestPath` 是绝对且规范化的 `/etc/himawari/runtime.json`，能通过 `canonical()` 和构造校验，能接受。
   - 生产事件名 `sandbox_runtime.content_audit_failed`/`retryable`/`completed` 的产生端是 `protected-runtime.ts:450-455`，消费端是 `S7-startup-readback.mjs:64-66` 的 `nonFatal` 与正则；failed/retryable 被当失败，completed 不被当失败，两端一致。
   - 本改动没有新增或修改生产标识、字段、配置键、清单项或序列化格式。
