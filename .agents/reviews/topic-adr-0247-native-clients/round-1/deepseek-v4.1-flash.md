CLAIM|1|一致|docs/adr/0229-native-apple-clients-and-device-api.md:95|决定第 3 条写的是“聊天和语音用原生界面做，不常用的页面嵌网页”|聊天主界面、输入框、语音对话用苹果原生界面。记忆页、规则、设置、用量明细嵌现有网页
CLAIM|2|一致|docs/adr/0229-native-apple-clients-and-device-api.md:102|第 4 条里写嵌入的网页用确认密钥换一个短期网页会话|App 里嵌的网页要另换一个短期网页会话，换的时候必须用确认密钥签
CLAIM|3|一致|packages/gateway-contracts/src/contracts-v2.ts:22|来源 `packages/gateway-contracts/src/contracts-v2.ts:22` 原话：`export const GATEWAY_V2_MESSAGE_TYPES = [`|export const GATEWAY_V2_MESSAGE_TYPES = [
CLAIM|4|一致|packages/gateway-contracts/src/thread-contracts-v3.ts:19|`packages/gateway-contracts/src/thread-contracts-v3.ts:19` 原话：`export const THREAD_GATEWAY_MESSAGE_TYPES = [`|export const THREAD_GATEWAY_MESSAGE_TYPES = [
CLAIM|5|找不到|-|网页的查询和命令都是带类型的网关消息|-|
CLAIM|6|一致|packages/gateway-contracts/src/contracts-v2.ts:22|类型的全集在代码里|export const GATEWAY_V2_MESSAGE_TYPES = [
CLAIM|7|一致|apps/control-center/src/app/control-center-inventory.ts:87|网页有一份页面清单|export const CONTROL_CENTER_SURFACE_INVENTORY = [
CLAIM|8|一致|apps/control-center/src/app/control-center-inventory.ts:23-39|16 个页面|    | "health-deployment";
CLAIM|9|不一致|apps/control-center/src/app/control-center-inventory.ts:363|每个列出它的查询和命令|    queries: [],
CLAIM|10|一致|docs/execution/specs/2026-11-11-apple-device-body-design.md:223|但不全|页面清单里不全，例如没有 `memory.settings.set`
CLAIM|11|一致|apps/control-center/src/app/control-center-inventory.ts:23|`apps/control-center/src/app/control-center-inventory.ts:23` 起的 `id` 联合类型（`"threads"` 到 `"health-deployment"`）|  readonly id:
CLAIM|12|一致|apps/control-center/src/app/control-center-inventory.ts:198|`memory` 一项只列了 `queries: ["memory.overview.read"]`|    queries: ["memory.overview.read"],
CLAIM|13|一致|apps/control-center/src/app/control-center-inventory.ts:199|`mutations: ["memory.mutate"]`（同文件第 198、199 行）|    mutations: ["memory.mutate"],
CLAIM|14|一致|docs/execution/specs/2026-11-11-apple-device-body-design.md:223|没有 `memory.settings.set`|页面清单里不全，例如没有 `memory.settings.set`
CLAIM|15|一致|packages/gateway-contracts/src/contracts-v2.ts:1494|来源 `packages/gateway-contracts/src/contracts-v2.ts:1494` 起|const memorySettingsSetCommandSchema = object({
CLAIM|16|一致|packages/gateway-contracts/src/contracts-v2.ts:1496|`memory.settings.set` 的正文是 `payload: object({ capturePaused: booleanValue })`|  payload: object({ capturePaused: booleanValue }),
CLAIM|17|一致|docs/execution/specs/2026-11-11-apple-device-body-design.md:217|同一个开关命令管两个方向|`true` 是暂停、`false` 是恢复
CLAIM|18|一致|docs/adr/0229-native-apple-clients-and-device-api.md:97|每台设备有两把密钥|每台设备配对时在自己的安全芯片里生成两把 P-256 密钥
CLAIM|19|一致|docs/adr/0229-native-apple-clients-and-device-api.md:97|确认密钥每次使用都要面容或解锁。来源 ADR 0229 决定第 4 条原话：“设备密钥（平时签请求）和确认密钥（每次用都要面容或解锁……）”|设备密钥（平时签请求）和确认密钥（每次用都要面容或解锁，给高风险审批和换网页会话用）
CLAIM|20|一致|docs/adr/0229-native-apple-clients-and-device-api.md:102|设备密钥本来就能发消息。来源 ADR 0229 决定第 4 条原话：“设备能调用的命令是一张白名单（发消息、回答审批、提交感知记录、回报动作结果等）”|设备能调用的命令是一张白名单（发消息、回答审批、提交感知记录、回报动作结果等）
CLAIM|21|一致|docs/adr/0229-native-apple-clients-and-device-api.md:95|ADR 0229 决定第 3 条里“嵌入的网页用设备凭据换短期网页会话”|嵌入的网页用设备凭据向服务器换一个短期的网页会话
CLAIM|22|一致|docs/adr/0229-native-apple-clients-and-device-api.md:97|ADR 0229 决定第 4 条里“给高风险审批和换网页会话用”|给高风险审批和换网页会话用
CLAIM|23|一致|docs/adr/0229-native-apple-clients-and-device-api.md:102|“App 里嵌的网页要另换一个短期网页会话”一句|App 里嵌的网页要另换一个短期网页会话
CLAIM|24|一致|docs/execution/plans/2026-11-11-apple-device-body-plan.md:61|已批准的一版存在 `docs/assets/apple-clients/2026-11-12-v1/`|客户端界面（第 2、4、6、8、9、10、11 批里有界面的部分）一律照 Andy 2026-11-12 批准的原型做：`docs/assets/apple-clients/2026-11-12-v1/`
CLAIM|25|一致|docs/execution/specs/2026-11-11-apple-device-body-design.md:954|详细设计“还没核实的事”第 26 条|连续改几处设置时，能不能几分钟内只刷一次面容（苹果的“认证结果可重复使用时长”对安全芯片里的密钥管不管用）
CLAIM|26|一致|docs/execution/plans/2026-11-11-apple-device-body-plan.md:57|共 11 批|| 11  | 原生管理页面：服务器加客户端能力表、`POST gateway`、`POST payload/text`、确认密钥验签和一次性挑战值、`check:client-parity`；

未核对的还有：前提 1 中“网页的查询和命令都是带类型的网关消息”没有逐个网页处理程序核对。设备密钥、两把密钥、设备能发消息只核对到 ADR 0229 的文档表述，仓库里没有找到设备接口实现；“已批准”只看到计划里的表述和原型文件，无法核对批准过程。
