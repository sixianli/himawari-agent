## 读代码证实的

### [中] 生产端与网关端的长度上限各自定义，没有共享常量，也没有跨端自动用例（I-73 类风险）
- 位置：`packages/application/src/services/approval-display.ts:3-4`、`apps/agent-service/src/production-approval-display.ts:68-85`、`packages/gateway-contracts/src/contracts-v2.ts:2230-2244`
- 问题：生产端的正文上限是 2000，截断时还会额外加一个 `…`，实际最长 2001；网关端又把“最长 2001”直接写成独立常量。标题同理：生产端用 120，网关端写 121。两端现在数值刚好对齐，但关系（+1）只存在于人脑里：改任一端不会让另一端失败，也不会让现有测试失败。一旦不一致，`approval.detail` 在 `parseSnapshot` 处直接抛 `ContractValidationError`，该审批在控制中心就打不开。
- 证据：
  - `approval-display.ts:30-31`：`if (characters.length <= maximumCharacters) return masked; return \`${characters.slice(0, maximumCharacters).join("")}…\`;`
  - `contracts-v2.ts:2230`：`export const APPROVAL_DISPLAY_BODY_MAX_CHARACTERS = 2001;`
  - `contracts-v2.ts:2233-2244`：`displayTitle: nullable(approvalDisplayText(301))`、`bodyPreview: nullable(approvalDisplayText(APPROVAL_DISPLAY_BODY_MAX_CHARACTERS))`、`threadTitle: nullable(approvalDisplayText(121))`
- 建议：让网关上限由同一个来源推导（例如 `APPROVAL_BODY_PREVIEW_MAXIMUM_CHARACTERS + 1` 放进共享常量/生成脚本），并新增一条端到端用例：用配置最大值 2000 走 `createApprovalDisplayBuilder` → 写审批 → `GovernanceGatewayV2ReadModel` → `gatewayV2MessageSchema.parse`。现有合同用例只单独测 schema，builder 用例只单独测长度，二者没有连起来。

### [中] 新增的关键行为缺少反向自动用例
- 位置：`apps/agent-service/src/service-main.ts:1599-1604`、`test/integration/authorization-capability-governance.test.ts:1004-1068`
- 问题一：第 3 轮声称“标题 payload 分级只允许 public/private 才返回标题”，但没有任何测试走 `approvalThreadTitle` 这条真实读取路径；`production-file-read-workflow.unit.test.ts:179` 是直接注入 `threadTitle: async () => "周五去大阪"`，绕过了分级判断。把 `!["public", "private"].includes(...)` 删掉，现有测试不会失败。
- 问题二：第 3 轮声称“展示构造完成后授权、能力、过期都重查”，但新增的三条策略用例只覆盖：构造一次、构造失败为空、构造期间时钟推进到过期。没有一条用例在 display 回调里让 capability/授权失效；把“能力/授权”这部分重查退回第 2 轮写法，`denies instead of storing...` 这条仍会通过。
- 证据：
  - `service-main.ts:1599-1604`：`!payload || payload.contentType !== "text/plain" || !["public", "private"].includes(payload.dataClassification)`
  - `authorization-capability-governance.test.ts:1061-1067`：只做了 `f.clock.set(T1)`，然后断言 `DENY` 和没有审批。
- 建议：补两条用例：1）标题 payload 分级为 `sensitive`（及缺失/非 text-plain）时 `approvalThreadTitle` 返回 null；2）在 display 回调里撤销 capability（或改变 grant），断言最终 `DENY` 且不落审批。

### [低] 策略层不校验展示字段，坏数据要等到读取网关快照时才炸
- 位置：`packages/application/src/services/action-policy-service.ts:543-560`、`packages/application/src/services/governance-gateway-adapter.ts:381-395`
- 问题：`approvalDisplay` 对 builder 返回值只做冻结，不检查长度、控制字符或字段类型；持久化照单全收。目前唯一生产调用方是 `createApprovalDisplayBuilder`，所以暂时安全；但只要以后有第二个调用方传入未清洗字符串，审批会成功写入，之后 `approval.detail` 解析失败，用户无法查看/处理这条审批。
- 证据：`action-policy-service.ts:554-559` 只有 `displayTitle: input.displayTitle, bodyPreview: input.bodyPreview, origin: input.origin, askedBecause: ...`；`validation.ts:179-180` 对对象字段是 `missing required field` 且未知字段直接拒绝，长度/控制字符由 `contracts-v2.ts:2211-2226` 另行拒绝。
- 建议：在策略层或统一的审批序列化入口再做一次 clamp/清洗（或直接复用 `approvalBodyPreview`），让“写入合法”和“读取合法”不依赖调用方自觉。

### [低] 文档只描述了 `bodyPreview`，没有写 `origin.threadTitle`，也没写 2000+1 的关系
- 位置：`docs/execution/specs/2026-09-10-control-center-local-acceptance-design.md:39`
- 问题：文档说“唯一的例外是审批详情的展示字段 `display.bodyPreview`”，但实际还会保存并投影 `display.origin.threadTitle`（同样可能是对话内容）。文档同时写“上限 2000”，而网关实际接受 2001 个字符（因为末尾省略号）。这不是代码错误，但说明文档与实现的边界没有被完整写清。
- 证据：`production-approval-display.ts:83-85` 返回 `origin: { threadId, threadTitle }`；`approval-display.ts:31` 截断后追加 `…`。
- 建议：把 `origin.threadTitle` 和“截断后最多 +1 个字符”补进设计文档，避免后续维护者按文档改坏合同。

## 推测

### [低-推测] 大参数会同步全量扫描，可能拖慢授权
- 位置：`packages/application/src/services/approval-display.ts:27-31`、`apps/agent-service/src/production-approval-display.ts:19-30`
- 问题：`approvalBodyPreview` 先对**完整**文本执行 `maskSensitiveText` 并做字符替换，最后才截断。`write` 的 `content` 可能是整份大文件，`edit` 可能包含很多条改动；这会在授权关键路径上同步扫描/拼接全部内容，存在延迟或事件循环阻塞风险。
- 证据：`approval-display.ts:27`：`const masked = replaceDisallowedCharacters(maskSensitiveText(text));` 之后才在 29-31 行截断。
- 建议：先对输入做有界的预截断（保留足够重叠以处理跨切口的秘密），或限制可展示参数的最大扫描长度。

### [低-推测] display 构造在授权关键路径上，且没有超时/取消传递
- 位置：`apps/agent-service/src/service-main.ts:1587-1612`、`packages/application/src/services/action-policy-service.ts:499-500`
- 问题：标题读取要查线程、取 payload、解密；`ActionPolicyService` 只在 `await build()` 之后才检查 `signal`，没有把 `signal`/超时传给 builder。如果存储或解密卡住，审批创建会被拖住。
- 证据：`action-policy-service.ts:499-500`：`options.builtDisplay = await this.approvalDisplay(options.display); options.signal?.throwIfAborted();`
- 建议：给 builder 传入 `AbortSignal` 或加超时，超时按“展示为空”处理。

### [低-推测] 重查递归传入的是未冻结的 `source`，与其它递归不一致
- 位置：`packages/application/src/services/action-policy-service.ts:501`
- 问题：其它重查路径传的是已冻结的 `intent`（495、526 行），这里传 `source`。如果调用方在 display 构造期间修改了 `source`，第二轮会基于新对象重新冻结，可能评估到与生成 display 时不同的 intent。当前调用方都传普通对象且不并发修改，所以只是潜在风险。
- 证据：`501`：`return this.evaluateCurrent(source, options, allowReview);`；`495`：`return this.evaluateCurrent(intent, options, false);`
- 建议：统一传 `intent`。

### [低-推测] 新 `display` 是必填键，版本偏斜时不兼容
- 位置：`packages/gateway-contracts/src/contracts-v2.ts:2248-2261`、`packages/gateway-contracts/src/validation.ts:179-180`
- 问题：`display: nullable(...)` 允许 `null`，但键必须存在。新客户端解析旧服务端发出的 `approval.snapshot` 会因 `missing required field` 失败。若发布过程不能保证两端同时升级，需要容忍缺失。
- 建议：如果存在滚动升级/版本偏斜场景，改为可选字段或在客户端做兼容读取。

## 侧重检查

- **错误路径**：display 构造异常会被吞掉并落空展示（`action-policy-service.ts:547-552`），审批仍可创建，符合“展示不是授权”的设计；但坏数据绕过 builder 时会在读取端失败（见上）。
- **不合规范/不可信输入**：工具参数进入 `approvalBodyPreview` 后先做出口遮盖且替换了 C0/DEL 与主要 bidi 字符（`approval-display.ts:6-22`），网关又拒绝除 tab/LF/CR 外的控制字符（`contracts-v2.ts:2217-2219`）。U+2028/U+2029 和部分零宽字符（如 U+200B、U+FEFF）两边都不拒绝，属于可选加固点，不构成当前合同失败。
- **安全**：标题读取只允许 `public`/`private` payload（`service-main.ts:1599-1604`），敏感标题不会进入审批展示；正文展示继承审批 envelope 的分级（`maximumClassification("private", intent.dataClassification)`），未发现越权读取路径。展示内容会以明文 JSON 存入 `approval_requests.record_json`，这是设计明确接受的取舍。
- **资源耗尽**：见“大参数全量扫描/无超时”两条推测。
- **不可撤销操作**：本改动只新增展示数据，不改变审批/授权判定；重查使授权更保守，没有引入新的不可撤销动作。
- **规则/文档与代码一致性**：`.claude/rules/prompt-prefix.md` 未被改动；设计文档与代码有一处描述不完整（见上）。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。本次 0d989..190 的净改动只涉及审批展示、配置、网关读模型和测试，未触及系统提示、工具定义、历史消息或遮盖逻辑。`display` 只写入审批记录并通过 `approval.snapshot` 投影（`governance-gateway-adapter.ts:381-395`），不进入模型请求；标题读取也只用于展示（`service-main.ts:1587-1613`）。因此发给模型的内容仍然只在末尾追加，没有新增“每轮会变的值”进入请求开头。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   不会影响到模型请求。`maskSensitiveText` 走 `redactForEgress(input)` 的默认、确定性路径，不依赖前后文（`redaction.ts:542-544`）；展示在审批创建时冻结一次，后续重查不会重写已有审批。`display` 没有时间字段或无序集合。唯一需要留意的是生产端/网关端上限是两份独立常量（见第一条），但那是审批展示合同问题，不是模型请求字节问题。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有一部分：
   - 网关合同上限/上限加一、控制字符用例已加（`packages/gateway-contracts/test/gateway-v2.contract.test.ts:230-277`），改坏长度或控制字符限制会失败。
   - builder 的遮盖、截断、失败兜底用例已加（`apps/agent-service/test/production-approval-display.unit.test.ts`）。
   - “构造只做一次”和“构造期间过期则拒绝且不落审批”的用例已加（`authorization-capability-governance.test.ts:1004-1068`），去掉 `builtDisplay` 守卫或过期重查会失败。
   - **缺口**：标题分级 gating 没有用例；展示构造后“能力/授权重查”没有反向用例；builder 输出与网关 schema 没有跨端用例。见上文第二条和第一条。

4. **改动产生或修改的每个值，每个使用它的地方都能接受吗？**
   逐个核对结果：
   - `display` 字段：产生于 `ActionPolicyService`（`action-policy-service.ts:504-524`），持久化在 `approval_requests.record_json`（`sqlite-durable-operations.ts:1938`），由读模型投影为 `null` 或对象（`governance-gateway-adapter.ts:381-395`），网关 schema 接受（`contracts-v2.ts:2232-2246`）。旧审批无 `display` 时读模型输出 `null`，已更新夹具和 legacy 用例，能接受。
   - `approvalBodyPreviewCharacters`：产生于严格配置解析（`strict-configuration.ts:1399-1408`，1..2000），只被 `production-file-read-services.ts:61-62` 读取并交给 builder，builder 再 clamp 到 2000，两端能接受。
   - `APPROVAL_BODY_PREVIEW_MAXIMUM_CHARACTERS` / `APPROVAL_DISPLAY_BODY_MAX_CHARACTERS`：前者用于配置校验和 builder clamp，后者用于网关长度；数值当前兼容，但没有机械保证，属于 I-73 类风险。
   - `displayTitle`/`bodyPreview`/`askedBecause`/`origin`：当前唯一生产者的输出（`displayTitle` 恒为 null、正文最多 2001、标题最多 121、`askedBecause` 恒为 `no_rule_allows`）都能通过网关校验。风险在于策略层没有复查，未来第二个生产者可能写入网关不接受的值。
