我会先通读方案，确定需要核查的现状陈述，然后逐一打开对应文件。
CLAIM|1|一致|packages/gateway-contracts/src/contracts.ts:18|网关合约把消息类型列成三个数组（最早的一份、现在网页主要用的一份、对话用的一份）|export const GATEWAY_MESSAGE_TYPES = [
CLAIM|2|一致|packages/gateway-contracts/src/contracts-v2.ts:24|来源 `packages/gateway-contracts/src/contracts-v2.ts:24` 原话：`export const GATEWAY_V2_MESSAGE_TYPES = [`|export const GATEWAY_V2_MESSAGE_TYPES = [
CLAIM|3|一致|packages/gateway-contracts/src/thread-contracts-v3.ts:19|来源 `packages/gateway-contracts/src/thread-contracts-v3.ts:19` 原话：`export const THREAD_GATEWAY_MESSAGE_TYPES = [`|export const THREAD_GATEWAY_MESSAGE_TYPES = [
CLAIM|4|一致|packages/gateway-contracts/src/contracts.ts:18-31|里面有查询和命令，也有服务器发的事件和快照|  "stream.event",
CLAIM|5|找不到|-|三个数组分别是最早的一份、现在网页主要用的一份、对话用的一份|-|-
CLAIM|6|一致|apps/control-center/src/app/control-center-inventory.ts:23-39|网页有一份页面清单，16 个页面……来源 `apps/control-center/src/app/control-center-inventory.ts:23` 起的 `id` 联合类型（`"threads"` 到 `"health-deployment"`）|    | "health-deployment";
CLAIM|7|一致|apps/control-center/src/app/control-center-inventory.ts:42|每个页面有 `queries` 和 `mutations` 两栏|  readonly queries: readonly string[];
CLAIM|8|一致|apps/control-center/src/app/control-center-inventory.ts:166|有的是空的|    queries: [],
CLAIM|9|找不到|-|列了的也不全|-|-
CLAIM|10|一致|apps/control-center/src/app/control-center-inventory.ts:184|`memory` 一项只列了 `queries: ["memory.overview.read"]`|    queries: ["memory.overview.read"],
CLAIM|11|一致|apps/control-center/src/app/control-center-inventory.ts:185|`mutations: ["memory.mutate"]`|    mutations: ["memory.mutate"],
CLAIM|12|一致|apps/control-center/src/app/control-center-inventory.ts:184-185|没有 `memory.settings.set`|    mutations: ["memory.mutate"],
CLAIM|13|一致|packages/gateway-contracts/src/contracts-v2.ts:2780-2781|同一个开关命令管两个方向|  payload: object({ capturePaused: booleanValue }),
CLAIM|14|一致|packages/gateway-contracts/src/contracts-v2.ts:2781|`memory.settings.set` 的正文是 `payload: object({ capturePaused: booleanValue })`|  payload: object({ capturePaused: booleanValue }),
CLAIM|15|一致|docs/adr/0229-native-apple-clients-and-device-api.md:98|每台设备有两把密钥|设备密钥（平时签请求）和确认密钥（每次用都要面容或解锁，给高风险审批和换网页会话用）
CLAIM|16|一致|docs/adr/0229-native-apple-clients-and-device-api.md:98|确认密钥每次使用都要面容或解锁|设备密钥（平时签请求）和确认密钥（每次用都要面容或解锁，给高风险审批和换网页会话用）
CLAIM|17|一致|docs/adr/0229-native-apple-clients-and-device-api.md:103|设备密钥本来就能发消息|设备能调用的命令是一张白名单（发消息、回答审批、提交感知记录、回报动作结果等）
CLAIM|18|一致|docs/adr/0229-native-apple-clients-and-device-api.md:96|ADR 0229 决定第 3 条写的是“聊天和语音用原生界面做，不常用的页面嵌网页”|3. **聊天和语音用原生界面做，不常用的页面嵌网页。**
CLAIM|19|一致|docs/adr/0229-native-apple-clients-and-device-api.md:103|第 4 条里写嵌入的网页用确认密钥换一个短期网页会话|App 里嵌的网页要另换一个短期网页会话，换的时候必须用确认密钥签
CLAIM|20|一致|docs/adr/0229-native-apple-clients-and-device-api.md:98|ADR 0229 决定第 4 条里“给高风险审批和换网页会话用”|设备密钥（平时签请求）和确认密钥（每次用都要面容或解锁，给高风险审批和换网页会话用）
CLAIM|21|一致|docs/adr/0229-native-apple-clients-and-device-api.md:103|“App 里嵌的网页要另换一个短期网页会话”一句|App 里嵌的网页要另换一个短期网页会话，换的时候必须用确认密钥签
CLAIM|22|一致|docs/execution/specs/2026-11-11-apple-device-body-design.md:202|第一次批准的一版存在 `docs/assets/apple-clients/2026-11-12-v1/`|前三版留在 `2026-11-12-v1/` 到 `2026-11-12-v3/`，不再照它们做
CLAIM|23|找不到|-|第一次批准的一版是 `docs/assets/apple-clients/2026-11-12-v1/`|-|-
CLAIM|24|一致|docs/execution/specs/2026-11-11-apple-device-body-design.md:202|换成选定图标并补齐页面的一版存在 `docs/assets/apple-clients/2026-11-12-v2/`|前三版留在 `2026-11-12-v1/` 到 `2026-11-12-v3/`，不再照它们做
CLAIM|25|找不到|-|`docs/assets/apple-clients/2026-11-12-v2/` 是换成选定图标并补齐页面的那一版|-|-
CLAIM|26|一致|docs/adr/0258-each-apple-device-plays-to-its-strength.md:122|现行的界面基线见 ADR 0258|现行基线是 `docs/assets/apple-clients/2026-11-25-v4/`
CLAIM|27|一致|docs/execution/plans/2026-11-11-apple-device-body-plan.md:62|实施计划多一批（第 11 批原生管理页面）|原生管理页面：服务器加客户端能力表、`POST gateway`、`POST payloads/text/new`、确认密钥验签和一次性挑战值、`check:client-parity`
CLAIM|28|一致|docs/execution/plans/2026-11-11-apple-device-body-plan.md:73|共 11 批|Andy 2026-11-12 定：要 11 批全做完的完整版再一起体验，不先装早期的半成品。
CLAIM|29|一致|docs/execution/specs/2026-11-11-apple-device-body-design.md:1188|详细设计“还没核实的事”第 26 条是连续改几处设置时是否每次都要刷面容|连续改几处设置时，能不能几分钟内只刷一次面容（苹果的“认证结果可重复使用时长”对安全芯片里的密钥管不管用）

未核对的部分：三个合约数组各自对应“最早／网页主要用／对话用”的角色、页面清单“列了的也不全”这一判断、v1 是否“第一次批准”的那一版、v2 是否“选定图标并补齐页面”的那一版，仓库里没有直接说明，均记找不到。外部网站和第三方产品的说法不在核对范围。
