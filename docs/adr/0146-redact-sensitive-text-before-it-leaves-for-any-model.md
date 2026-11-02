---
status: superseded
document_type: adr
decision_status: superseded
supersedes: ""
superseded_by: docs/adr/0148-send-every-model-request-through-one-in-process-egress.md
date: "2026-11-01"
---

# ADR 0146：送给任何外部模型的文字，先统一遮盖敏感信息

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

2026-11-01，Andy 在评审 Gmail 带记忆方案时要求：凡是送给模型的内容，都要在项目级统一遮掉验证码、卡号、密码这类敏感信息，不要各处各自整封跳过（方案全文和前提来源见项目文件 `redaction/plan.md`，Andy 当天回复“全部同意”）。

改动前的状况：

1. 通用规则只有机器密钥（`machine-secret-exclusion.ts`）；对话辅助调用命中就整次拒绝（`AI_GATEWAY_INPUT_REJECTED`），模型输出才被遮盖。
2. 主对话经 `packages/runtime-pi/src/pi-runtime-adapter.ts` 的 `admitPiStream` 发出，原本没有任何遮盖。
3. 嵌入（`packages/memory-engine/src/embedding.ts` 的 `embed`）没有任何检查。
4. Gmail 检查对验证码、13 到 19 位数字、“密码:”整封跳过；其中卡号规则会把订单号当卡号。

<a id="decision"></a>

## 决定

1. 新增 `packages/application/src/services/egress-redaction.ts` 的 `redactForEgress`：确定性的规则程序，不调用模型。遮盖五类：机器密钥 `[密钥]`、密码 `[密码]`、验证码 `[验证码]`、银行卡 `[银行卡 尾号NNNN]`（银行卡网络前缀加 Luhn 校验位）、证件号 `[证件号]`（身份证校验位、IBAN mod97、带关键词的日本个人番号校验位）。姓名、邮箱、电话、地址不遮。
2. 三个出口都先遮盖：主对话（`redactModelContext`，逐条消息独立遮盖用户文字、工具结果、助手文字和工具调用参数，不动推理块）、辅助模型调用（`PiModelTransport`）、嵌入（`GatewayEmbedder.embed`）。命中后继续，不再拒绝，不再整封邮件跳过。
3. KV 缓存：遮盖结果只取决于这一条消息自己的文字；占位符说明那一段固定文字，主对话总是附在系统提示末尾，不论本轮有没有遮到东西。辅助调用是一次性提示，只在命中时附在末尾。
4. 模型回复里的占位符不还原；原文留在 Andy 的服务器上，界面显示原文，只有送出的副本被遮。
5. 门槛：`npm run check:egress-redaction`（`scripts/check-egress-redaction.mjs`）要求登记的三个出口都调用脱敏，并拒绝任何未登记的模型或嵌入请求出口；`packages/application/test/egress-redaction.unit.test.ts` 与 `packages/runtime-pi/test/egress-context.unit.test.ts` 覆盖正例、反例、幂等和前缀稳定。
6. 存储边界的“命中机器密钥就拒绝”（记忆整理、检查点、文件读取）不变。

<a id="options"></a>

## 放弃的做法

- **写入时遮盖并落盘**：会丢掉原件，规则升级后旧数据要重扫；发送时遮盖同样不破坏缓存。
- **让模型只看到密钥句柄**：方向对，但属于工具和权限设计，是另一个大改动。
- **统计阈值（召回 99.5% 之类）**：规则是确定的，已定义的样例直接要求 100%。

<a id="consequences"></a>

## 后果

- 上线后第一次，主对话的系统提示多一段固定说明，缓存重新计算一次，之后恢复；日后改规则同理。
- 银行卡规则用前缀加校验位，随机的 16 位数字仍有一小部分会通过（前缀限定后约百分之几），会被误遮成银行卡；这是已知的取舍，反例测试集记录每个误遮。
- 推理块不遮盖（带签名，改动会使签名失效）。
- 嵌入换成本机模型是更彻底的做法，未包含在本决定内。

<a id="references"></a>

## 关联文档

[ADR 0134](0134-adopt-product-vision-v2-2.md)、[产品愿景](../product-vision.md#principles)
