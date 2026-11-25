---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-05"
covers: "apps/agent-service/src/production-memory-capture.ts, apps/control-center/src/memory-import.ts, ci/security-exceptions.json, packages/application/src/services/egress-legend.ts, packages/application/src/services/trace-redaction.ts, packages/application/test/egress-himawari-text.unit.test.ts, packages/application/test/machine-secret-exclusion.unit.test.ts, packages/integration-web/src/untrusted-content.ts, packages/runtime-pi/src/pi-runtime-adapter.ts, scripts/ci/redact-text.mjs, scripts/ci/security-source.mjs, scripts/scan-machine-secrets.mjs, test/tooling/egress-redaction-check.test.mjs"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0167：敏感信息识别独立成 sensitive-capture 包

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [Andy 的拍板](#owner-decisions)
- [决定](#decision)
- [检查](#checks)
- [上线影响](#rollout)
- [没有处理的部分](#open-questions)

<a id="context"></a>

## 背景

识别敏感信息的规则原先分散在几处。

- 发给模型前的遮盖（`redactForEgress`）在 [packages/application/src/services/egress-redaction.ts](https://github.com/sixianli/himawari-agent/blob/90109e79aa6ba9313191d96d50d6815e16425ea1/packages/application/src/services/egress-redaction.ts)，管密码、验证码、银行卡、证件号。
- 机器密钥规则在同一目录的 [machine-secret-exclusion.ts](https://github.com/sixianli/himawari-agent/blob/9ac0769e5d56162e4574b46e66600515c461d3ef/test/qualification/evidence/workspace-authorization-lifecycle/p1-error-contract-01/input-freeze.json)，包括私钥、Bearer、JWT、OpenAI、GitHub、AWS 和通用赋值。
- 自动整理记忆时判断“受限信息”的正则写在 `apps/agent-service/src/production-memory-capture.ts`。
- 网页导入记忆时提示“可能敏感”的正则写在 `apps/control-center/src/memory-import.ts`。
- 网页抓取内容里遮密钥的正则写在 `packages/integration-web/src/untrusted-content.ts`。
- 给诊断日志打码时判断敏感字段名、网址参数名的两条正则写在 `packages/runtime-pi/src/pi-runtime-adapter.ts`；追踪记录打码用的敏感字段名清单写在 `packages/application/src/services/trace-redaction.ts`。

前两份和记忆、提醒这些业务代码同在 `packages/application` 里，无法单独拿出去用。

接下来要做两件事：一是新增“敏感信息拦截记录”页面，二是照搬 secretlint 和 detect-secrets 的规则（方案见 2026-11-05 项目讨论）。动手之前先把识别能力集中到一处。

<a id="owner-decisions"></a>

## Andy 的拍板

- 2026-11-05：“我希望后面可以单独拆出来这一块，无论是后面开源出去给别人用也好……就是把它当做一个单独的模块来开发。”线程提出把它作为第 0 步，先拆包、不改行为，Andy 回复“同意”。
- 同日补充：“包名换成 packages/sensitive-capture”。

<a id="decision"></a>

## 决定

1. **新包 `@himawari-agent/sensitive-capture`**（`packages/sensitive-capture`）。
   - 只放识别和遮盖本身，不依赖 Himawari 的其他包，不做文件、数据库或网络读写，浏览器里也能用。
   - 原来的两个文件原样搬进来，改名为 `src/redaction.ts` 和 `src/machine-secrets.ts`；导出的函数名和行为都不变。
2. **散在别处的规则也搬进来**，规则本身不变。
   - `containsRestrictedIdentifier`：记忆、提醒和 Muse 在存储时用它。规则偏宽：16 到 19 位的连续数字，或身份证号的格式，都算受限，不看校验位。（[ADR 0183](0183-mask-only-when-data-leaves-and-keep-the-original-inside.md) 起，存储这一侧只用它把分类提高到“敏感”，不再拦下。）
   - `mentionsSensitiveMaterial`：网页导入记忆时用它给出提示。
   - `isSensitiveFieldName`、`isSensitiveQueryParameter`：诊断日志打码时判断字段名和网址参数名。
   - `redactWebContentSecrets`（`src/web-content.ts`）：网页抓取内容里的密钥换成 `[REDACTED_MACHINE_SECRET]`。
   - `isSensitiveTraceKey`：追踪记录打码时判断字段名，去掉大小写和分隔符后整名比对，和上一条按片段匹配的规则用途不同，两条都保留。
   - 后四条是代码复核第 1、2 轮找出的漏搬规则。
   - 原来打算让存储这一侧也改用出口遮盖那套带校验位的规则。但测试里“我的卡号是 6222020200112233445”过不了 Luhn 校验（银行卡号的校验位算法），改了就会被当作普通记忆存下。存储这一侧宁可多拦，所以保留宽的规则。两套规则用途不同，都放在这个包里。
3. **Himawari 自己的部分留在原处。**
   - 两句占位符说明（来自提示词目录）放在 `packages/application/src/services/egress-legend.ts`。
   - 在请求体里逐段遮盖的 `model-egress.ts` 仍在 application 包里。
4. **调用方直接从新包引用。** apps/agent-service、application、platform-node、runtime-pi、control-center 共 40 多个文件改了 import；没有在旧包里留转发。
5. **测试**：识别规则的测试搬进 `packages/sensitive-capture/test/`。只和 Himawari 文字有关的用例留在 application，即运行环境说明和占位符说明，放在 `packages/application/test/egress-himawari-text.unit.test.ts`。含 JWT 假密钥的 `packages/application/test/machine-secret-exclusion.unit.test.ts` 留在原路径，只改 import、不改行号：gitleaks 的例外清单（`ci/security-exceptions.json`）按路径和行号记录了这些假密钥，那份清单要 Andy 审核。

<a id="checks"></a>

## 检查

- `npm run check:egress-redaction` 新增一项：产品代码（`apps/*/src`、`packages/*/src` 下的 `.ts`、`.tsx`、`.mts`、`.cts`、`.js`、`.mjs`、`.cjs`）里，除了 `packages/sensitive-capture/src/`，不得出现识别规则的特征写法，包括私钥块、AWS key、GitHub token、JWT、OpenAI key、Bearer、`api_key` 这类赋值、身份证号格式、银行卡号位数、Luhn 校验，正则里成串的“密码、口令、验证码、password”等关键词，以及 `"clientsecret"`、`"accesstoken"` 这类敏感字段名清单。这项检查第一版就抓到了网页导入那条；代码复核指出它太窄后放宽，又抓到了网页抓取和诊断日志打码那三条。反向用例在 `test/tooling/egress-redaction-check.test.mjs`，包括这几条旧规则原本的写法，以及一个日期解析不误报的用例。
- 这项检查是按特征写法匹配，换个写法仍可能绕过；它防的是“顺手又写一条”，不是故意绕开。
- 行为不变由现有测试证明：出口遮盖、机器密钥、记忆凭据排除、模型出口、提示词前缀检查（`check:prompt-prefix`）全部原样通过，不需要改断言。

<a id="rollout"></a>

## 上线影响

无。发给模型的字节、存储时的判断、界面行为都和以前一样，不影响缓存。

<a id="open-questions"></a>

## 没有处理的部分

- CI 和工具脚本里还有三份机器密钥规则的副本：`scripts/ci/security-source.mjs`、`scripts/ci/redact-text.mjs`、`scripts/scan-machine-secrets.mjs`。它们直接用 node 运行，现在不能引用这个包的 TypeScript 源码，所以这次的检查只覆盖产品代码。要统一，需要让这个包能被 node 直接加载，另做。
- 机器密钥的测试还在 application 包里（原因见上面第 5 条）。真要开源时，要先和 Andy 一起更新 gitleaks 例外清单，再把它搬进包里。
- 还没有对外的文档和发布配置；包保持 `private`。
