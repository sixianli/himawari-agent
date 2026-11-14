# 复核结论

## 作者说法核对

- “先遮盖后替换再截断”：**与代码一致**。`approvalBodyPreview` 是 `replaceDisallowedCharacters(maskSensitiveText(text))`，之后才按码点截断（`packages/application/src/services/approval-display.ts:27-31`）。
- “合同文案改成 tab, newline and carriage return”：**与代码一致**。校验允许 `0x0d`，报错文案也已同步（`packages/gateway-contracts/src/contracts-v2.ts:2218-2223`）。
- “合同给 displayTitle（301）、ruleText（2001）留出省略号位置”：**数值对，但目前没有生产者**。`displayTitle` 在生产 builder 里永远是 `null`（`apps/agent-service/src/production-approval-display.ts:81`），`ruleText` 也永远走不到 `rule` 分支（`packages/application/src/services/action-policy-service.ts:557`）。这两个上限目前没有实际被执行，也没有合同边界测试。
- “补了用例”：**有，但只覆盖了 U+202E、U+2066、U+200F 三个码点**（`apps/agent-service/test/production-approval-display.unit.test.ts:49-57`）；代码覆盖的 U+061C、U+200E、U+202A–D、U+2069 没有单独用例。
- “卡号放到截断边界”：**与代码一致**（`apps/agent-service/test/production-approval-display.unit.test.ts:34-46`）。该用例在“先截断后遮盖”时会失败，是有效反向用例。

---

## 问题（按严重度）

### 中：审批展示把线程标题和工具参数预览明文复制进审批记录，绕开了原有 payload 分类/加密保护

- 文件:行：`apps/agent-service/src/service-main.ts:1597-1607`、`packages/persistence-sqlite/src/sqlite-durable-operations.ts:1938`、`apps/agent-service/src/production-thread-titles.ts:113-123`、`packages/application/src/services/governance-gateway-adapter.ts:361-366`
- 问题：线程标题原本是带 `dataClassification` 的受保护 payload；发起审批时被解密后放进 `ApprovalDisplay.origin.threadTitle`，随后连同 `bodyPreview` 一起由 `JSON.stringify(request)` 写进 `approval_requests.record_json`。该列只是普通 JSON 文本，审批记录也没有分类字段；快照 envelope 的分类仍是 `maximumClassification("private", intent.dataClassification)`，并不考虑线程标题或预览内容本身的分类。
- 证据（亲自读到）：
  - `production-thread-titles.ts:113-122`：标题通过 `protector.protect({ ..., contentType: "text/plain", dataClassification: first.dataClassification, plaintext: ... })` 保存。
  - `service-main.ts:1600-1607`：审批时 `episodeProtector.unprotect(...)` 解密，并 `return title.trim() || null`。
  - `sqlite-durable-operations.ts:1938`：`JSON.stringify(request)` 写入 `record_json`。
  - `governance-gateway-adapter.ts:365`：快照分类用 `maximumClassification("private", intent.dataClassification)`，没有合并 `origin.threadTitle` 或 `bodyPreview` 的来源分类。
- 影响：敏感/受限对话的标题和工具参数片段在保留期内以明文存在于审批表；审批快照的分类可能低于其中文本的真实分类。属于“新值只在一端被信任”的 I-73 类问题。
- 建议：把展示内容作为带分类的受保护 payload 保存，审批记录只存 ref；或在写入时记录展示内容的最高分类并让快照 envelope 使用它。至少应在设计文档和代码里明确这条明文例外及其保留/删除范围。
- 说明：`payloads` 是密文、`approval_requests.record_json` 是明文 JSON 是读代码证实的；“这违反分类要求”是基于现有 payload 加密设计的推断，未找到明确的审批展示分类规范。

### 中：第 2 轮改的合同边界没有自动化保护，改回 2000 不会失败

- 文件:行：`packages/gateway-contracts/src/contracts-v2.ts:2229-2243`、`apps/agent-service/test/production-approval-display.unit.test.ts:71-78`、`test/integration/governance-control-center.test.ts:420-438`
- 问题：第 2 轮把 `bodyPreview` 上限改成 2001、`displayTitle` 改成 301、`ruleText` 改成 2001，但没有测试把“最大长度的展示值”交给网关合同校验。现有 2001 用例只测 builder 输出长度，不经过 `approvalDisplaySchema`；集成测试里的 `bodyPreview` 是短文本。
- 证据（亲自读到）：
  - `contracts-v2.ts:2229`：`APPROVAL_DISPLAY_BODY_MAX_CHARACTERS = 2001`。
  - `contracts-v2.ts:2232-2237`：`displayTitle: nullable(approvalDisplayText(301))`、`ruleText: nullable(approvalDisplayText(2001))`。
  - `production-approval-display.unit.test.ts:77`：`expect([...(shown.bodyPreview ?? "")].length).toBe(2001);`，只断言 builder。
  - `governance-control-center.test.ts:421`：`bodyPreview: approvalBodyPreview("rm -rf build\ncd ..\u001b[0m\u0000", 300)`，远小于 2001。
- 影响：把 `contracts-v2.ts` 的 2001 改回 2000，或把 301 改回 300，现有测试仍会通过。第 2 轮宣称修好的“省略号位置”没有回归门槛；`displayTitle`、`ruleText` 更是完全没有生产者测试。
- 建议：在 `packages/gateway-contracts/test` 增加 `approvalDisplaySchema`/`approvalSnapshotSchema` 的直接用例：`bodyPreview` 2001 通过、2002 失败，`displayTitle` 301/302，`ruleText` 2001/2002，`origin.threadTitle` 121/122；再加一个从 `createApprovalDisplayBuilder` 到 `approval.detail` 的长文本端到端用例。顺便加一条配置值真正传到 builder 的接线测试。

### 低：写入端不校验展示值，读取端合同才校验，且合同不接受的双向控制字符规则与 builder 不一致

- 文件:行：`packages/application/src/services/approval-display.ts:6-16`、`packages/gateway-contracts/src/contracts-v2.ts:2216-2219`
- 问题：生产 builder 会把 U+061C、U+200E、U+200F、U+202A–E、U+2066–69 换成 U+FFFD，但网关合同只拒绝 C0 控制字符和 DEL，不拒绝这些双向格式字符。也就是说，合同接受的输入范围比 builder 产出的范围宽。`displayTitle` 和 `ruleText` 不经过 `approvalBodyPreview`，如果将来有生产者直接填值，双向字符可以通过合同进入 UI。
- 证据（亲自读到）：
  - `approval-display.ts:10-14`：`code === 0x061c || code === 0x200e || code === 0x200f || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)`。
  - `contracts-v2.ts:2218`：只判断 `(code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f`。
  - `contracts-v2.ts:2232-2237`：`displayTitle`/`ruleText` 也走这个校验，但没有经过 builder 的替换。
- 影响：当前生产路径安全，但合同作为最后一道校验并没有守住 UI 重排风险；同时 `ActionPolicyService.approvalDisplay` 对 builder 返回值不做任何长度/字符校验，坏值要到读取 `approval.detail` 时才让整条快照校验失败。
- 建议：把“禁用的格式字符”提取成共享规则，合同和 builder 使用同一份；或在 `approvalDisplayText` 里拒绝双向控制字符。最好在写入审批前就校验/截断 `display`，不要等读取时抛错。

### 低：构建 display 之后只重查过期，不再重查 grant/capability，和代码注释“每次 await 后重读”不一致

- 文件:行：`packages/application/src/services/action-policy-service.ts:492-502`
- 问题：`await this.approvalDisplay(...)` 之前已经查过 grant/capability；await 之后只检查 `intent.expiresAt` 和 `approvalExpiresAt`，没有再重查 grants、capability 状态或 policy。如果 display 构建期间有并发 grant 生效或 capability 被禁用，仍会创建一个不必要的 pending approval。
- 证据（亲自读到）：
  - `action-policy-service.ts:492-495` 注释：`Re-read current policy, capability, approval, quota and expiry after every await`。
  - `action-policy-service.ts:496-502`：只有 `throwIfAborted`、`now >= intent.expiresAt`、`approvalExpiresAt <= now` 三项检查，没有重新 `listGrants` 或 `capabilities.inspect`。
- 影响：不是越权执行，最多是多弹一次审批或给已失效能力创建审批；安全上偏保守，但与注释声明的并发模型不一致。
- 建议：display 构建后重新跑一次轻量的 grant/capability 判断，或明确在注释里写明 display 阶段只保证过期，不保证授权事实不变。

---

## 侧重检查

- **错误路径**：`createApprovalDisplayBuilder` 捕获线程标题读取/解密失败并返回 `null`（`production-approval-display.ts:75-79`）；`ActionPolicyService.approvalDisplay` 再捕获 builder 整体失败并退化为空展示（`action-policy-service.ts:546-552`）。这一点读代码证实。
- **不合规范/不可信输入**：控制字符和双向格式字符在 bodyPreview/threadTitle 中被替换；但 `displayTitle`/`ruleText` 不经 builder，合同也不拒绝双向字符。卡号遮盖在截断前执行，方向正确；但“在卡号数字之间插入双向控制字符”是否会被 `maskSensitiveText` 识别，未验证，属推测风险。
- **资源耗尽**：`approvalBodyPreview` 对完整文本做 `[...text]` 两次（`approval-display.ts:19,27,29`），复杂度是 O(输入长度)。目前 coding 路径把参数限制在 48KB（`production-coding-workflow.ts:184,192`），Pi runner 输入上限约 128KB（`capability-programs/pi-coding-request.ts:17,42`），所以不是当前的主要耗尽风险；但线程标题 payload 在解码前没有长度上限，若标题 payload 异常大，仍可能造成一次性内存压力，这一点未核实。
- **不可撤销/删除**：`approval_requests.run_id` 是 `ON DELETE CASCADE`，永久删除对话时会删 runs，从而删审批；这与设计文档“对话删除时随运行一起删除”一致。但在删除发生前，标题/预览已经以明文存在于审批记录中，见上面的中危问题。
- **规则/文档一致性**：`.claude/rules/prompt-prefix.md` 的“只追加、会变的值放最后”没有被这次改动触碰；但 `docs/execution/specs/2026-09-10-control-center-local-acceptance-design.md` 说“唯一的例外是 display.bodyPreview”，代码同时把 `origin.threadTitle` 也写进了审批记录，文档没有覆盖这一点。
- **未核实**：我没有运行测试；`.agents/reviews/pr-428/round-2/judgments.md` 因工具限制未读到，只按代码核对了作者说明。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会。** 发给模型的内容仍然只在末尾追加，每轮会变的值也没有被塞进系统提示或工具定义。

依据：`ApprovalDisplay` 只进入审批端口和网关读模型（`packages/application/src/ports/authorization.ts:209-219`、`governance-gateway-adapter.ts:381-395`）。拿到 `ASK` 后真正回给模型的 `runtimeToolAuthorizationResult` 只包含 `approvalRequestId`、`semanticSnapshotHash`、`expiresAt` 和 `modelContent: ""`（`packages/application/src/services/runtime-tool-authorization.ts:7-19`），没有 `display`。全仓搜索 `ApprovalDisplay`/`bodyPreview`/`displayTitle` 也未发现它们进入 prompt 组装。因此系统提示、工具定义、历史都没有被改写；审批展示即使包含时间/标题，也不在模型请求里。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**不会引入模型请求层面的字节差异。** 审批展示在审批创建时一次性冻结，之后读的是同一条记录；`maskSensitiveText` 默认不带 tag，占位符是 `[银行卡]` 这类固定文本，不依赖前后消息，也没有时间字段或无序集合。线程改名后新发的审批会得到新标题，但旧审批记录的字节不变，而且这些都不进模型请求。

需要保留的差异：`origin.threadTitle` 取决于审批创建那一刻的线程状态，所以不同时间创建的两个审批可能不同；这不是“同一段文字在不同模型请求里变成不同字节”。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

**有部分检查，但第 2 轮最关键的合同边界没有被检查。**

已覆盖：
- builder：遮盖发生在截断之前、控制字符替换、双向字符替换、最大 2001 字符（`apps/agent-service/test/production-approval-display.unit.test.ts`）。
- 审批冻结/失败/过期：`test/integration/authorization-capability-governance.test.ts:1004-1068`。
- 网关投影与旧审批 `display: null`：`test/integration/governance-control-center.test.ts:406-442`。
- 配置范围：`packages/platform-node/test/startup-configuration.unit.test.ts:1842-1874`。

缺口：
- 没有测试让 2001 字符的 `bodyPreview` 真正通过 `approvalDisplaySchema`；把 `contracts-v2.ts` 的 2001 改回 2000 不会失败。
- `displayTitle` 的 301、`ruleText` 的 2001 没有生产者，也没有合同测试。
- `approvalBodyPreviewCharacters` 只测了解析，没有测它真的传到 `createApprovalDisplayBuilder`。
- 网关合同对双向字符的接受范围与 builder 不一致，没有反向用例。

所以：builder 层的反向用例是有效的；但第 2 轮“合同留出省略号位置”这一改动的反向用例**不会失败**。

### 4. 每个产生/修改的值，使用它的地方都能接受吗？

逐个核对：

- `bodyPreview`：builder 最大输出是 `min(配置, 2000) + "…" = 2001` 个码点；合同 `approvalDisplayText(2001)` 接受（`contracts-v2.ts:2229-2233`）。✓
- `origin.threadTitle`：builder 用 120 截断再加 `…`，最大 121；合同 `approvalDisplayText(121)` 接受（`contracts-v2.ts:2242`）。✓
- `displayTitle`：合同允许 301，但生产 builder 永远返回 `null`，没有生产者；目前不会失败，但也未被验证。⚠
- `ruleText`：合同允许 2001，但 `ActionPolicyService` 永远输出 `no_rule_allows`，`rule` 分支没有生产者；适配器支持该分支（`governance-gateway-adapter.ts:386-392`），但全链路未验证。⚠
- `approvalBodyPreviewCharacters`：`strict-configuration.ts:1399-1408` 产生 1–2000，`production-file-read-services.ts:61-63` 消费；两端范围一致。✓（但缺少接线测试）
- `approval.display`：`ApprovalRequest` 本身没有该字段，只有 `GovernedApprovalRequest` 有；持久化用 `JSON.stringify(request)` 能保留，读取时 `governance-gateway-adapter` 对旧记录映射为 `null`。✓
- 网关合同要求 `display` 字段必须存在；所有手工审批快照夹具已补 `display: null`，适配器也总是输出该键。✓
- 两端不一致处：合同接受双向控制字符，builder 会替换它们（见低危问题）；审批记录没有携带展示内容的分类（见中危问题）。

总体结论：这次增量在模型请求前缀上没有风险；主要问题集中在审批展示的**分类/明文持久化**和**第 2 轮合同边界的测试保护**。
