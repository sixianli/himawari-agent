现在我来读取完整的最新 `model-egress.ts` 文件，以检查 redactor 的连接和部分分配：
我来检查一下 `repository` 对象标识问题——多个 recorder 可能会通过以 repository 为键的 WeakMap 产生：
# 复核报告：PR #258 敏感信息拦截记录(第 1 步)

## 发现(按严重度从高到低)

### 1. 严重度：中 | `apps/agent-service/src/production-sensitive-interceptions-control.ts:79-81` + `packages/application/src/services/sensitive-interception-recorder.ts:147-154`
**问题：**「清除全部」有竞态——清除前 200 毫秒内(以及 clear 执行期间)报出的拦截会写在 DELETE 之后，清除后被主人重新看见。**证据(读代码证实)：**`execute()` 先 `await this.#options.beforeRead?.()`(即 `flushSensitiveInterceptions`),再 `await store.clear(...)`;`flush()` 只清空当时队列(recorder.ts:137-145),之后 `observe()` 推入的条目按 `WRITE_DELAY_MS=200`(recorder.ts:15、149-153)的定时器在 clear 之后写库。**建议：**clear 执行完后再 `beforeRead` 一次，或清除期间阻塞采集。

### 2. 严重度：中 | `packages/application/src/services/proactive-mail-check-service.ts:345-362`
**问题：**邮件拦截计数与「发给模型的内容」不符:`#reportMasked` 对**完整** `item.body ?? snippet` 和**全部**附件文件名跑 `findSensitiveValues`,但模型实际只看到窗口截断后的正文(`proactiveMailView`:`windowMailBody(masked(item.body), bodyLimit)`,198 行)和前 `MAX_ATTACHMENTS_SHOWN` 个文件名(209 行)。窗口外、超量附件里的值被记为“发给模型前遮住”，实际从未发给模型。另：同批去重使 `seenCount` 对邮件行等于“判断批次数”，而界面文案说“之后 N 次发送都已遮住”(zh-CN `sensitive.maskedMany`),文字与数字含义有出入。**建议：**对发送截窗或截量之后的那份文本复测，或调整文案定义。

### 3. 严重度：低 | `packages/application/src/services/model-egress.ts:293-305`
**问题：**chat completions 的旧式 `role: "function"` 消息不在 `partOf` 的 switch 里，落入继承值(顶层 `messages` 键继承为 `owner_message`),工具结果会被记成“你的话”。**证据(读代码证实)：**switch 只有 `system/developer/assistant/tool/user`。**建议：**补 `"function"` → `tool_result` 一例；当前运行链路似乎不产生该角色，影响面小。

### 4. 严重度：低 | `packages/application/src/services/sensitive-interception-recorder.ts:25-37`
**问题：**`memoryCategory` 把 ruleId→category 的映射放在 application 包：sensitive-capture 以后新增机器秘密规则时，记忆类拦截里该规则会被静默丢弃(`category === undefined` → 20-33 行 continue),需两处同步。**证据(读代码证实)：**记忆审计只带 `ruleId`(ports/automatic-memory.ts:163),recorder 只认 `MACHINE_SECRET_RULE_IDS` + `machine-secret/password/verification-code`。未逐条核实记忆扫描会产出哪些 ruleId(见自动化记忆 golden 测试只见 `openai-api-key`)。

### 5. 严重度：低 | `apps/control-center/src/components/sensitive-interceptions.tsx:83-98`
**问题：**按 `localDay`(`toISOString()`)归组，“今天/昨天”以 UTC 日为准而不是主人时区——东京晚间 22 点发的记录会整组标“昨天”。**证据(读代码证实)：**83-98 行。**建议：**用 `format.dayHeading` 已有的本地化日期逻辑做归组。

### 6. 严重度：低 | `apps/control-center/src/proactive.css` 末段
**问题(推测，未运行浏览器)：**移动端 `.sensitive-go` 的 `padding-left: calc(12px + 4.2em)` 用硬编码系数对齐文字起点，各语言芯片宽窄不同(如“API key”較長)会轻微错位;`check:layout` 的 `CONTENT_PUSHED_SIDEWAYS` 查不出纯错位。**建议：**让按钮和正文共用同一缩进容器，依赖一个样式变量而不是 magic number。

### 7. 备忘(读代码证实，非缺陷)
`packages/sensitive-capture/src/machine-secrets.ts:62-73` 把 `replace(pattern, REDACTED)` 改成了回调式。对输出字节**等价**:`REDACTED`(`[MACHINE_SECRET_REDACTED]`,45 行)不含 `$`,字符串替换不再有模板语义差异；调用点只有 redaction.ts(经 `see()` 包 try/catch)和流式 redactor(不传 observe)。

### 8. 备忘
`SensitiveInterceptionRecorder.flush()` 若 `#drain` 语句抛错(排除 store 后理论上无抛点)，定时器路径 `void this.flush()` 会变 unhandled rejection(推测，未核实可达路径)。

### 作者说法逐条核对
全部与代码一致：迁移 0078(复合外键指向 threads、thread_id 可空、STRICT、dedupe_key 64 位 ✓);HMAC+标签前 16 字节(model-egress.ts:51-57、197-207)、记忆用 sha256([generationId, candidateOrdinal, part, ruleId])(recorder.ts:97-103)✓;observe 可选且三条保护层(see、`#report`、`reportMasked` 全 try/catch)✓;队列 2000/200ms/按 owner+agent 500 批/弃最旧写诊断 ✓;读取和清除前 flush ✓;**停机先于关库 ✓**(`ProductionServiceLifecycle.#stop` 对注册序 `[...resources].reverse()` 的 LIFO,repository 先注册故后关，production-service-lifecycle.ts:40);邮件 `findSensitiveValues` 只找不改 ✓;整段拦下 5 处不记录(ADR 0054 列的五处均未被本 PR 触及)✓;接口不含指纹/规则 id(control items map、contracts-v2 快照 schema、测试断言 1048-1049 行)✓;页面标题配不上写“一个对话” ✓;`min-width: 0` + 标签 `flex: none` + `CONTENT_PUSHED_SIDEWARDS`(实际为 `CONTENT_PUSHED_SIDEWAYS`)✓。唯一与说法有出入的是发现 2(计数定义，作者未声称这点)。

未核实：无法运行 `npm run check:layout` / `check:prompt-prefix` / vitest(反向用例按代码与自检页设计判断，未实际执行)；浏览器 E2E 用例文件未读。

## 必答问题

**1. 会否改变模型已见过的请求开头？——不会。** 本 PR 不触碰请求组装(Pi transport 只多传一个上下文对象，pi-model-transport.ts:281);`redactForEgress` 的 observe 只采集不改文本，`see()`(redaction.ts)try/catch 后静默返回;`#report` 在 redactor 之后同步调用(recorder 只是数组 push 与定时器，model-egress.ts:220-221);系统提示、工具定义、历史、acknowledged 遮盖全都逐字节不变。反向检查存在且会失败(callback 模式字节等价、无模板残留)。依据 `.claude/rules/prompt-prefix.md` 第 4、5、11 条：**发给模型的内容仍然只在末尾追加，每轮会变的值仍只在最后一条消息，均未变**。

**2. 会否同段文字变不同字节？——不会。** observe 使遮盖密钥 + 专属标签的 HMAC-SHA256 取前 16 字节(32 hex),有密钥，短验证码不可暴力还原；记忆路径的无密钥 sha256 只含 generationId/序号/部分/规则，不含原值。DB 与接口只有指纹(校验 16-64 位 hex,sqlite ops:53)、类别/规则/时间，无原值；日志只写 code 和计数。去重键 JSON.stringify 固定数组顺序，指纹与顺序跨请求稳定(same-fingerprint 测试)。遮盖密钥轮换是既有约定，非本 PR 引入。

**3. 自动检查及反向用例。** model-egress 单测(部分归属、三媒体、report 异常下字节一致)、recorder 单测(队列上限、时钟/库失败不抛)、[SI-1] 集成测试(FK 跳过、级联删除、分页不重不漏、字段校验拒绝)、[SI-2] prompt-prefix(记录与不记录逐字节相等)、[SI-3](邮件 onMasked 抛错提示词完全一致)、浏览器测试与 `_ layout 自检：BROKEN 页含被推开的固定 div、REQUIRED_KINDS 强制认出 `CONTENT_PUSHED_SIDEWAYS`(真实浏览器对 overflow:hidden 容器设置 scrollLeft 会保留并可测出，反向用例会失败)。若新增回归(如 `role: "function"`、三包 part 缺口)无测试覆盖。

**4. part 判断。** chat completions(role 驱动 + tool_calls 强制 tool_call + arguments 参数化)✓;responses(instructions→system、function_call→tool_call、`_output`→tool_result、message 按 role)✓;anthropic messages(顶层 system→system、user 消息内的 tool_result 块→tool_result、tool_use→tool_call、thinking 不动)✓——均有单测断言支撑。遗留缺口：发现 3(`role: "function"`)与发现 4(记忆类别的遗漏映射)。
