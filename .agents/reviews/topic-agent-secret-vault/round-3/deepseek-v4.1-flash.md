CLAIM|1|一致|docs/adr/0185-mark-passwords-and-keys-sensitive-instead-of-dropping-them.md:43|现在的做法是“你说记住就存成敏感记忆”（ADR 0185）|1. **提示词。** 记忆整理提示词不再要求把证件号、银行卡号、密码标成 `restricted`，改成与健康、财务等并列的 `sensitive`（topic 填 other）；“不要记录”里去掉“密码密钥等凭据”，换成“一次性验证码”。主人明说“记住”的候选直接存，否则进待批准（原有的 `explicit` 规则）。代码里 `restricted` 的候选仍被丢弃，只是提示词不再主动让模型这样标。
CLAIM|2|一致|docs/adr/0185-mark-passwords-and-keys-sensitive-instead-of-dropping-them.md:61|值会进记忆|所以存下来的密码在记忆页能看到，但模型在对话里检索不到它。
CLAIM|3|一致|docs/adr/0193-memory-is-visible-to-the-model.md:56|进模型|1. **两套分级分开。**“模型能看到什么”由固定的模型可见上限决定，上限是 sensitive，写在代码里（`packages/application/src/services/model-visibility.ts` 的 `modelVisibleCeiling()`），不再可配置；restricted 永远不给模型。运行分级（run 的 `dataClassification`）仍只管工具、推送和日志，聊天运行照旧是 private。
CLAIM|4|一致|docs/adr/0121-web-search-on-by-default-bound-to-search-services-only.md:44|付款、转账这类不可撤销的动作，照现有规则单独再问。|4. **不可撤回的操作照旧逐次确认。** 本决定只针对联网搜索和读网页这两个只读、没有副作用的工具；付款、发邮件、改文件、执行命令等仍按原有审批规则。
CLAIM|5|一致|packages/platform-node/src/payload-protector.ts:128|值用仓库已有的信封加密代码（packages/platform-node/src/payload-protector.ts，AES-256-GCM）加密|const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
CLAIM|6|一致|packages/application/src/services/web-capability-service.ts:319|接到现有的“先准备、执行前核对页面没变”的机制上（packages/application/src/services/web-capability-service.ts）。|if (inspected.pageVersion !== action.pageVersion || inspected.finalUrl !== action.finalUrl) {
CLAIM|7|一致|packages/platform-node/src/payload-protector.ts:273|可轮换（已有的 rewrap 代码）。|async rewrap(request: PayloadRewrapRequest): Promise<PayloadRecord> {
CLAIM|8|不一致|scripts/render-brand-assets.mjs:2|仓库现在只有测试用的|import { chromium } from "playwright";
CLAIM|9|一致|docs/adr/0278-tasks-the-owner-agreed-to-ask-before-writing-after-external-content.md:48|现有规则（ADR 0278）要求每个写操作单独问。|于是同意过的任务读到外部内容后，写操作由 `askAfterExternalContent` 接手，每一个都要主人批准；
CLAIM|10|找不到|-|登录本身算写操作|-|
CLAIM|11|一致|AGENTS.md:14|原则顺序：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率（AGENTS.md，“原则之间冲突时按这个顺序裁决”）。|- 原则之间冲突时按这个顺序裁决：用户主权，其次边界与可逆性，其次记忆可靠性，其次主动性与效率。当一个设计在两条原则之间取舍时，要写明它依据的是哪一条原则。
CLAIM|12|一致|docs/product-vision.md:39|自有优先：“运行在自有设备或我租用并控制的服务器上……数据不落在任何第三方平台的 SaaS 里”（docs/product-vision.md:39）。|> **「自有优先、数据自持」定义**：Himawari 的运行环境与数据由我控制——运行在自有设备或我租用并控制的服务器上（当前实际部署：我自租的 Contabo 云主机，经 Cloudflare 域名对外提供服务），数据不落在任何第三方平台的 SaaS 里，且我可完整迁移、备份与删除。它不是严格意义的 local-first（数据只存于本地设备），而是 self-hosted（自托管）：判定标准是主权在谁手里，而不是数据物理上在哪台机器。
CLAIM|13|一致|docs/adr/0148-send-every-model-request-through-one-in-process-egress.md:59|出口遮盖不在工具参数里还原占位符：“在工具参数里也还原占位符：本次不做”（docs/adr/0148-send-every-model-request-through-one-in-process-egress.md:59）。|- **在工具参数里也还原占位符**：本次不做，需要单独评审工具执行和权限。
CLAIM|14|一致|docs/adr/0183-mask-only-when-data-leaves-and-keep-the-original-inside.md:38|内部存储用原文：“敏感信息只在数据发往外部……时遮盖；Himawari 自己的存储和界面展示用主人的原文”（docs/adr/0183-mask-only-when-data-leaves-and-keep-the-original-inside.md）。|- 2026-11-06：敏感信息只在数据发往外部（模型、网页搜索、TypeSafe 这类外部服务）时遮盖；Himawari 自己的存储和界面展示用主人的原文。能接受的代价：机器密钥的占位符 `[密钥]` 没有编号、无法还原；Andy 自己的数据库里会多几份明文拷贝。
CLAIM|15|一致|packages/platform-node/src/payload-protector.ts:16|已有信封加密：`PAYLOAD_ALGORITHM = "aes-256-gcm-envelope-v1"`|export const PAYLOAD_ALGORITHM = "aes-256-gcm-envelope-v1" as const;
CLAIM|16|一致|packages/platform-node/src/payload-protector.ts:183|`class EnvelopePayloadProtector`|export class EnvelopePayloadProtector implements PayloadProtectorPort {
CLAIM|17|一致|packages/runtime-sandbox/src/network-egress.ts:138|沙箱出口代理对 https 只做隧道：`server.on("connect", ...)`（packages/runtime-sandbox/src/network-egress.ts:138）。|server.on("connect", (req, clientStream, head) => {
CLAIM|18|一致|apps/execution-worker/src/program-secret-injection.ts:11|沙箱程序注入：`if (!input.secrets || !input.networkOnly) throw new Error("SANDBOX_SECRET_UNSUPPORTED")`（apps/execution-worker/src/program-secret-injection.ts:11）。|  if (!input.secrets || !input.networkOnly) throw new Error("SANDBOX_SECRET_UNSUPPORTED");
CLAIM|19|一致|packages/application/src/services/web-capability-service.ts:118|已有带登录的网页会话和先准备再执行：`async establishSession`|  async establishSession(input: {
CLAIM|20|一致|packages/application/src/services/web-capability-service.ts:234|`async prepareAction`|  async prepareAction(input: {
CLAIM|21|一致|packages/application/src/services/web-capability-service.ts:285|`async executeAction`|  async executeAction(input: {
CLAIM|22|一致|packages/application/src/ports/web.ts:158|端口 `AuthenticatedWebAdapterPort`（packages/application/src/ports/web.ts:158）|export interface AuthenticatedWebAdapterPort {
CLAIM|23|一致|packages/integration-web/test/web-capability.unit.test.ts:84|生产没有它的实现|class FixtureAuthenticatedAdapter implements AuthenticatedWebAdapterPort {
CLAIM|24|一致|docs/adr/0031-isolated-tool-execution.md:39|浏览器自动化必须在隔离环境：“浏览器自动化……默认必须在独立隔离执行环境执行”（docs/adr/0031-isolated-tool-execution.md:39）。|Shell、任意代码、编译器、构建工具、包管理器及其安装脚本、测试程序、Git 写操作、浏览器自动化、第三方 CLI，以及其他可能修改文件、访问网络、启动进程或产生外部副作用的 Agent 工具，默认必须在独立隔离执行环境执行，不得直接在 Agent 主进程或 Host Control Plane 执行。
CLAIM|25|一致|docs/adr/0257-consequential-tool-calls-go-through-one-authorization-exit.md:139|统一授权出口：“所有登记为‘有后果’的工具调用，执行前走同一个函数”（docs/adr/0257-consequential-tool-calls-go-through-one-authorization-exit.md:139）。|所有登记为“有后果”的工具调用，执行前走同一个函数：组动作意图，判断，然后放行、等主人点头，或者不做。
CLAIM|26|一致|docs/adr/0278-tasks-the-owner-agreed-to-ask-before-writing-after-external-content.md:48|读过外部内容后写操作：“写操作由 askAfterExternalContent 接手，每一个都要主人批准”（docs/adr/0278-tasks-the-owner-agreed-to-ask-before-writing-after-external-content.md:48）。|于是同意过的任务读到外部内容后，写操作由 `askAfterExternalContent` 接手，每一个都要主人批准；
CLAIM|27|不一致|scripts/render-brand-assets.mjs:2|仓库只有测试用的 Playwright|import { chromium } from "playwright";
CLAIM|28|一致|package.json:120|`"@playwright/test": "1.62.1"`（package.json:120）|    "@playwright/test": "1.62.1",
CLAIM|29|找不到|-|记忆方案 v3 第 5 条：“密码、密钥一律不记……以后接一个类似苹果密码管理器的工具……（这一版不做）”|-|

未核实：记忆方案 v3 第 5 条的原文在仓库和 git 历史中都没有找到；附：讨论记录里的 round-1 文件在稀疏检出中未读到。登录是否算写操作在 ADR 0278 中没有明文，判为找不到；“生产没有 AuthenticatedWebAdapterPort 实现”只按当前可见文件检索得出。
