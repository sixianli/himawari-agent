---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-08"
covers: ".agents/instructions/prompt-prefix.md, apps/agent-service/src/production-memory-capture.ts, apps/agent-service/src/production-thread-titles.ts, packages/sensitive-capture/src/identifiers.ts, packages/sensitive-capture/src/restoration.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0183：只在数据发往外部时遮盖，内部存储和展示用原文

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [Andy 的拍板](#owner-decisions)
- [决定](#decision)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

此前 Himawari 在两个地方对敏感信息“整段拦下”：

1. 内部存储这一侧：自动整理记忆、提醒、Muse 收件、沙箱诊断、对话检查点、反思、执行动态、对话标题等写库之前，用 `scanMachineSecrets`、`containsRestrictedIdentifier` 这类检测，命中就整条丢弃或拒绝（审计结果码 [source_secret_excluded](https://github.com/sixianli/himawari-agent/blob/01873f5c26c536750090ffbc3772ee0cc95bf3fc/packages/application/src/ports/automatic-memory.ts)、`candidate_secret_excluded`）。
2. 发往模型这一侧：[ADR 0148](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0148-send-every-model-request-through-one-in-process-egress.md) 的出口遮盖已经在做，命中后继续发送，遮盖后仍检出机器密钥才拒绝。

第 1 类让主人说“记住我的密码是……”这样明确要求的事做不成，也让记忆、标题里出现“被拦下”的空洞结果；而这些内容并不发往任何外部方。

<a id="owner-decisions"></a>

## Andy 的拍板

- 2026-11-06：敏感信息只在数据发往外部（模型、网页搜索、TypeSafe 这类外部服务）时遮盖；Himawari 自己的存储和界面展示用主人的原文。能接受的代价：机器密钥的占位符 `[密钥]` 没有编号、无法还原；Andy 自己的数据库里会多几份明文拷贝。
- 2026-11-08：存储这一侧不拦，但像卡号、证件号的文字至少标成“敏感”（需要主人批准、推送通知不显示正文），内容仍存原文。
- 2026-11-08：会话记录（`session-trace-recorder`）和运行日志里的网址参数遮盖保持现状；导出文件（`pi-output-export`）的遮盖保持现状，不在这次改。

<a id="decision"></a>

## 决定

1. **内部存储不再整段拦下。** 自动整理记忆、提醒、Muse 收件、沙箱诊断、对话检查点、反思、执行动态、对话标题、模型流式输出落库，都存原文，不整段丢弃或拒绝（占位符的还原见第 3 条）。`npm run check:egress-redaction` 里存储侧的 `SENSITIVE_GATE_CALLS` 登记项已随 PR3、PR4 删除；检查本身保留，新增整段拦下调用的未登记文件仍会让它失败。
2. **发往外部时照旧遮盖。** 出口遮盖（ADR 0148）和搜索服务的外部文字遮盖不变；发给模型的字节不变，符合[发给模型的内容只追加](../../.agents/instructions/prompt-prefix.md)。
3. **模型回复里的占位符，写库前还原。** 自动整理记忆和对话标题调用模型时，提示里的敏感值已被遮成占位符，模型可能把占位符抄进候选文字、原话或标题。写库前用“刚才实际发出的那条提示”重建占位符到原文的对照表，把占位符还原成原文：
   - 提示里的主人消息是 `JSON.stringify` 的产物，规则可能把结尾的引号和花括号一并吞进值里，所以对照表里的值先在第一个没被转义的引号处截断，再按 JSON 字符串解码。
   - 提示词目录里 Himawari 自己写的固定文字不算外来内容，建表时按 [ADR 0148](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0148-send-every-model-request-through-one-in-process-egress.md) 的规则排除。
   - 还原不了的占位符（模型改写、抄错编号）原样保留，不猜；`[密钥]` 没有编号，同样保留字面量。
4. **分类仍按检测结果往上提。** 自动整理记忆、模型提的提醒、网页手动添加的记忆和提醒，文字含 18 位证件号或去掉空格和连字符后 16 到 19 位数字时，分类至少是 sensitive（`classificationWithIdentifiers`）。模型自己标 restricted 的候选仍按原规则丢弃。这一条是启发式，不是安全边界。
5. **审计结果码删掉不再产生的两个。** [source_secret_excluded](https://github.com/sixianli/himawari-agent/blob/01873f5c26c536750090ffbc3772ee0cc95bf3fc/packages/application/src/ports/automatic-memory.ts)、`candidate_secret_excluded` 不再出现在类型里；拦截记录页面不再记“记忆没保存”这一类，历史上已写入的行照常显示。
6. **搜索说明文案改成与行为一致**：搜索词里像密码或密钥的部分“会先遮盖再发出”，不是“被拦下”。

<a id="options"></a>

## 放弃的做法

- **存储这一侧改用出口遮盖那套带校验位的规则判断敏感**：测试里的卡号过不了 Luhn 校验，改了会被当普通记忆存下；沿用宽规则只用来提高分类，误判的代价是多问主人一次。
- **服务端统一重新判分类**：记忆记录和内容载荷的分类必须一致，在服务端改会触发“分类不一致”的报错；所以分类在写入前由客户端和各写入方算好。
- **把还原做在出口的响应流里**：记忆整理和标题是后台调用，没有显示端；表要按它们各自发出的提示重建。

<a id="consequences"></a>

## 后果

- 正面：主人明说要记的事能记住；记忆和标题里不再出现被拦下的空洞结果。
- 负面：主人的数据库里会有密码、密钥的明文拷贝；`[密钥]` 无法还原；经批准的敏感记忆存成普通分类（[ADR 0166](0166-prompt-wording-batch-1-system-and-tools.md) 之前的设计）后，提醒的推送正文是否显示取决于记忆的数据分级（`dataClassification`）。
- 已知缺口：自动检测只会在卡号、证件号时把 private 或 public 提到 sensitive，密码、密钥不会；模型自报的 sensitive、restricted 和来源分类仍会提高分类，推送正文是否显示取决于最终的 `dataClassification`，所以没被提高的含密码、密钥的提醒会在推送通知正文里原样显示；推送内容按端到端加密发给主人的浏览器，但会显示在锁屏上。要兑现“推送不显示正文”，需要把密码、密钥检测加进分类提升规则或让推送正文一律不带记忆文字，这是产品取舍，留给 Andy 定。（[ADR 0185](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0185-mark-passwords-and-keys-sensitive-instead-of-dropping-them.md) 已关闭这一条。）
- 已知缺口（留给敏感信息识别升级）：密码规则取值到空白、逗号、分号为止；服务端“添加记忆”不检查敏感不能置顶；网页编辑和导入不重新判分类；审批门槛依赖模型自报的 `explicit`。
- 与 PRD 的关系：[PRD v0.2](../prd-v0.2.md) “非目标”和“机器秘密、敏感数据与可观察 Trace”两节原来写着机器秘密不进长期记忆、要在记忆提取之前排除。Andy 2026-11-08 说“改 PRD”，这几句已改成与本决定一致，覆盖清单（[test/fixtures/v0.2/coverage-manifest.json](https://github.com/sixianli/himawari-agent/blob/6abd00099bce49f2231aebdea8174e8fb6ff46e8/test/qualification/evidence/workspace-authorization-lifecycle/p1-error-contract-01/input-freeze.json)）和 S0 规格里记录的 PRD 摘要同步更新。
- 另有两处遗留：2026-08 的基础规格和计划（`2026-08-26-portable-durable-web-agent-design.md`、`2026-08-26-portable-durable-web-agent-plan.md`、`2026-08-26-v0.2-spec-suite-integration-plan.md`）仍写着“machine secret 在提取、嵌入、模型调用前排除，不进入 Memory 或迁移包”，按本决定取代，没有逐条改；网页导入记忆里粘贴文本和 Codex 文本这条路径（`memory-import.ts` 的 `parseMemoryText`）仍会整行丢弃含密码、卡号等字样的行（JSON 导出导入不丢），这是 PR3、PR4 没动的旧行为，留给 Andy 定是否也改成存原文并标敏感。（其中网页导入一项已由 [ADR 0185](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0185-mark-passwords-and-keys-sensitive-instead-of-dropping-them.md) 关闭，旧规格和计划一项仍在。）
- 后续：本决定部分取代的旧说法在原 ADR 里加了指向本文的说明，决定内容不改：ADR 0166 的 W-07b、ADR 0143 第 12 条里的 `candidate_secret_excluded`、ADR 0167 决定第 2 条“存储宁可多拦”、ADR 0148 第 6 条“还原只在主对话的显示端”。

<a id="references"></a>

## 关联文档

- [ADR 0148：所有模型请求走同一个进程内出口](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0148-send-every-model-request-through-one-in-process-egress.md)
- [ADR 0167：敏感信息识别包](0167-sensitive-capture-package.md)
- [ADR 0166：提示词措辞第 1 批](0166-prompt-wording-batch-1-system-and-tools.md)
- [ADR 0143：模型门槛决定的账本](0143-decision-ledger-for-model-gate-decisions.md)
- [产品愿景 v2.3：自有优先、数据自持](../product-vision.md)
- 代码：`packages/sensitive-capture/src/restoration.ts`、`packages/sensitive-capture/src/identifiers.ts`、`apps/agent-service/src/production-memory-capture.ts`、`apps/agent-service/src/production-thread-titles.ts`

[返回阅读导航](#contents)
