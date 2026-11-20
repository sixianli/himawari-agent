### 1. 高 — 模型写的一句话被放进 APNs 的 `alert.body`，违反“锁屏只放标题级内容、审批具体操作不上锁屏”的规则，并可能把审批细节送到锁屏

文件:行：`apps/agent-service/src/production-apple-push.ts:412`（另见 `:396-401`）；`test/integration/push-channels.test.ts:1008-1010`

问题：普通审批的推送正文从原来的对话标题改成了模型写的句子。这个句子来自审批事实，可能包含收件人、金额、具体动作；而项目规则明确禁止把审批正文/具体操作放进推送。

证据：
- 代码：`body: copy?.sentence ?? built.body,`（`production-apple-push.ts:412`）。`copy` 只在 `recentAuthenticationRequired !== true` 时读取（`:396-401`）。
- 新测试直接把“要把周报发给张三”断言成锁屏正文：`expect((byId("plain")?.json["aps"] as { alert: { body: string } }).alert.body).toBe("要把周报发给张三");`（`push-channels.test.ts:1008-1010`）。
- 规则：`docs/adr/0089-web-push-only-owner-entry.md:60`：“锁屏内容：……审批和任务只显示对话标题（审批加风险级别）；……回答正文和审批的具体操作不上锁屏。”
- `docs/adr/0229-native-apple-clients-and-device-api.md:124`：“苹果推送的内容经苹果的服务器，所以锁屏规则里‘敏感或受限的只显示一句提示’同样适用于它。”同文件 `:165`：“苹果推送的内容经过苹果的服务器，所以沿用锁屏规则，正文不放进推送。”
- `docs/execution/specs/2026-11-11-apple-device-body-design.md:493`：“推送里只放标题这一级的内容，敏感或受限的只显示一句提示；正文在主人解锁后由 App 向服务器取。”
- `docs/adr/0255-model-scores-urgency-of-home-items.md:88` 也承认：“审批的一句话可能带收件人、金额这类内容。”

已证实：代码确实把模型句子作为锁屏正文；新测试把这一行为固化。规则文件确实要求推送正文不包含审批细节。

推测：是否实际泄露敏感内容取决于 `homeUrgency` 模型允许的分类和审批内容；若允许 `sensitive`，且模型写出了金额/收件人，锁屏会显示。即使只允许 `private`，具体操作也已被规则禁止。

建议：`aps.alert.body` 保持标题级内容（`built.body`），模型句子只在解锁后的 App/首页显示；至少要在推送层按 `approval.intentSnapshot.dataClassification` 拦截 `sensitive`/`restricted` 并显示通用提示。若确实要改锁屏规则，应先由 Andy 明确修改 ADR 0089/0229 和详细设计，而不是在实现里默认改变。

### 2. 中 — 锁屏上“模型写的正文 + 模型写的同意按钮”共同描述一个可一键执行的审批，格式校验不能防止误导

文件:行：`apps/agent-service/src/production-apple-push.ts:344-352`、`:412`；`packages/platform-node/src/device-push.ts:204`

问题：非本人到场审批的同意按钮直接使用 `affirmLabel`，正文也使用模型句子。该审批的按钮可在锁屏一键消费令牌执行；模型只被校验长度/控制字符/是否与否定文字相同，不校验“这几个字是否说清了点下去会做什么”。提示注入或模型幻觉可以让锁屏显示一个与实际审批不符的说明和按钮。

证据：
- 按钮：`label: ownerPresence ? text.approveInApp : (affirmLabel ?? text.approve),`、`labelBasis: !ownerPresence && affirmLabel !== null ? "model" : "catalog",`（`production-apple-push.ts:347-348`）。
- 校验只做格式：`acceptsHomeAffirmLabel` 检查长度、控制字符、是否等于否定文字（`home-urgency.ts:129-145`）；ADR 0255 `:87` 明确说“这几个字是不是说清了点下去会做什么”交给写它的模型。
- 非本人到场的审批不需要再次确认即可消费令牌：`if (read.token.action === "approve" && read.token.ownerPresence && !input.confirmed) throw ...`（`device-push.ts:204`），反过来说 `ownerPresence=false` 时没有这一道确认。

已证实：锁屏上存在“模型正文 + 模型按钮 + 一键执行”的组合；格式校验不涉及语义真实性。

推测：具体被利用需要模型被审批内容影响或产生幻觉；未做真实模型验证，也未在客户端验证用户是否会被误导。

建议：对不可逆/高风险审批，锁屏保留目录文字“同意/看内容再定”，模型文字只在打开 App 后显示；或要求模型文字标注的审批必须进 App 才能确认。至少要评估“锁屏一键同意 + 模型描述”的风险并由 Andy 确认。

### 3. 中 — 说明文档仍写着“推送还没有调用 approvalCopy”“这一批按钮都是通用文字”，与本次代码不一致

文件:行：`docs/adr/0255-model-scores-urgency-of-home-items.md:65`、`docs/execution/specs/2026-11-11-apple-device-body-design.md:495`、`docs/execution/plans/2026-11-11-apple-device-body-plan.md:164`

问题：本次提交只改了代码和测试，没有同步更新与推送文案直接相关的说明文档。

证据：
- ADR 0255 `:65` 仍写：“这一步还没有推送调用它：网页推送仍只用首页的件数，苹果端推送由苹果端第 4 批接入时调用它。”但 `service-main.ts:2767-2768` 已经接上 `http.home.approvalCopy`。
- 详细设计 `:495` 写按钮“文字来源（`catalog` 通用文字或 `model` 模型写的，这一批都是通用文字）”，本 PR 已产生 `labelBasis: "model"`。
- 计划 `:164` 仍把“审批肯定按钮用模型写的文字”列在“这一批没做、留到后面的”。
- 另一个一致性问题：ADR 0255 `:64` 说“要主人本人在场的审批，按钮仍是通用的‘看内容再定’，模型写的字只作为这条的说明”；但本实现对该类审批完全不读文字（`production-apple-push.ts:396-401`），推送正文仍是原对话标题。若这里的“说明”也应适用于推送，则代码和 ADR 不一致；需要明确是否故意跳过。

已证实：三处文档仍与代码相反；本次 diff 只有三个文件，没有文档变更。

建议：在同一 PR 或后续文档提交中更新 ADR 0255、详细设计和计划；同时确认“要本人在场时模型句子是否应作为说明”的产品决定。更重要的是，先把第 1 条的锁屏规则冲突定下来，否则文档更新也无法自洽。

### 4. 中 — 新测试没有验证 `labelBasis: "model"`、两条回落路径和服务装配，反向用例覆盖不完整

文件:行：`test/integration/push-channels.test.ts:1007-1012`、`:1029-1040`

问题：本次改动的自动检查没有覆盖几个关键值。

证据：
- 正向用例只断言按钮文字是“发出去”、正文是模型句子、要到场的是“看内容再定”、只读取了 `plain`，但没有断言 `labelBasis` 为 `model`。把 `labelBasis` 写成 `catalog` 这个回归不会被发现。
- 反向用例只覆盖 `approvalCopy` 抛错；没有覆盖真实“取不到”时返回 `{ sentence: null, affirmLabel: null }`，也没有覆盖“句子有、按钮无”或“句子无、按钮有”的逐项回落；同时没有断言正文回落到 `built.body`。
- 推送测试里 `approvalCopy` 是桩；首页测试直接调用 `home.approvalCopy`；没有测试覆盖 `service-main` 把 `http.home.approvalCopy` 接到 `ProductionApplePush` 的装配，因此接错方法/接错字段也不会被发现。

已证实：上述断言确实不存在。

建议：补上 `labelBasis` 为 `model` 的断言；增加返回 null、单项 null、抛错三类反向用例，并同时断言正文与按钮；增加一条经 `ProductionApplePush` + 真实 `ProductionHomeControl.approvalCopy`（或至少验证装配）的用例。

### 5. 低 — 启动时 `webPush.start()` 先于 `http` 赋值，首批审批推送可能静默使用固定文字

文件:行：`apps/agent-service/src/service-main.ts:2876`、`:3221`、`:2767-2768`；`apps/agent-service/src/production-web-push.ts:253-260`

问题：`webPush.start()` 会立刻调用一次 `tick()`，而 `http` 到 `:3221` 才赋值。在这个窗口内 `http?.home.approvalCopy` 返回 `undefined`，于是静默回落到 `{ sentence: null, affirmLabel: null }`，不会调用 `onFailure`，也不会留下“文案不可用”的诊断。

证据：
- `start(): void { ... this.#timer = setInterval(...); this.#timer.unref?.(); void this.tick(); }`（`production-web-push.ts:253-260`）。
- `webPush.start();`（`service-main.ts:2876`），`http = await createProductionHttpComposition({...})`（`service-main.ts:3221`）。
- 回调：`approvalCopy: async (input) => (await http?.home.approvalCopy(input)) ?? { sentence: null, affirmLabel: null },`（`service-main.ts:2767-2768`）。

已证实：代码顺序确实允许 `http` 尚未赋值时执行推送。

推测：是否真的漏掉某条审批取决于启动时是否有到期审批以及异步时序；但一旦漏掉就是静默行为，难以排查。

建议：先创建好 HTTP composition 再启动推送；或在 `approvalCopy` 不可用时报一次诊断，避免“功能静默失效”。

### 6. 低 — Apple 推送边界直接信任 `sentence`/`affirmLabel`，空串或纯空白会绕过回落

文件:行：`apps/agent-service/src/production-apple-push.ts:347-348`、`:412`；`packages/application/src/services/home-urgency.ts:129-145`、`:199-203`

问题：`affirmLabel ?? text.approve` 只对 `null/undefined` 回落；若上游返回空字符串，会得到空按钮文字并标 `labelBasis: "model"`。同样，空句子会让正文为空。生产路径的 `ProductionHomeControl` 会拒绝空串/空白，但 `ProductionApplePushOptions.approvalCopy` 的契约本身不约束，只在“另一个调用者”时才暴露。

证据：
- `label: ownerPresence ? text.approveInApp : (affirmLabel ?? text.approve),`（`production-apple-push.ts:347`）。
- `body: copy?.sentence ?? built.body,`（`:412`）。
- 上游校验确实拒绝空串：`acceptsHomeAffirmLabel` 中 `if (label.length === 0 || label !== input.label || ...) return false;`（`home-urgency.ts:137-139`）；`line()` 中 `if (text.length === 0 || ...) return null;`（`:199-203`）。

已证实：生产路径当前安全，因为 `ProductionHomeControl` 返回的值已经校验。

推测：未来若换用别的 `approvalCopy` 实现或测试注入空串，Apple 侧不会兜底。

建议：在 Apple 推送边界把空串/纯空白当作 `null`，或把返回类型收紧为已校验的品牌类型。

## 侧重检查

- **错误路径**：`approvalCopy` 抛错会被 `#approvalCopy` 捕获，调用 `onFailure` 后返回 null，推送继续（`production-apple-push.ts:308-324`）——已证实符合作者说法。`http` 未赋值时静默回落，见第 5 条。
- **不合规范/不可信输入**：生产端 `HomeUrgencyService.approvalCopy` 会核对审批编号、语言、内容指纹，并对句子/按钮做单行、长度、控制字符、否定文字同名校验（`home-urgency.ts:292-325`、`:129-145`、`:199-203`）——已证实。Apple 侧不再校验，见第 6 条。
- **安全/隐私**：锁屏正文规则冲突，见第 1 条；模型文字参与一键审批，见第 2 条；未发现新的越权路径，动作令牌仍绑定审批编号、版本、内容指纹（`production-apple-push.ts:339-343`）——已证实。
- **资源耗尽**：`approvalCopy` 只读 SQLite + 解封密封内容，没有新增模型调用；每个到期条目/每台设备调用一次，上限受 `SEND_BATCH = 50` 约束，没有发现新的无界循环——已证实。没有超时封装，慢 I/O 会拖住该轮推送，但这是本地调用，风险低。
- **不可撤销操作**：通知一经发送即到锁屏，正文无法撤回；一键同意会消费令牌并执行审批。第 1、2 条的风险因此不可逆。
- **规则/文档一致性**：已核对 ADR 0089、ADR 0229、ADR 0255、Apple 推送详细设计和计划，发现第 1、3 条所述不一致。
- **未核实**：不能运行测试，作者所说“`npm run check` 55 步通过、push-channels/service-orchestration 通过”未核实；客户端通知扩展是否会正确接受 `labelBasis: "model"` 也未在仓库中找到对应实现，未核实。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。改动只在 Apple 推送类和测试里，没有改系统提示、工具定义、历史消息、遮盖或压缩；`approvalCopy` 只读已存的打分和密封内容，不发起模型调用。发给模型的内容仍然是“固定内容在前、只在末尾追加”，每轮会变的值没有被加进系统提示或工具定义。依据 `.agents/instructions/prompt-prefix.md` 第 4、15、16 条。

2. **会不会让同一段文字在不同请求里变成不同的字节？** 不会改变模型请求的字节。推送侧在同一个 `(approvalRequestId, semanticSnapshotHash, locale)` 下，查询有 `ORDER BY item_key, text_digest`，成功记录有唯一索引（`sqlite-home-urgency-operations.ts:99-101`、迁移 `home_item_scores_done`），密封内容解封是确定的，所以文案确定。账号语言变了或没有分数时会按设计换文案/回落，这不是同一个条件下的不确定性。动作令牌每次随机是既有行为，且不是模型请求文字。

3. **有没有对应的自动检查，反向用例是否真的会失败？** 有测试，但不完整。反向用例在删掉 `catch` 或 `onFailure` 时会失败（它断言 `failures` 长度为 1、按钮回落为 `同意`/`catalog`），这一点是真的；但 `labelBasis: "model"`、返回 null/单项 null 的回落、正文回落、服务装配都没有覆盖，见第 4 条。测试是否全部通过无法运行核实。

4. **每个值两端都能接受吗？**
   - `approvalCopy` 的 `locale`：`WebPushLocale` 与 `HomeLocale` 都是 `"zh-CN" | "en" | "ja"`（`web-push.ts:3-4`、`contracts-v2.ts:876`），类型兼容；`service-main` 传到 `ProductionHomeControl.approvalCopy`，可用。
   - `approvalRequestId` / `semanticSnapshotHash`：来自 `ApprovalRequest`，与首页打分时的键一致（`production-home.ts:593-596`、`home-urgency.ts:300-303`），已证实一致。
   - `sentence` / `affirmLabel`：生产端有校验，Apple 端直接使用；生产路径安全，但边界不兜底空串，见第 6 条。
   - `labelBasis: "model"`：服务端类型接受；客户端通知扩展的消费端未在仓库中找到，未核实。
   - `body`：APNs 接受任意字符串，但产品规则端不接受“审批具体操作上锁屏”，见第 1 条。
   - 没有新增配置键、迁移、清单项或序列化格式，作者这一部分说法与 diff 一致。
