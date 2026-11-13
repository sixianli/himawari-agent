以下结论基于读代码与 `git diff a735795..e614dea`（以及第 1 轮修复提交 `e9bb7ec`、`0039937`）；受工具限制**没有运行任何测试**，涉及“用例会不会失败”的判断是静态阅读得出的。

## 问题清单（按严重度从高到低）

### 1. 中（潜在）：合约上限与生产端截断各写一份，`displayTitle`/`ruleText` 没给省略号留位置
- 文件：`packages/gateway-contracts/src/contracts-v2.ts:2229-2243`、`packages/application/src/services/approval-display.ts:3-4,17-24`、`apps/agent-service/src/production-approval-display.ts:67-85`
- 问题：生产端截断时**一定**追加 `…`，而合同只给 `bodyPreview`/`threadTitle` 预留了 `+1`，`displayTitle` 和 `ruleText` 没有。
- 证据（亲自读到）：
  - `contracts-v2.ts:2229`：`export const APPROVAL_DISPLAY_BODY_MAX_CHARACTERS = 2001;`
  - `contracts-v2.ts:2232-2233`：`displayTitle: nullable(approvalDisplayText(300)), bodyPreview: nullable(approvalDisplayText(APPROVAL_DISPLAY_BODY_MAX_CHARACTERS)),`
  - `contracts-v2.ts:2237,2242`：`ruleText: nullable(approvalDisplayText(2000)),`、`threadTitle: nullable(approvalDisplayText(121)),`
  - `approval-display.ts:23-24`：`if (characters.length <= maximumCharacters) return masked; return \`${characters.slice(0, maximumCharacters).join("")}…\`;`
  - `production-approval-display.ts:84`：`threadTitle: title === null ? null : (approvalBodyPreview(title, 120) ?? null)`（120+…=121，刚好对上；`displayTitle`/`ruleText` 没有对应的 -1 处理）
- 读代码证实：当前 `displayTitle` 恒为 `null`（`production-approval-display.ts:81`），`askedBecause.kind === "rule"` 也从不产生（全仓只有合同和适配器出现 `kind: "rule"`），所以现在不会炸。但初始提交说明写明“displayTitle 暂为 null，等 activity 能带到意图后接上”；接上时若沿用 `approvalBodyPreview(text, 300)` / `(text, 2000)`，会产出 301/2001，被合同拒绝，`approval.detail` 整个查询失败、审批在控制中心打不开。这正是 I-73“值只在一端认”的形态。
- 建议：让合同上限由同一个导出常量推导（producer max + 1），或让 `approvalBodyPreview` 与合同共享一组常量；补 `displayTitle`/`ruleText` 的 max 与 max+1 边界往返用例。

### 2. 中（潜在）：`display` 只有读端合同校验，写入端不校验
- 文件：`packages/application/src/services/action-policy-service.ts:542-559`、`packages/gateway-contracts/src/contracts-v2.ts:2210-2245`
- 问题：`ActionPolicyService.approvalDisplay` 接受任意 `ApprovalDisplayInput` 原样落库，`approvalBodyPreview` 的清洗只发生在 `createApprovalDisplayBuilder` 内；一旦有调用方绕过 builder（测试已经这么做了，未来 activity 标题、新工具也会），就能写入合同不接受的值，失败表现是**整条 `approval.detail` 查询抛 `ContractValidationError`**，而不是“预览差一点”。
- 证据（亲自读到）：
  - `action-policy-service.ts:547-558`：`input = await build(); ... return Object.freeze({ displayTitle: input.displayTitle, bodyPreview: input.bodyPreview, origin: input.origin, askedBecause: Object.freeze({ kind: "no_rule_allows" as const }), });`（没有长度/控制字符校验）
  - `contracts-v2.ts:2212-2225` 才对长度、控制字符做严格校验。
- 读代码证实：当前生产的两条路径（coding、file-read）都走 builder；所以是潜在问题，不是现状缺陷。
- 建议：在落库前用同一个 helper 清洗/断言，或把 `ApprovalDisplayInput` 做成只能由 builder 产生的 branded type，并加一条“直接注入超长/带控制字符 display，`approval.detail` 仍可用或明确拒绝”的负向用例。

### 3. 低：遮盖顺序的用例并不能证明“先遮后截”
- 文件：`apps/agent-service/test/production-approval-display.unit.test.ts:38-48`
- 问题：卡号完全落在截断后保留的部分，**先截断再遮盖也会通过**；只有把遮盖整个删掉才会失败。作者说“遮盖用例改成能在遮盖被删时失败”成立，但无法守住“先遮盖再截断”。
- 证据（亲自读到）：
  - `maximumCharacters: 60`
  - `arguments: { command: \`echo 4111 1111 1111 1111 ${"x".repeat(100)}\` }`
  - `expect(shown.bodyPreview).not.toContain("4111");`
- 建议：把卡号放到截断边界（例如从第 52 个字符开始），这样“先截断”会留下可识别的 `4111…`，用例才会失败；再补一条“秘密跨过截断边界”的用例。

### 4. 低（潜在，安全）：未处理 Unicode 双向/格式控制字符
- 文件：`packages/gateway-contracts/src/contracts-v2.ts:2216-2219`、`packages/application/src/services/approval-display.ts:6-15`
- 问题：两端只替换/拒绝 C0 与 DEL；`U+202A–U+202E`、`U+2066–U+2069` 等双向控制字符可直接通过。审批预览一旦渲染，恶意命令/路径可以被视觉重排，审批人看到的与实际将执行的不一致（Trojan Source 类）。
- 证据（亲自读到）：
  - 合同：`(code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f`
  - 生产：`replaceDisallowedControls` 用同一条件。
- 推测：当前 `apps/control-center/src` 尚未引用 `bodyPreview`（全仓搜索只在 contracts、adapter、测试里出现），所以现在还不能真正误导用户；一旦接上 UI 就是现实风险。
- 建议：在 `approvalBodyPreview` 里替换/转义 bidi 控制字符，并补一条“双向控制字符被去掉/转义”的往返用例。

### 5. 低：Spec 与合同文案和结构不一致
- 文件：`docs/execution/specs/2026-09-10-control-center-local-acceptance-design.md:39`、`packages/gateway-contracts/src/contracts-v2.ts:2218,2223`
- 问题：Spec 说 `display.bodyPreview` 是“原始内容不进公开审批摘要”的**唯一例外**，但同一 `display` 结构里还有 `origin.threadTitle`（也会带用户文本），并预留了 `displayTitle`、`askedBecause.ruleText`；合同错误文案写“other than tab and newline”，代码实际还允许 `\r`。
- 证据（亲自读到）：
  - Spec：`唯一的例外是审批详情的展示字段 display.bodyPreview：…`
  - 合同：文案 `without control characters other than tab and newline`，条件是 `code !== 0x0d` 也放过。
- 建议：Spec 明确列出所有会带用户文本的展示字段（至少 `bodyPreview`、`origin.threadTitle`，将来 `displayTitle`/`ruleText`）；把文案改成“tab, newline and carriage return”，或干脆不允许 `\r`。

## 作者说法核对

- 控制字符替换：**证实**。`approval-display.ts:6-15` 在遮后替换，单元用例和 `governance-control-center.test.ts` 的往返用例都在。
- 期限重读：**证实**。`action-policy-service.ts:499-502` 在构造 display 后重读时钟；但新增用例只覆盖了 `approvalExpiresAt` 到期（`Clock` 设为 `T1`，即 approvalExpiresAt），没有覆盖 **display 期间 `intent.expiresAt` 到期**的分支。
- 预览上限夹到最大值：**证实**。`production-approval-display.ts:69-72` 用 `Math.min(..., APPROVAL_BODY_PREVIEW_MAXIMUM_CHARACTERS)`，用例断言 2001。
- 遮盖用例“能在遮盖被删时失败”：**部分证实**。删掉遮盖会失败；但见问题 3，不能守住遮盖与截断的先后顺序。
- 配置键解析：**证实**。`strict-configuration.ts:1360,1399-1408` 加进白名单并按 1..2000 的 `integer` 解析，`startup-configuration.unit.test.ts` 覆盖合法/非法值。
- file-read display 注入：**证实**。`production-file-read-workflow.ts:266-275` 把 builder 结果传给 `authorize`，测试夹具把 display 转发给真实服务并断言 `approval.display`。
- Spec 写成唯一例外：**证实有这一行**，但措辞与结构不完全一致（问题 5）。
- 对话删除时级联：**证实**。`0001_initial_product_schema.sql:183` `run_id ... REFERENCES runs(id) ON DELETE CASCADE`；`sqlite-governed-deletion.ts:783` `DELETE FROM runs WHERE thread_id = ?`。附带说明：单纯的 trash 只是把 thread 标成 trashed，真正 purge 时才删除，display 会保留到 purge。

## 侧重检查

- **错误路径**：`threadTitle` 抛错 → builder `catch` 后标题为 null（`production-approval-display.ts:76-79`）；非法 `maximumCharacters` → `approvalBodyPreview` 抛 `RangeError` → `approvalDisplay` 吞掉并写空 display（`action-policy-service.ts:547-551`）；display 构造慢 → 之后重读时钟并 DENY。**没有超时**，但标题读取是本地 SQLite + 本地 unprotect，且 coding 参数有 48KB 上限（`production-coding-workflow.ts:184,192`）。
- **不合规范/不可信输入**：工具参数来自模型，`toolApprovalBodyText` 只对白名单工具取字段（`production-approval-display.ts:40-62`），其余一律 null；控制字符在 `approvalBodyPreview` 替换；长度由 builder 夹紧；bidi/格式字符未处理（问题 4）。
- **安全**：`bodyPreview` 和 `origin.threadTitle` 都过 `maskSensitiveText`；审批读取按 owner/agent 校验（`governance-gateway-adapter.ts:347-355`）；Web Push 不读取 `display`（`production-web-push.ts` 只生成 kind/sourceRef）；删除对话最终级联删除 approval。审批记录 `record_json` 里是明文的（最多约 2KB 预览），这是 Spec 明示的例外，不是本次新增的加密缺口。
- **资源耗尽**：`write`/`edit` 会先对**全部** content 做遮盖再截断，复杂度 O(n)，但 coding 输入有 48KB 上限，实际有界；如果要更严格，可先按 `max + 安全窗口` 截取再遮，但会牺牲“跨边界秘密”的检测，需权衡。
- **不可逆操作**：本改动只在 ASK 路径写 approval 记录，`createApproval` 对同一 intent 幂等（`sqlite-durable-operations.ts:1898-1903`），没有执行工具、没有签发 Handle。
- **规则/文档/代码一致性**：Spec 的默认 300、上限 2000 与代码一致；其余不一致见问题 5。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。这个 PR（`a735795..e614dea`）没有改 `packages/prompt-catalog`、模型请求组装、工具定义、历史消息或模型出口遮盖；`display` 只在授权/审计侧生成。`production-coding-workflow.ts:408-415` 是在拿到模型工具调用、准备 `authorize` 时构造 display，`ActionPolicyService` 只在即将创建审批时调用 builder（`action-policy-service.ts:496-523`），不进入发给模型的内容。没有新增“每轮会变的值”进入请求开头或最后一条消息。结论：发给模型的内容仍然只追加，每轮变化的值不在请求头。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
对模型请求不会（本改动不进入模型请求）。对审批展示：`approvalBodyPreview` 只依赖文本和上限，`maskSensitiveText` 调用的是无 `known`/`tag`/`trusted` 的默认路径（`redaction.ts:542-544`、`redactForEgress` 默认 options），不含时间、随机数或集合遍历，同一输入字节确定；`display` 在第一次 ASK 时冻结写入，后续请求和 thread 改名都不会重写（`action-policy-service.ts:331-339` 直接返回已有审批；`governance-gateway-adapter.ts:381-395` 读冻结值）。`origin.threadTitle` 是发起时取一次的快照，不随后续改名变化。所以不会出现“同一段文字每次遮成不同字节”。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**
有，且多数反向会失败，但有三处弱/缺口（静态判断）：
- `production-approval-display.unit.test.ts`：去掉控制字符替换 → 期望 `\uFFFD` 失败；去掉 builder 夹紧 → 2001 断言失败；去掉遮盖 → `not.toContain("4111")` 失败。
- `authorization-capability-governance.test.ts:1055-1066`：去掉 display 后的时钟重读 → 会写出一条 pending approval，`listApprovals` 长度断言失败。
- `startup-configuration.unit.test.ts`：不把键加进白名单 → 合法值也会因未知键抛错；宽松解析 → 0/2001/1.5 等非法值断言失败。
- `production-file-read-workflow.unit.test.ts:415-425`：不注入 display → `approval.display` 为 undefined 失败。
- 弱点：问题 3 的遮盖顺序用例不能失败；没有“display 期间 `intent.expiresAt` 到期”的用例；没有 `displayTitle`/`ruleText` 的 max/max+1 往返用例；没有 `askedBecause.kind === "rule"` 的网关投影用例；没有 bidi 字符用例。测试未实际执行（工具限制）。

**4. 每个新值/字段/配置键，产生端与使用端都能接受吗？**
逐项核对（读代码）：
- `display`：产生于 `action-policy-service.ts:542-559`，存进 `approval_requests.record_json`（`sqlite-durable-operations.ts:1938` 整体 `JSON.stringify`）与 in-memory `frozenCopy`；`resolveApproval` 用 `...current` 保留（`sqlite-durable-operations.ts:2053-2062`）；适配器读后投影（`governance-gateway-adapter.ts:381-395`）；合同 `nullable(approvalDisplaySchema)`；老审批无该字段 → `display: null`，往返用例覆盖。**通过**。
- `approvalBodyPreviewCharacters`：`parseRunPolicy` 白名单 + `integer(1, 2000)`（`strict-configuration.ts:1360,1399-1408`）→ `RunPolicyConfiguration.approvalBodyPreviewCharacters` → `production-file-read-services.ts:61-63` 真值传递 → builder `Math.min(...,2000)`。**通过**；但 0 被真值判断当成“未设置”，与“非法值应报错”在直连配置时略有偏差（生产解析器已先拒绝 0）。
- `bodyPreview`：生产最大 2000+`…`=2001，合同 2001。**通过**。
- `origin.threadTitle`：生产 120+`…`=121，合同 121。**通过**。
- `displayTitle`：合同 300，生产当前恒 null；未来用 `approvalBodyPreview(_,300)` 会 301 被拒。**潜在不通过**（问题 1）。
- `askedBecause`：生产恒 `{kind:"no_rule_allows"}`；适配器为该分支补 `ruleId:null,ruleText:null`；合同要求三字段齐全。**通过**；`rule` 分支无生产者、无测试（潜在）。
- `origin.threadId`：用 `machineString`，与同一 payload 里已有的 `intent.threadId` 使用完全相同的校验（`contracts-v2.ts:2265`），现有线程号既然能过 `intent.threadId`，就能过 `origin.threadId`。**通过**。
- 另外：`display` 目前没有被 `apps/control-center/src` 消费（只在合同/适配器/测试出现），所以不存在 UI 端不接受的问题，但也意味着这个 PR 只完成了“存与投影”，尚未展示。

未核实：`.agents/reviews/pr-428/round-1` 下的复核记录（`git show` 对 records-path 被拒绝，工作区也没有该目录），因此无法逐条对照第 1 轮裁决原文；以上只按本次提交说明和代码核对。
