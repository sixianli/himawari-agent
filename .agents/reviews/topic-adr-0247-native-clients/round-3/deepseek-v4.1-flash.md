CLAIM|1|一致|docs/adr/0229-native-apple-clients-and-device-api.md:96|ADR 0229 决定第 3 条写的是“聊天和语音用原生界面做，不常用的页面嵌网页”|3. **聊天和语音用原生界面做，不常用的页面嵌网页。** 聊天主界面、输入框、语音对话用苹果原生界面。记忆页、规则、设置、用量明细嵌现有网页，保证和电脑上一致。嵌入的网页用设备凭据向服务器换一个短期的网页会话，不自己保管长期凭据。
CLAIM|2|一致|docs/adr/0229-native-apple-clients-and-device-api.md:103|第 4 条里写嵌入的网页用确认密钥换一个短期网页会话|App 里嵌的网页要另换一个短期网页会话，换的时候必须用确认密钥签（主人本人当场解锁）
CLAIM|3|不一致|packages/gateway-contracts/src/contracts.ts:18；packages/gateway-contracts/src/contracts-v2.ts:22；packages/gateway-contracts/src/thread-contracts-v3.ts:19|网关合约把消息类型列成两个数组|export const GATEWAY_MESSAGE_TYPES = [
CLAIM|4|一致|packages/gateway-contracts/src/thread-contracts-v3.ts:37|里面有查询|  "thread.list",
CLAIM|5|一致|packages/gateway-contracts/src/contracts-v2.ts:23|里面有命令|  "thread.message.submit",
CLAIM|6|一致|packages/gateway-contracts/src/thread-contracts-v3.ts:35|也有服务器发的事件|  "thread.events",
CLAIM|7|一致|packages/gateway-contracts/src/contracts-v2.ts:27|也有服务器发的快照|  "search.authorization.snapshot",
CLAIM|8|一致|packages/gateway-contracts/src/contracts-v2.ts:22|来源 `packages/gateway-contracts/src/contracts-v2.ts:22` 原话：`export const GATEWAY_V2_MESSAGE_TYPES = [`|export const GATEWAY_V2_MESSAGE_TYPES = [
CLAIM|9|一致|packages/gateway-contracts/src/thread-contracts-v3.ts:19|`packages/gateway-contracts/src/thread-contracts-v3.ts:19` 原话：`export const THREAD_GATEWAY_MESSAGE_TYPES = [`|export const THREAD_GATEWAY_MESSAGE_TYPES = [
CLAIM|10|一致|apps/control-center/src/app/control-center-inventory.ts:87|网页有一份页面清单|export const CONTROL_CENTER_SURFACE_INVENTORY = [
CLAIM|11|一致|apps/control-center/src/app/control-center-inventory.ts:23-39|16 个页面|  readonly id:
CLAIM|12|一致|apps/control-center/src/app/control-center-inventory.ts:43-44|每个页面有 `queries` 和 `mutations` 两栏|  readonly queries: readonly string[];
CLAIM|13|一致|apps/control-center/src/app/control-center-inventory.ts:157|有的是空的|    queries: [],
CLAIM|14|一致|apps/control-center/src/app/control-center-inventory.ts:198-199；packages/gateway-contracts/src/contracts-v2.ts:1495|列了的也不全|  ...commandEnvelope("memory.settings.set"),
CLAIM|15|一致|apps/control-center/src/app/control-center-inventory.ts:23-39|来源第 23 行起的 `id` 联合类型（`"threads"` 到 `"health-deployment"`）|    | "health-deployment";
CLAIM|16|一致|apps/control-center/src/app/control-center-inventory.ts:198|`memory` 一项只列了 `queries: ["memory.overview.read"]`|    queries: ["memory.overview.read"],
CLAIM|17|一致|apps/control-center/src/app/control-center-inventory.ts:199|`mutations: ["memory.mutate"]`|    mutations: ["memory.mutate"],
CLAIM|18|一致|apps/control-center/src/app/control-center-inventory.ts:198-199|没有 `memory.settings.set`|    mutations: ["memory.mutate"],
CLAIM|19|一致|packages/gateway-contracts/src/contracts-v2.ts:1494-1496|同一个开关命令管两个方向|  payload: object({ capturePaused: booleanValue }),
CLAIM|20|一致|packages/gateway-contracts/src/contracts-v2.ts:1496|`memory.settings.set` 的正文是 `payload: object({ capturePaused: booleanValue })`|  payload: object({ capturePaused: booleanValue }),
CLAIM|21|一致|docs/adr/0229-native-apple-clients-and-device-api.md:98|每台设备有两把密钥|每台设备配对时在自己的安全芯片里生成两把 P-256 密钥
CLAIM|22|一致|docs/adr/0229-native-apple-clients-and-device-api.md:98|确认密钥每次使用都要面容或解锁|设备密钥（平时签请求）和确认密钥（每次用都要面容或解锁，给高风险审批和换网页会话用）
CLAIM|23|一致|docs/adr/0229-native-apple-clients-and-device-api.md:103|设备密钥本来就能发消息|设备能调用的命令是一张白名单（发消息、回答审批、提交感知记录、回报动作结果等）
CLAIM|24|一致|docs/adr/0229-native-apple-clients-and-device-api.md:98|ADR 0229 决定第 4 条里“给高风险审批和换网页会话用”|设备密钥（平时签请求）和确认密钥（每次用都要面容或解锁，给高风险审批和换网页会话用）
CLAIM|25|一致|docs/adr/0229-native-apple-clients-and-device-api.md:103|“App 里嵌的网页要另换一个短期网页会话”一句|App 里嵌的网页要另换一个短期网页会话
CLAIM|26|一致|docs/adr/0229-native-apple-clients-and-device-api.md:103|只拿到设备密钥、主人不在场时，仍然做不了改规则、删记忆、导出这些事|所以只拿到设备密钥、主人不在场时，做不了改规则、删记忆、导出这些事。
CLAIM|27|一致|docs/execution/specs/2026-11-11-apple-device-body-design.md:195|第一次批准的一版存在 `docs/assets/apple-clients/2026-11-12-v1/`|第一次批准时的原样留在 `2026-11-12-v1/`，不再照它做
CLAIM|28|一致|docs/execution/specs/2026-11-11-apple-device-body-design.md:195|换成选定图标并补齐页面后的现行基线在 `docs/assets/apple-clients/2026-11-12-v2/`|现行的一版存在 `docs/assets/apple-clients/2026-11-12-v2/`
CLAIM|29|一致|docs/execution/plans/2026-11-11-apple-device-body-plan.md:57|实施计划多一批（第 11 批原生管理页面），共 11 批|原生管理页面：服务器加客户端能力表、`POST gateway`、`POST payloads/text/new`、确认密钥验签和一次性挑战值、`check:client-parity`；客户端做记忆、规则、设置、审批、提醒记录、文件、用量、“感知到的”、设备管理、数据导出的原生页面。
CLAIM|30|一致|docs/execution/specs/2026-11-11-apple-device-body-design.md:1028|没验证：连续改几处设置时每次都刷面容是否太烦，要真机上试（详细设计“还没核实的事”第 26 条）|26  | 连续改几处设置时，能不能几分钟内只刷一次面容（苹果的“认证结果可重复使用时长”对安全芯片里的密钥管不管用） | 未核实，真机试；不行就每次改动刷一次

方案中打算新增或修改的内容（能力表、`POST gateway`、`check:client-parity`、Swift 清单生成等）以及苹果 HIG、App Store 审核指南等外部资料，未作为仓库现状核对。
