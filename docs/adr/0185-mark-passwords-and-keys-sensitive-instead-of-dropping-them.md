---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-08"
---

# ADR 0185：密码、密钥、证件号、银行卡号标成敏感，不再标受限丢弃

> 2026-11-24 补：密码、密钥“明说记住就存成敏感”已由 [ADR 0286](0286-the-main-model-reads-and-writes-memory-itself.md) 改为一律不存；证件号、银行卡号当普通信息记，不再标敏感。

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

[ADR 0183](0183-mask-only-when-data-leaves-and-keep-the-original-inside.md) 去掉了存储这一侧的整段拦下，但留下三处还在丢或在露的地方：

1. 自动整理记忆的提示词（`packages/prompt-catalog/src/memory.ts`）仍让模型把证件号、银行卡号、密码、验证码标成 `restricted`，`restricted` 的候选会被直接丢弃。所以主人说“记住我的密码”时，模型照提示词标 `restricted`，最后还是没记住。
2. 密码、密钥不会把分类提到 sensitive（只有卡号、证件号会），含它们的提醒在推送通知正文里会原样显示在锁屏上。推送只看记忆的数据分级（`apps/agent-service/src/production-web-push.ts`）。
3. 网页导入记忆（粘贴文本和 Codex 文本这条路径）仍整行丢弃含密码、卡号字样的行。

<a id="owner-decisions"></a>

## Andy 的拍板

- 2026-11-08，对线程的三条建议回“按建议”：导入改成存原文并标敏感；含密码、密钥的提醒推送正文隐藏；记忆整理提示词改成密码、密钥、证件号、银行卡号标 sensitive、一次性验证码不记。

<a id="decision"></a>

## 决定

1. **提示词。** 记忆整理提示词不再要求把证件号、银行卡号、密码标成 `restricted`，改成与健康、财务等并列的 `sensitive`（topic 填 other）；“不要记录”里去掉“密码密钥等凭据”，换成“一次性验证码”。主人明说“记住”的候选直接存，否则进待批准（原有的 `explicit` 规则）。代码里 `restricted` 的候选仍被丢弃，只是提示词不再主动让模型这样标。
2. **敏感判断并入密码、密钥、验证码。** `classificationWithIdentifiers`（`packages/sensitive-capture/src/identifiers.ts`）在原来的卡号、证件号之外，用出口遮盖认出的 `machine-secret`、`password`、`verification-code` 三类，把 private 或 public 的文字至少提到 sensitive。自动整理记忆、模型提的提醒、网页手动添加的记忆和提醒都走这个函数，所以被这样认出来的提醒，推送正文自动隐藏；认不出的写法见“已知缺口”。
3. **导入改存原文并标敏感。** `parseMemoryText` 不再丢行；命中 `mentionsSensitiveMaterial` 或 `classificationWithIdentifiers` 认出凭据、卡号、证件号的行标 `sensitive`、默认不勾选，主人勾了再导入，导入时分类是 sensitive。丢行计数 `dropped` 和界面里“另有 N 条……已直接丢掉”的说明（`memory.page.importDropped`）一并删除。
4. **登记。** `identifiers.ts` 调用 `redactForEgress`，登记进 `scripts/check-egress-redaction.mjs` 的 `REDACTOR_ONLY_FILES`。

<a id="options"></a>

## 放弃的做法

- **提示词保持原样、只靠代码补**：模型照提示词标 `restricted`，代码补不回来。
- **推送正文一律不带记忆文字**：太粗，普通提醒本来就该显示内容。
- **导入默认勾选敏感行**：导入的是别的 AI 导出的整批内容，敏感行默认不进更稳妥；主人可以自己勾。

<a id="consequences"></a>

## 后果

- 正面：主人明说要记的密码和密钥能记住；含它们的提醒不再露在锁屏上；导入不再静默吞数据。
- 代价：`sensitive` 记忆不进全文和实体索引、不带入档案块（[自建记忆引擎设计](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/execution/specs/2026-10-25-self-built-memory-engine-design.md)），所以存下来的密码在记忆页能看到，但模型在对话里检索不到它。这是 `sensitive` 一直以来的行为，不是本决定新增；要让模型能用，需要另做经主人确认的敏感记忆读取路径。（模型看不到敏感记忆、不带入档案块这两点已由 [ADR 0193](0193-memory-is-visible-to-the-model.md) 改为模型能看到、会带入档案块；全文和实体索引留给后续 PR。）
- 负面：自动整理里出现密码、密钥且主人没明说“记住”的候选会进待批准，批准多一次；提示词改动让后台整理调用的开头字节变了一次（后台调用每次独立组装，不影响主对话的冻结）。
- 已知缺口（留给敏感信息识别升级）：密码规则取值到空白、逗号、分号为止；判断仍是关键词加格式的启发式，“password is …”这类英文写法和关键词与值之间没有“是”“为”或冒号的写法认不出。（由 [ADR 0188](0188-recognize-passwords-without-a-separator.md) 补上其中大部分，原文不改。）
- 后续：[ADR 0183](0183-mask-only-when-data-leaves-and-keep-the-original-inside.md) 里“密码、密钥不会把分类提到 sensitive”“网页导入仍整行丢弃”两处已知缺口由本决定关闭，原文不改，在原处加了指向本文的说明。

<a id="references"></a>

## 关联文档

- [ADR 0183：只在数据发往外部时遮盖，内部存储和展示用原文](0183-mask-only-when-data-leaves-and-keep-the-original-inside.md)
- [ADR 0167：敏感信息识别包](0167-sensitive-capture-package.md)
- 代码：`packages/prompt-catalog/src/memory.ts`、`packages/sensitive-capture/src/identifiers.ts`、`apps/control-center/src/memory-import.ts`

[返回阅读导航](#contents)
