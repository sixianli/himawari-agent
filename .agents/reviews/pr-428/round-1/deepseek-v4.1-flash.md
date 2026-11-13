## 一、读代码证实的发现

### 高

**1. 把原始文件内容/命令复制进审批记录的明文 JSON，与现行设计文档冲突**
- 文件:行：`apps/agent-service/src/production-approval-display.ts:38-43`、`packages/application/src/services/action-policy-service.ts:499-519`、`packages/persistence-sqlite/src/sqlite-durable-operations.ts:1908-1930`、`docs/execution/specs/2026-09-10-control-center-local-acceptance-design.md:39`
- 问题：`bodyPreview` 直接取 `bash` 的 `command`、`write` 的 `content`、`edit` 的 `oldText/newText`，写进 `GovernedApprovalRequest.display`，最终由 `JSON.stringify(request)` 以明文存入 `approval_requests.record_json`。而现行设计写着：“工具参数冻结到受保护的 Run artifact……原始文件内容、命令和凭据不放进公开审批摘要。”`maskSensitiveText` 只替换它识别出的密码/卡号/证件号/机器密钥，不是加密，也不改变“原文被复制到另一个明文存储”的事实。
- 证据：
  - `production-approval-display.ts:39-42`：`case "bash": return text(args["command"]); ... case "write": return text(args["content"]) ?? text(args["path"]); case "edit": return editText(args) ?? ...`
  - `sqlite-durable-operations.ts:1929`：`JSON.stringify(request),`
  - 规范原话见上引 `2026-09-10-control-center-local-acceptance-design.md:39`。
- 此外，删除对话时 `sqlite-governed-deletion.ts:1028` 只把 `approval_requests.intent_ref` 当 payload 处理，不清理 `record_json`，因此这段内容可能在对话删除后继续留在审批记录里。
- 建议：不要复制原始内容；改为存受保护 Payload 的引用/摘要，由需要展示的端经受保护读取接口取。若确实要改变“原始内容不进公开审批摘要”的决定，应先补 ADR/Spec，并说明保护、分级和删除策略。

**2. 不可信输入里的控制字符会让 `approval.detail` 直接合同校验失败**
- 文件:行：`packages/application/src/services/approval-display.ts:7-14`、`packages/gateway-contracts/src/contracts-v2.ts:2191-2200`、`apps/agent-service/src/production-coding-workflow.ts:184-192`
- 问题：网关合同明确拒绝除 `\t`、`\n`、`\r` 外的 C0 控制字符和 `0x7f`；但生产者 `approvalBodyPreview` 只做 `maskSensitiveText` 和截断，`maskSensitiveText = redactForEgress(input).text` 不会去掉这些字符。`write` 内容、`edit` 文本、`bash` 命令、甚至线程标题都是模型/用户可控的字符串。只要其中有一个 ESC、NUL、BEL 等字符，`parseSnapshot` 就会抛 `ContractValidationError`，整个 `approval.detail` 不可用。
- 证据：
  - `approval-display.ts:10-13`：`const masked = maskSensitiveText(text); ... const characters = [...masked]; ... return \`${characters.slice(0, maximumCharacters).join("")}…\``
  - `contracts-v2.ts:2197-2200`：`return (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f;`
  - `production-coding-workflow.ts:184、192` 只检查 `Buffer.byteLength(JSON.stringify(...)) > 49152`，没有控制字符校验。
- 影响：这是 I-73 同类的“生产端能生成、消费端校验不过”；恶意或偶然的模型输入可以让主人看不到审批详情，只能看列表或盲批。
- 建议：在 `approvalBodyPreview` 内、遮盖后截断前统一替换/拒绝不允许的控制字符，并给 `displayTitle`、`threadTitle`、`ruleText` 共用同一规则；或明确放宽合同并补 ADR。必须加“含 ESC/NUL 的工具参数经 `approval.detail` 往返”的测试。

### 中

**3. 新增 `await display` 后没有重新读时钟和复核审批期限**
- 文件:行：`packages/application/src/services/action-policy-service.ts:423、496-519`
- 问题：现有流程在最后一次时间检查后创建审批；本改动在 `options.approvalExpiresAt` 检查之后插入 `await this.approvalDisplay(...)`，之后只检查 `signal`，没有重新 `clock.now()`，也没有重新检查 `options.approvalExpiresAt <= now` 或 `intent.expiresAt`。如果线程标题读取/解密或遮盖很慢，可能写入一个 `requestedAt` 已过期、`expiresAt` 已过去的 pending 审批。这个 await 也没有传入 `signal`，不能随取消/期限中止。
- 证据：
  - `:423`：`if (options.approvalExpiresAt <= now || options.approvalExpiresAt > intent.expiresAt) return ...`
  - `:496-499`：`options.signal?.throwIfAborted(); const display = await this.approvalDisplay(options.display); options.signal?.throwIfAborted(); const request ...`
  - `:514-515`：`requestedAt: now, expiresAt: options.approvalExpiresAt`
- 建议：在 `await this.approvalDisplay(...)` 之后重新取 `now` 并重跑上述期限检查；把 `signal` 传给标题读取/数据库查询，或给展示构造设明确上限。

**4. 现有“遮盖”测试不能证明遮盖发生过，反向用例不会失败**
- 文件:行：`apps/agent-service/test/production-approval-display.unit.test.ts:33-45`
- 问题：测试用 `maximumCharacters: 20`，卡号从下标 5 开始；即使完全删掉 `maskSensitiveText`，截到 20 个字符时预览也只是 `echo 4111 1111 1111 …`，不包含完整的 `4111 1111 1111 1111`，两个断言仍会通过。因此这条名为“masks secrets”的用例并不能在遮盖被移除时失败。
- 证据：
  - 测试输入：`arguments: { command: \`echo 4111 1111 1111 1111 ${"x".repeat(100)}\` }`
  - 断言：`expect(shown.bodyPreview).not.toContain("4111 1111 1111 1111");`
  - 删除遮盖后：预览为前 20 个字符加 `…`，全卡号被截掉，断言仍成立。
- 建议：把秘密放在开头，或把上限设得足够长以包含完整秘密；断言出现 `[银行卡…]` 之类的遮盖标记；再加“秘密正好跨截断边界”的用例。另需补控制字符、配置上限（2000→2001）、以及 gateway 合同往返的反向用例。

### 低

**5. 新配置键没有测试也没有文档**
- 文件:行：`packages/platform-node/src/strict-configuration.ts:1336、1375-1384`、`packages/application/src/ports/configuration.ts:292`
- 问题：`approvalBodyPreviewCharacters` 被加入允许键并按 1–2000 解析，但仓库里没有对应测试，也没有任何文档/示例提到它。默认值 300、边界 1 和 2000、越界拒绝都未被自动检查。
- 证据：`grep approvalBodyPreviewCharacters` 只命中配置解析和 `production-file-read-services.ts:61-62`，没有测试文件。
- 建议：在 `startup-configuration.unit.test.ts` 补正向边界和 0/2001 反向用例，并在运行手册或配置说明中登记。

**6. 两个包的预览上限常量各自维护，且 builder 不强制上限**
- 文件:行：`packages/application/src/services/approval-display.ts:3-4`、`packages/gateway-contracts/src/contracts-v2.ts:2210`、`apps/agent-service/src/production-approval-display.ts:78`
- 问题：应用侧上限是 2000，网关合同是 2001（为省略号留 1）；当前默认/配置路径正好一致，但两个常量分散在包里。`createApprovalDisplayBuilder` 直接接受调用方传入的 `maximumCharacters`，不夹到最大值，未来直接调用者传 2001 就会生成 2002 字符并被合同拒绝。
- 建议：共享一个上限定义，或在 builder 内 `Math.min` 到 `APPROVAL_BODY_PREVIEW_MAXIMUM_CHARACTERS`，并加边界测试。

**7. 线程标题读取没有检查 thread 是否 active，且重复了已有读取逻辑**
- 文件:行：`apps/agent-service/src/service-main.ts:1586-1606`，对照 `:2447-2459`
- 问题：新读取器只检查 `titleRef` 和 contentType；现有 web push 的读取器还要求 `thread.status === "active"`。已归档/非活动对话的标题可能被写进审批展示。两处逻辑也没有复用。
- 建议：抽一个共同的标题读取函数，至少与现有 web push 一样检查 `status`。

## 二、推测/未核实

- **旧版严格客户端兼容性（推测）**：`approval.snapshot` 的 `object` 会拒绝未知字段并强制要求所有字段（`packages/gateway-contracts/src/validation.ts:174-180`），而 `display` 是新增的必填键（`contracts-v2.ts:2243`）。如果存在独立部署、尚未升级的旧客户端，它会把新服务端的 `approval.snapshot` 全部判为非法。仓库内的 control-center 与 fixtures 已同步更新；外部移动端是否与服务端同版本发布，未核实。
- **生产是否存在 protector（未核实）**：`approvalThreadTitle` 只在 `if (episodeProtector)` 内赋值（`service-main.ts:1584-1608`）。若某个部署没有 protector，`origin.threadTitle` 会恒为 null；需要确认生产组合是否总有 protector。
- **删除策略（需产品确认）**：`record_json` 中的 `bodyPreview` 在删除对话后是否应一并清除，代码层没有处理（`sqlite-governed-deletion.ts:1028` 只处理 `intent_ref`）。这属于数据保留决定，不是本次代码单独能断定的。

## 三、侧重检查

- **错误路径**：查了 `approvalDisplay` 的 `try/catch`、`threadTitle` 的 `try/catch`、`TextDecoder({fatal:true})`、`maskSensitiveText` 失败路径。展示构造失败确实不会升级为 ALLOW；但发现新增 await 未复核期限/未接 signal（发现 3）。
- **不可信输入**：查了工具参数大小校验、路径校验、工具名分发。参数上限 49152 字节确实存在，但没有控制字符过滤，且控制字符会被网关合同拒绝（发现 2）。
- **安全/不可撤销**：确认 `display` 不参与授权判断，`approvalMatchesIntent` 只比较 intent；但原始内容被复制进明文 `record_json`，与受保护 Run artifact 的既有边界冲突（发现 1）。
- **资源耗尽**：预览本身有界（默认 300，最大 2000+1），工具参数有 49152 字节上限；线程标题会整段读取/解密，但通常很小。新增的标题读取是审批前的同步 await，慢查询会延迟审批（发现 3）。
- **规则/文档一致性**：发现 `2026-09-10-control-center-local-acceptance-design.md:39` 与本次“把原文放进审批摘要”直接冲突；作者说没有新增 ADR，仓库里也没有更新对应 Spec。新配置键没有文档/测试。
- **网关多行文本**：`approvalDisplayText` 接受 `\t`、`\n`、`\r`，integration 测试用 `"rm -rf build\ncd .."` 验证了 LF 往返；其他控制字符被拒绝，而生产者未清洗。

## 四、必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。diff 没有改系统提示、工具定义、历史消息或遮盖逻辑；`display` 只在服务器创建审批时写入审批记录。ASK 时模型侧工具结果由 `runtime-tool-authorization.ts:7-19` 生成，只包含 `approvalRequestId`、`semanticSnapshotHash`、`expiresAt`，`modelContent` 为空，不包含 `display`。因此发给模型的内容仍然只在末尾追加，每轮会变的值也没有进入请求开头。

**2. 同一段文字会不会在不同请求里变成不同字节？**
对模型请求不会，因为 `display` 根本不进模型请求。对审批记录本身，`display` 在创建时计算一次并持久化；`maskSensitiveText(text)` 使用空 options，结果是确定性的；`askedBecause` 固定；没有时间字段；对象键顺序由字面量固定。后续读取 `approval.detail` 返回的是存下来的值，不会因线程改名或规则变化重算。不同审批可能因当时的线程标题不同而不同，但那是不同记录，不是改写旧请求或旧审批。

**3. 有没有对应的自动检查，反向用例真的会失败吗？**
有，但不充分。已有：`production-approval-display.unit.test.ts`（工具分发、空参数、遮盖/截断、标题读取失败）、`authorization-capability-governance.test.ts`（display 冻结、构造失败仍 ASK）、`governance-control-center.test.ts`（非空 display 投影、老审批 null）、以及各 fixtures 的 `display: null`。
反向缺口：
- 遮盖测试实际不会在“删除遮盖”时失败（发现 4）。
- 没有控制字符用例，因此发现 2 不会被测出。
- 没有 `approvalBodyPreviewCharacters` 的配置解析正反用例。
- 没有 2000/2001 上限边界用例，也没有“旧客户端拒绝新增字段”的兼容性检查。
所以：display 构造失败不影响授权的反向用例是有效的；但“遮盖”和“网关合同控制字符”这两类反向用例没有真正覆盖。

**4. 每个新产生/修改的值，所有使用方都能接受吗？**
逐个核对结果：
- `approval.display` / `displayTitle` / `bodyPreview` / `askedBecause` / `origin`：持久化层只是 `JSON.stringify`/`JSON.parse`，能接受；内存实现冻结复制能接受；网关适配器 `governance-gateway-adapter.ts:381-395` 会投影；control-center 合同已更新。**但 `bodyPreview` 和 `origin.threadTitle` 的控制字符不被网关合同接受，这是明确的两端不一致。**
- `bodyPreview` 长度：配置最大 2000 时，`approvalBodyPreview` 最多返回 2000+1=2001，合同正好允许 2001；默认 300 时最多 301。当前上限一致，但常量分处两包，存在漂移风险。
- `origin.threadId`：合同用 `machineString`（`validation.ts:49-59`）。实际线程 ID 是 `${namespace}:${randomUUID()}`（`service-main.ts:245`），只含字母数字、冒号、连字符，能通过；而且同一个值早已作为 `intent.threadId` 用同一个 `machineString` 校验（`contracts-v2.ts:2246`），未发现 I-73 那类“id 过不了后端校验”的问题。
- `origin.threadTitle`：生产者最多 120+1=121，合同允许 121；长度一致。
- `askedBecause`：`no_rule_allows` 分支由适配器补 `ruleId: null`、`ruleText: null`，合同接受；`rule` 分支当前不会产生，未来若产生需保证 `ruleId` 过 `machineString`、`ruleText` 过 2000 字符/控制字符规则。
- 配置键 `approvalBodyPreviewCharacters`：产生于 `strict-configuration.ts`，消费于 `production-file-read-services.ts:61-62`，没有其他使用方；解析范围 1–2000 本身能接受，但缺测试和文档。
- 其他审批创建路径：`owner-policy-authorization.ts:73` 和 `sqlite-automatic-action-review.ts:221` 直接创建审批，不带 `display`；网关会投影为 null。对“所有新审批都有展示字段”的预期来说它们不符合，但这些是内部/自动路径，是否需要展示需产品确认。
- 序列化/兼容性：新记录多一个字段，当前仓库内旧代码回滚时不会主动读取它；但旧版严格客户端是否会拒绝新 `approval.snapshot`，未核实（见“推测”）。
