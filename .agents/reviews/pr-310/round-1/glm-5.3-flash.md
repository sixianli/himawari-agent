# 代码复核报告：密码、密钥标敏感（去掉整段拦下 第 2 步，3f32cb87）

## 发现（按严重度从高到低）

### 1.（中）漏判路径仍在：关键词后没有「是/为/冒号」的密码写法不会被提级，密码仍会显示在锁屏推送上
- 文件：`packages/sensitive-capture/src/redaction.ts:68-69`、`packages/sensitive-capture/src/identifiers.ts:16-18`
- 证据：`PASSWORD_ASSIGNMENT = /((?:密码|…|password|passwd|pwd)\s*(?:[:：=＝]|是|为|為|は)\s*)(?!\[)([^\s,，;；]+)/giu`——「Wi-Fi 密码 abc12345」（无分隔）或英文「password is X」都不命中；`containsCredential` 只透传 `redactForEgress` 的这三类 findings（`machine-secret`、`password`、`verification-code`），因此 `classificationWithIdentifiers("Wi-Fi 密码 abc12345", "private")` 仍是 `"private"`，`production-web-push.ts:486-487` 的 `hidden` 为 false，正文原样上锁屏。
- 限度：ADR 0185「已知缺口」明确写了这条（“关键词与值之间没有‘是’‘为’或冒号的写法认不出”），文档与代码一致；但作者摘要里「这样提醒里含密码时推送正文被隐藏」这句比代码保证强——只在命中赋值模式的写法上成立。新集成测试恰好都用了「密码是 abc12345」的命中写法。
- 建议：在对外说法里限定这条保证的适用范围；后续可考虑放宽 `PASSWORD_ASSIGNMENT` 或推送端一律不带正文（ADR 0185 已把后者列为放弃做法，需 Andy 再拍）。

### 2.（低）`containsCredential` 把出口遮盖的验证码 40 字窗口假阳性搬进了持久分类
- 文件：`packages/sensitive-capture/src/redaction.ts:71-74,347-357`、`packages/sensitive-capture/src/identifiers.ts:16-18`
- 证据：`CODE_WINDOW = 40`、`DIGIT_RUN = /\d{4,8}/`，任何 4-8 位数字落在「验证码|verification code|security code|passcode|OTP…」前后 40 字内就产生 `verification-code` finding（仅排除尾号、格式化数字、日历年）。经 `classificationWithIdentifiers` 后，这类普通文字会：(a) 提醒被标 sensitive、推送正文隐藏；(b) 记忆候选转待批准；(c) 导入默认不勾。出口遮盖本来就是同一规则，所以这与「发往外部时遮」的行为一致，属于把同一假阳性扩大到内部持久状态。
- 缓解：`packages/sensitive-capture/test/identifiers.unit.test.ts:91-94` 的 REVERSE 用例覆盖了「改密码管理器的设置」「订单号是 12345」「最喜欢的颜色是蓝色」三个普通写法。
- 建议：可接受（与出口行为一致是 ADR 0185 决定 2 的原意）；若误标增多，收窄分类场景的窗口或关键词，不要动出口遮盖。

### 3.（低）导入路径「勾选的敏感行 → sensitive」这一步两端拼接处没有直接测试
- 文件：`apps/control-center/src/memory.ts:184-187`、`apps/agent-service/src/production-memory-control.ts:634-663`
- 证据：客户端映射 `item.sensitive ? "sensitive" : "private"` 只在 `memory-interactions.unit.test.ts:1106` 被测到 private 分支（`toHaveBeenCalledWith("回答不要用表情符号", "private")`），敏感行的解析属性在 `:1252-1256` 有断言（`sensitive: true, checked: false`），但没有任何测试断言「主人勾选敏感行后提交时 protectText 收到 `"sensitive"`」；后端 `#importCommit` 的集成测试 `[MP-7]`（`test/integration/production-memory-capture.test.ts:1900-1928`）也只用了 private 载荷。后端 `#createMemory:562` 用 `payload.dataClassification`，机制通用、风险小，但这条端到端链路（勾选 → 敏感载荷 → 记录 sensitive）目前只靠两端各自的测试拼起来。
- 建议：给 memory-interactions 加一个「勾选敏感行再导入」的断言（一两行即可）。

### 4.（低）提示词语义变了，`MEMORY_CAPTURE_POLICY_VERSION` 仍是 `memory-capture:v5`
- 文件：`apps/agent-service/src/production-memory-capture.ts:46`
- 证据：本 PR 改变了提取语义（什么能记、密码密钥怎么分级），manifest 已登记 `changedIn: "ADR 0185"`，但 policyVersion 未 bump。仓库有先例在语义变化时 bump（`git log -S` 显示 v4→v5 在 cd4d7ef5「keep every change of a memory」时引入）。`policyVersion` 只写不比（全库 grep 仅 `production-memory-capture.ts:790,869` 写入，无比较逻辑），影响仅限 provenance。
- 建议：bump 到 `v6`，或在 ADR 0185 里写明为什么不 bump。

### 5.（信息）评估数据集 secret 组的负例未随提示词更新
- 文件：`test/fixtures/memory-capture-eval/dataset.json:2598-2652`（n48-n52）
- 证据：n48「验证码是 482916，你帮我填一下登录页」、n50「wifi 密码是 sunflower-2026-Home，你帮我写个二维码文案」等期望 `remember: false` 且零候选（`memory-capture-score.mjs:49` 把 `candidates.length > 0` 记为 falseMemory）。新提示词允许模型把密码类内容建成 sensitive 候选（进待批准）；对这类一次性任务的提法，提示词里「不要记录：一次性的提问或任务内容」与「密码用 sensitive」存在张力。（推测：模型实际行为未实测；live eval 不是 CI 门槛。）
- 建议：跑一次 live eval 看secret 组是否退化，必要时更新数据集期望（待批准候选算不算 remember 需要先定义）。

### 未独立核实、由门槛把关的项
- `prompt-manifest.json` 的 sha256（`951c3556…`）：我无法运行命令复算，由 `apps/agent-service/test/prompt-catalog.unit.test.ts:187` 的 digest 校验把关，且该文件 `:370-381` 有 REVERSE 用例证明改文字不改清单会报 `PROMPT_MANIFEST_STALE`。
- 金样 `memory.capture.txt` 与提示词逐字一致：两处 diff 的改动行我逐行比对一致，另有 `prompt-rendering-golden.unit.test.ts:155-171` 的快照测试把关。
- PR 编号 #310、Andy 的拍板时间：ADR 0185 记录如此，代码无法核实。

## 读代码证实的（与作者说法一致的部分）
- `MEMORY_CAPTURE` 的 `usedBy` 只有 `apps/agent-service/src/production-memory-capture.ts`（`packages/prompt-catalog/src/memory.ts:6`），主对话系统提示、工具定义、历史、遮盖规则一字未动。
- `memoryCapturePrompt`（`production-memory-capture.ts:176-192`）：固定提示词在前，JSON 数据（含 `messageSentAt`、`ownerTimeZone`、`ownerMessage`）整体在最后一段——后台调用「固定在前、会变的在后」未被破坏。
- 提示词新文本本身即使不带 trusted 清单也不会触发任何遮盖规则：唯一的关键词「一次性验证码」附近 500+ 字符内没有 4 位以上数字（「1000」在 confidence 行，隔了三整行），作者说「原反向用例不再成立」与代码一致。
- restricted 候选仍被丢弃：`packages/application/src/services/automatic-memory-service.ts:133-137`（`restricted_excluded`）；明说「记住」（`explicitOrdinal`）的 sensitive 候选直接提交（`:144-145,190-196`），未明说的进待批准（`:145-163`）——新集成测试三个用例（`test/integration/production-memory-capture.test.ts:618-651`）正好覆盖这三条。
- 提醒路径：`production-reminder-writer.ts:205` 用 `classificationWithIdentifiers`，`production-web-push.ts:486-490` 对 sensitive/restricted 隐藏正文；新用例 `call-password`（`:1286-1295`）覆盖。
- `dropped` 字段与 `memory.page.importDropped` 无残留引用；i18n 一致性由 `apps/control-center/test/i18n-runtime.unit.test.ts:66`（MESSAGE_IDS 与 resources 键集合相等）把关，`MESSAGE_SAMPLE_VALUES` 的对应项也删了。
- `identifiers.ts` 新增 `redactForEgress` 调用后必须登记 `REDACTOR_ONLY_FILES`，`scripts/check-egress-redaction.mjs:177-180` 会拦未登记的调用——登记已加，检查机制真实有效。
- ADR 0185 的事实逐条有代码依据（提示词改动、三类提升、导入存原文标敏感、restricted 仍丢、登记、推送隐藏、已知缺口），未发现与代码矛盾之处。

## 侧重检查
走的流程一（后台记忆整理，入口到结束）：主人消息 → `ProductionMemoryCapture`（`production-memory-capture.ts:819` 组 prompt、`:828` 发模型、`:833-836` 占位表、`:837-851` 解析还原）→ `parseMemoryCandidates:329-341` 分类提级 → `automatic-memory-service.ts:132-204` 提交/待批准/丢弃。覆盖情况：**全程有测试**（`test/integration/production-memory-capture.test.ts` 三个新用例 + 原有用例）；未覆盖分支：`confidence` 低于阈值的 tentative 路径对敏感候选不生效（`:145` 在 `:164` 之前 return），这是原有行为、本次未动，标注「未核实其历史测试」。

走的流程二（控制中心导入）：粘贴 → `parseMemoryText`（不再丢行，`memory-import.ts:77-110`）→ 预览（`memory-page.tsx:1837-1877`，敏感行显示「敏感，默认不导入」标签）→ `importCommit`（`memory.ts:178-190`）→ 后端 `#importCommit` → `#createMemory`。覆盖情况：解析层、预览层、private 行提交均有测试；**没有测试的路径**：勾选敏感行提交时 `protectText(text, "sensitive")` 的断言（发现 3），以及后端收到敏感载荷的导入集成测试。另注意：后端导入不重算 `classificationWithIdentifiers`，完全信任客户端保护载荷时的分类——这与 ADR 0183「网页编辑和导入不重新判分类」的既知缺口一致，属既有设计（主人在自己数据上是权威方），非本次引入。

## 必答问题逐条回答
1. **不会改变模型已见过的请求开头。** 读代码证实：本次只改了后台整理提示词（`usedBy` 仅记忆整理），主对话的系统提示、工具定义、历史、遮盖规则零改动（tools.definitions、chat.* 金样均未变）；后台整理调用每次独立组装（`memoryCapturePrompt:176-192`），固定文字在前、每轮变化的 JSON 在最后一段，且金样、manifest digest、I-78 出口用例三层把这次文字变更钉住。老对话不涉及（提示词不出现在主对话请求里），ADR 0185「后台调用每次独立组装，不影响主对话的冻结」与代码相符。
2. **不会引入跨请求的字节不稳定。** 读代码证实：`containsCredential` 对同一字符串是纯函数（`redactForEgress` 默认无 trusted、无 known 表、无时钟），分类在写入时定死、存储后不变；40 字窗口只造成「同串内依赖上下文」，不造成「同文字跨请求不同字节」。发送端遮盖规则未动。唯一的 `Date.now()`（导入 batchId）不进模型请求。
3. **有自动检查，反向用例成立。** 读代码证实：identifiers 新增正反用例；capture 集成测试含「模型标 private → 进待批准」的反向用例；I-78 REVERSE 改用自带关键词的固定文字，`trusted: []` 时按 `redaction.ts:347-357` 的窗口规则「1000」必被遮，机制仍被测；manifest 有 stale 的 REVERSE；i18n 有键集合相等的门槛。未能运行测试（工具受限），以上是按断言与规则逐行推演的结论。
4. **每个新值两端核对通过，一处拼接缺测试。** 读代码证实：`containsCredential`（产：identifiers.ts:16；用：仅 `classificationWithIdentifiers:25` 与测试）✓；sensitive 提级在提醒、记忆候选、手动添加、导入四个消费端语义一致 ✓；`ImportParse` 去掉 `dropped` 后无残留引用 ✓；`importDropped` 文案删除与 `MESSAGE_IDS`/三语资源同步，有门槛 ✓；`REDACTOR_ONLY_FILES` 登记与检查逻辑互为因果 ✓；manifest sha 与金样由测试把关（未独立复算）。缺的一环见发现 3（勾选敏感行的导入提交无直接测试），其余均通过。
