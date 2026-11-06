我先按方案里引用的关键文件和规则逐条核对。先读规则、出口遮盖核心、事件门禁文档。
# 方案 v2 审核报告

先说结论总览：方案的大方向（把「整段拦下」换成「末尾遮盖」、出口遮盖保留、存储存原文）与代码现状和 `.claude/rules/prompt-prefix.md` 的既有规则一致；但方案文字只指名了少数几个拦截点，实际拦截点约 49 处里的十几处（主要是存储侧和搜索/读网页结果侧）没有在甲/乙/丙分类里交代，其中两处会让方案的核心承诺（「照常存」「照常返回」）落空；「命令完整输出」的开工前置问题现在就能回答。以下按严重度排列。

## 证实的问题

### 1.（高）丙类不完整：按方案的文字执行，「记忆/提醒照常存」做不到
方案的丙只写了「照常存、还原占位符、`credentialFindings` 不把占位符当凭据、沙箱诊断文字」。但存储侧还有一整层「命中即拒绝/跳过」的检查，方案通篇没点名，只在 49 处登记里隐含删除：

- `apps/agent-service/src/production-memory-control.ts:164-171`：`assertStorable` 命中 `scanMachineSecrets` 或 `containsRestrictedIdentifier` 直接抛 `MEMORY_TEXT_REFUSED` —— Andy 在页面上建一条含卡号的记忆会被拒，和丙「照常存」直接矛盾。
- `apps/agent-service/src/production-memory-capture.ts:752`：`if (scanMachineSecrets(message).length === 0)` —— 主人的话含机器密钥时**整轮记忆整理直接跳过**，丙要的「自动整理记忆照常进行」不会发生。
- `apps/agent-service/src/production-reminder-writer.ts:196-197`：提醒存储同样拒绝。
- `packages/application/src/services/automatic-memory-service.ts:104-113、137-143`：源文本含机器密钥 → `source_secret_excluded` 整批放弃；候选含密钥或凭据 → `candidate_secret_excluded` 丢弃。注意 `credentialFindings` 改成「不算占位符」并不解决它：占位符还原成原文之后，`password-keyword` 规则照样命中原值，候选仍会被丢。要实现「存原文」，这两个排除点必须一并处理，方案只改了 `credentialFindings` 一处。
- `packages/application/src/services/thread-checkpoint-service.ts:192、228、235`、`packages/application/src/services/reflection-service.ts:144`、`packages/application/src/services/workspace-copy-service.ts:74`（丁类「复制字节不动」依赖删它）、`packages/runtime-pi/src/host-read-only-executor.ts:143`、`apps/agent-service/src/capability-programs/pi-coding-request.ts:207`、`production-file-preparation.ts:52、68`、`apps/agent-service/src/capability-programs/host-file-read.ts:146`、`packages/platform-node/src/files/sandboxed-coding-operations.ts:165`（`PI_TEXT_READ_REJECTED`：编辑含密钥的文件——例如改 `.env`——会被整次拒绝，和丁/甲冲突；且这行的 NUL 检查和密钥检查写在同一个条件里，方案说「NUL 不动」，实施时要拆条件而不是删整行）。

建议：丙类把上面这份清单逐条列出、逐条表态保留或删除；凡是删除的，配「正向 + 反向」测试（和已有 `[MH-1]`、`production-memory-capture.test.ts` 那类走真实入口的做法一致）。

### 2.（高）Exa / DeepSeek 的**结果侧**拦截没进方案，会原样保留「整段拦下」
方案 premise 4 正确指出 Exa、DeepSeek 不经出口遮盖，但展开的改法只处理了**查询词**遮盖；这两个提供方的**返回结果**检查保留着：

- `packages/platform-node/src/exa-public-search.ts:251`（`WEB_SEARCH_OUTPUT_REDACTED`，整批搜索结果丢弃）、`:320`（`WEB_FETCH_OUTPUT_REDACTED`，整页丢弃）；
- `packages/platform-node/src/deepseek-web-provider.ts:33`；
- 另有 `apps/agent-service/src/capability-programs/pi-coding-main.ts` 的后台流式输出整段扫描（见 `docs/backlog/BL-20261016-003` 的描述）。

结果最终会作为工具结果经出口遮盖发给模型（`model-egress.ts` 覆盖所有消息文本），照 Andy 的决定和甲类逻辑应当删掉这几处。方案甲类只写了删 `pi-host-publication.ts` 4 句和 `web-provider-failure.ts` 2 条。建议把这三个文件的结果侧检查移入甲类，同步删/翻 `packages/platform-node/test/exa-mcp-transport.unit.test.ts:165、384`、`deepseek-web-provider.unit.test.ts:116` 和 `web-provider-chain.unit.test.ts:36` 的断言。

### 3.（高→开工即可定案）「命令完整输出」确实进模型请求，且 base64 里遮盖会失效
方案表格留待开工核实的问题现在就有答案：完整输出**会**进模型请求。`exportPiOutputFile`（`packages/platform-node/src/files/pi-output-export.ts:45-50`）把命令日志 base64 编码后嵌进 `pi-result.v1` 信封的 `fullOutput` 字段，`pi-host-publication.ts:180-187` 再序列化为工具结果发给模型。两个后果：

- 出口遮盖的规则是明文正则（`packages/sensitive-capture/src/redaction.ts:62-76`），base64 之内什么都认不出，遮盖和自检（`model-egress.ts:214`）都会放行；
- 「先遮再编码」做了也不能原样保留校验值：`exportPiOutputFile:49` 的 `digest` 是对**原字节**算的 SHA-256，遮一字节摘要就得重算，而它和真实磁盘文件不再对应。

建议：在导出前对明文文本套 `redactForEgress`、遮完再编码、用**遮后字节**重算 digest，并在导出函数里补 `assertMachineSecretFree(遮后文本)` 自检；无法按文本处理的（含 NUL 的输出）保留现行为（本来就有 NUL 检查）。

### 4.（中）乙类出口没有对等门槛，方案自设的「防止拦截再回来」检查管不住新出口
PR-1 的登记检查只登记四个识别函数的调用点，恰好相反——它会把这些函数的**合法残余调用**（出口遮盖自检、`trusted-model-provider.ts:127`、`strict-configuration.ts:1183`）也圈在册里，方案说保留，那这几处就要白名单，否则 `npm run check` 失败。更重要的缺口：乙类新增的第三方出口遮盖（TypeSafe、Exa、DeepSeek、URL 净化）没有任何机制保证「以后新接一个第三方服务时不会漏遮」。现有 `npm run check:egress-redaction`（`scripts/check-egress-redaction.mjs`，依据 ADR 0148 决定 9：https://raw.githubusercontent.com 不适用，见仓库 `docs/adr/0148` 第 47 条）只登记模型/嵌入出口，并禁止出口模块之外直接调 `redactForEgress`——乙类新函数要么被这道检查拦住（函数名不同则不会），要么必须把「外部服务出口」也变成一张登记表：登记 TypeSafe/Exa/DeepSeek/URL 读取四处调用遮盖的位置，出现未登记的外发第三方调用就失败。建议照搬 `check:model-ref-contract`（I-73 的门槛形态，见 `docs/incidents-and-gates.md:112`）的双端核对：每一处第三方出口必须引用登记中的遮盖入口。

### 5.（中）占位符还原依赖「这次请求的对照表」，但记忆整理和该请求是解耦的
`AutomaticMemoryService.processCommittedRun` 经 `readSourceText(input.sourceRef)` 从 payload 存储里**事后**读来源（`automatic-memory-service.ts:103`），和建表的那次聊天请求不是一个生命周期；「用这次请求里的对应表还原」在重放、延迟、跨进程时拿不到表，就按「照原样存」落回 `[密码#abcdefgh]`（`redaction.ts:55`）。同一轮对话两次跑整理，存下的字可能不同。

更好的做法：整份来源 payload 原文就在库里（前提：历史存遮盖前内容，规则 prompt-prefix 第 5 条），整理时对**原始来源文本**重跑 `redactForEgress`（tag 是 HMAC(key, kind, value)，`redaction.ts:194`，密钥派生见 ADR 0148 决定 4），即可确定性地重建占位符→原值表——不依赖发起请求何时存活，也满足字节确定性（必答问题 2）。现抽取链路（`production-memory-capture.ts:755-766` 的 `memoryCapturePrompt(message…)`）读的是遮盖前原文，抽取请求出站时经出口遮盖（辅助调用走 `pi-model-transport.ts:313-314`），抽取回文里的占位符可用重建表还原。

### 6.（中）银行卡非校验位规则窗口期
已确认 `docs/adr/0167-sensitive-capture-package.md:61`：存储侧宽规则（16–19 位即拦）当年是**刻意**保留的。方案把这个缺口推迟到「第 2 步」，意味着 PR-2~5 上线后、第 2 步之前，过不了 Luhn 的号码会原样发给模型（出口遮盖的红action也要过 Luhn，`redaction.ts:239`）。建议在 PR-5 的 ADR 里明确写这个窗口与 Andy 的接受记录，而不是只放在「已知代价」。

### 7.（低）前提行号与小事实失准（不影响结论，但方案自己要求逐行核对）
- premise 4 引 `typesafe-jev-transport.ts:77,358`：77 行是 `DEFAULT_BASE_URL` 常量，实际 `assertMachineSecretFree` 在 `:295、:387`。
- 49 处计数：我数产品代码里四个函数的调用点约 47–49（packages 28 + apps 20 上下），与 49 大体一致，未完全逐行核对，标「未全量核实」。
- 「记录页保留历史数据」：我在 `apps`、`packages` 的产品代码里没有找到**任何**产出 outcome `"withheld"` 的写入（只有 `sensitive-interception-recorder.ts:77` 的 `"masked"` 和 `:104` 的 `"not_saved"`，以及测试夹具）；「整段没发给模型」筛选（`apps/control-center/src/components/sensitive-interceptions.tsx:76、120`，i18n `sensitive.filter.withheld`/`sensitive.withheld`，`zh-CN.ts:1177、1211`）在现网大概率是空的。方案「只在出口自检拒发时产生新记录」是新增产出，文案改动要同步三份语言文件和 `message-ids.ts:1091、1125`，建议在 PR-5 列明。

## 侧重检查：一条普通使用流程，从入口走到结束

**流程：Andy 在网页发一句「读一下 .env」，模型调 `read` 工具，结果回填对话，下一轮再发请求。**

1. 网页发送 → 网关命令 → 运行派发：有 `[PR-A]/[PR-B]` 端到端（`test/integration/production-http-composition-process.test.ts`，抓原始请求体）覆盖入口和请求体字节。
2. 上下文组装（记忆块进最后一条消息，`context-formation-service.ts:628-634`）→ 模型请求经 `pi-runtime-adapter.ts:999-1006` 的出口遮盖发出：`check:prompt-prefix`（反向用例见规则文档和 `packages/runtime-pi/test/prompt-prefix.compat.test.ts`）与 `check:egress-redaction` 覆盖，缓存前缀字节稳定有保障。**起点即「只在末尾追加」成立**。
3. 工具派发：`production-coding-workflow.ts` 的 grant/路径/过期检查（浏览器走查 `accept-run-command`、有单元测试）。
4. **`read` 结果回填：`production-host-read.ts:77-83` 和 `host-read-only-executor.ts:143` 把整段结果拦下并记 `PI_RESULT_SECRET_REJECTED`——本方案的主要删除点。现有断言在 `production-host-read.unit.test.ts:125、143`；改成放行后这些测试必须翻转成「遮盖后原文进工具结果」，新增未登记调用检查管不到这一步，是本轮改动里覆盖最薄的一段**。
5. `write/edit` 情形走 `pi-host-publication.ts:131-156` 的 `withhold()`：现有断言 `production-foreground-result.unit.test.ts:151、250、410`，同样要翻转。
6. 记忆整理（下一轮后台）：`production-memory-capture.ts:752` 命中即跳过（问题 1 所列）；`[MH-1]` 等现有集成测试不含「消息带假密钥」的分支，**若只按方案文字实施，这个分支没有反向测试会失败——因为它不是「变红」，而是「照旧拦着」**。
7. 下轮请求出口重遮（同 2）。存原文 + 确定性重遮，满足规则 5/11。

结论：入口和出口两端的门槛是好的（[PR-A/B]、check:prompt-prefix 反向用例、check:egress-redaction），**中间层（工具结果回填、存储侧、第三方结果侧）的测试全部要随行为翻转**，方案测试一节只写了「先在改前代码跑一次证明被拦」，没写「同步改掉现有的拒绝断言清单」——建议照第 1、2 条各文件把要翻转的测试列成表，交给第 0 层（`scripts/layer0-tests/check-layer0-tests.py`，I-05 的门槛会强制声明相关测试）。

## 必答问题逐条回答

**1. 会不会改变模型已经见过的请求开头？** 不会。改动只发生在：(a) 本就发生在最后一条消息组装之后的工具结果/存储内容来源；(b) 出口遮盖保持原样（三个出口 `pi-runtime-adapter.ts:999-1006`、`pi-model-transport.ts:313-314`、`embedding.ts:193-194` 已核实）。系统提示、工具定义、历史一条都不动；老对话里已存的「已拦下」提示继续原样保留（历史不重写）；每轮变值（时间、记忆块）仍在最后一条消息。符合 [prompt-prefix 规则](../../.claude/rules/prompt-prefix.md#rules)（缓存依据：[Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)、[OpenAI](https://developers.openai.com/api/docs/guides/prompt-caching)、[DeepSeek](https://api-docs.deepseek.com/guides/kv_cache)）。唯一注意点问题 3 的 fullOutput（见问题 3 的处理建议）。

**2. 会不会同段文字在不同请求里变成不同字节？** 出口遮盖是确定性的（占位符 tag 为 HMAC 派生的 8 字母，`redaction.ts:187-206`、ADR 0148 决定 4；「named-earlier」只依赖更靠前内容，规则 11 有明文例外）。乙类占位符不带编号，确定性同样成立；缓存键用遮后查询词，确定。唯一引入的非确定性是第 5 条的占位符还原（存储层的值依赖请求生命周期）——按第 5 条建议改为从原始 payload 重建表即可消除。

**3. 有没有对应的自动检查、反向用例会不会失败？** 有基础：`check:prompt-prefix` 的反向用例（规则文档载明「改写历史、系统提示带变值、关冻结都必须失败」）、`check:egress-redaction`、`check-incident-gates.mjs` 会核对新 ADR 登记。方案自己提的「登记检查不通过 `npm run check` 失败」符合仓库惯例（I-73 的 `check:model-ref-contract` 同型）。缺口在问题 4、问题 2：「改成不拦」的各处需要一个会**失败**的反向证明，最可靠的外化是翻转现有拒绝断言（问题 4 清单），而不是只靠新端到端用例。

**4. 每个产生/修改的值的两端校验（I-73：别只看改动本身）：**
- `redactForExternalText/Url`（新）→ 消费方 TypeSafe 请求文本、Exa/DeepSeek 查询、URL：TypeSafe 自身有 `MAX_REQUEST_BYTES` 等校验（`typesafe-jev-transport.ts:81`），遮盖不改变结构，兼容；但 `check-egress-redaction` 禁止出口模块外直接调 `redactForEgress`，新函数要么登记进该检查，要么被它误放，必须改这道检查（问题 4）。
- 遮后查询词 → 消费方缓存键、结果匹配：无 schema 冲突；**但 `production-coding-workflow.ts:170-182` 的 `WEB_SEARCH_INPUT_INVALID` 文案「不能包含凭据」（`web-provider-failure.ts:46`）要改成新语义**，否则界面会对已遮盖的查询说谎。
- 净化后 URL → `validatePublicFetchUrl` 返回值首次被使用（`production-coding-workflow.ts:194` 已证实未用）：消费方是读网页 fetch，跨界需和 `isSensitiveQueryParameter`（`sensitive-capture/src/identifiers.ts`）清单一致。
- 删除的错误码（`PI_RESULT_SECRET_REJECTED`、`WEB_*_OUTPUT_REDACTED`、`PI_OUTPUT_SECRET_REJECTED`、`AI_GATEWAY_INPUT_REJECTED` 的机器密钥分支）：消费方有 `web-provider-failure.ts` 映射、`test/integration/product-path-browser.test.ts:2050`、`gateway-contracts` 的 `OUTPUT_REDACTED` 枚举（`packages/application/src/ports/web-providers.ts:62`）、-reset 记录页筛选——全局清理要含合约枚举的兼容（历史记录里存的字符串不回填）。
- 记录页新文案 → 三语 i18n + `message-ids.ts` + 组件筛选（问题 7）。
- 还原后的记忆文本 → 消费方 `parseMemoryCandidates` 的 `containsRestrictedIdentifier` 分类（`production-memory-capture.ts:281`）仍会把还原值归为 restricted 并走审批流——这与「不加分类下限」的取舍相邻，需一并表态以免违背 Andy 的决定。

## 如果由我来定，我会怎样改这份方案

1. 丙类补全存储侧清单（问题 1 的 8 个文件），每处显式决定删/留并挂测试；这不是「实施时再核对」，而是方案的必备内容。
2. 把 Exa/DeepSeek/pi-coding-main 的结果侧拦截移进甲类并放入 PR-2/3（问题 2）。
3. 「命令完整输出」按问题 3 直接写定答案：导出前明文遮盖、重算 digest、补自检；删除 `pi-output-export.ts:43` 与 `pi-host-publication.ts` 相应分支。
4. 占位符还原改为「从原始来源 payload 重建对照表」（问题 5），去掉对发起请求生命周期的依赖。
5. 新增「第三方出口登记表」而不是只登记四个识别函数（问题 4 的 PR-1），避免 PR-1 登的表里混着要保留的白名单自检。
6. PR-5 的清理清单落到具体文件：`config 0146` 补一条「决定 6 已被 0149/0150 取代」的注记、ADR 0054 R2-T14 五处清单的更新、spec `2026-09-07-srt-unified-execution-design.md:417`、三语 i18n、`web-providers.ts:62` 枚举处置。
7. 银行卡 Luhn 窗口在第 2 步完成前不上全量，或让 Andy 在 ADR 里书面接受（问题 6）。
8. 保留方案其余取舍：按去向分类、不加分类下限、Muse/标题存原文、TypeSafe 在自家传输层遮——这些与代码事实相符（已核实：标题和 Muse 只进界面/推送；TypeSafe 不走 `wrapFetch`）。
