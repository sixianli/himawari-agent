CLAIM|1|一致|docs/adr/0229-native-apple-clients-and-device-api.md:96|ADR 0229 决定第 3 条写的是“聊天和语音用原生界面做，不常用的页面嵌网页”|聊天和语音用原生界面做，不常用的页面嵌网页
CLAIM|2|一致|docs/adr/0229-native-apple-clients-and-device-api.md:103|第 4 条里写嵌入的网页用确认密钥换一个短期网页会话|App 里嵌的网页要另换一个短期网页会话，换的时候必须用确认密钥签（主人本人当场解锁）
CLAIM|3|一致|packages/gateway-contracts/src/contracts.ts:18|网关合约把消息类型列成三个数组（最早的一份、现在网页主要用的一份、对话用的一份）|export const GATEWAY_MESSAGE_TYPES = [
CLAIM|4|一致|docs/execution/specs/2026-11-11-apple-device-body-design.md:303|最早的一份|以及最早那份 `contracts.ts` 的 `GATEWAY_MESSAGE_TYPES`
CLAIM|5|一致|apps/control-center/src/memory.ts:1|现在网页主要用的一份|import type { GatewayV2Command, GatewayV2Snapshot } from "@himawari-agent/gateway-contracts";
CLAIM|6|一致|apps/control-center/src/thread-sse-synchronizer.ts:1|对话用的一份|import { threadGatewayMessageSchema } from "@himawari-agent/gateway-contracts";
CLAIM|7|一致|packages/gateway-contracts/src/contracts.ts:18|里面有查询和命令，也有服务器发的事件和快照|export const GATEWAY_MESSAGE_TYPES = [\n  "trigger.admit",\n  "thread.create",\n  "thread.close",\n  "run.cancel",\n  "approval.respond",\n  "thread.get_snapshot",\n  "run.get_snapshot",\n  "trace.query",\n  "events.subscribe",\n  "thread.snapshot",\n  "run.snapshot",\n  "stream.event",\n] as const;
CLAIM|8|一致|packages/gateway-contracts/src/contracts.ts:18|来源 `packages/gateway-contracts/src/contracts.ts:18` 原话：`export const GATEWAY_MESSAGE_TYPES = [`|export const GATEWAY_MESSAGE_TYPES = [
CLAIM|9|不一致|packages/gateway-contracts/src/contracts-v2.ts:24|来源 `packages/gateway-contracts/src/contracts-v2.ts:22` 原话：`export const GATEWAY_V2_MESSAGE_TYPES = [`|export const GATEWAY_V2_MESSAGE_TYPES = [
CLAIM|10|一致|packages/gateway-contracts/src/thread-contracts-v3.ts:19|`packages/gateway-contracts/src/thread-contracts-v3.ts:19` 原话：`export const THREAD_GATEWAY_MESSAGE_TYPES = [`|export const THREAD_GATEWAY_MESSAGE_TYPES = [
CLAIM|11|一致|docs/execution/specs/2026-11-11-apple-device-body-design.md:305|网页有一份页面清单，16 个页面|网页的 16 个页面在 iPhone 上的去处
CLAIM|12|一致|apps/control-center/src/app/control-center-inventory.ts:42|每个页面有 `queries` 和 `mutations` 两栏|  readonly queries: readonly string[];\n  readonly mutations: readonly string[];
CLAIM|13|一致|apps/control-center/src/app/control-center-inventory.ts:166|有的是空的|    queries: [],\n    mutations: [],
CLAIM|14|一致|docs/execution/specs/2026-11-11-apple-device-body-design.md:303|列了的也不全|页面清单里不全，例如没有 `memory.settings.set`
CLAIM|15|一致|apps/control-center/src/app/control-center-inventory.ts:23|来源 `apps/control-center/src/app/control-center-inventory.ts:23` 起的 `id` 联合类型（`"threads"` 到 `"health-deployment"`）|  readonly id:
CLAIM|16|不一致|apps/control-center/src/app/control-center-inventory.ts:184|`memory` 一项只列了 `queries: ["memory.overview.read"]`、`mutations: ["memory.mutate"]`（同文件第 198、199 行）|    queries: ["memory.overview.read"],\n    mutations: ["memory.mutate"],
CLAIM|17|一致|apps/control-center/src/app/control-center-inventory.ts:184|没有 `memory.settings.set`|    queries: ["memory.overview.read"],\n    mutations: ["memory.mutate"],
CLAIM|18|一致|packages/gateway-contracts/src/contracts-v2.ts:2781|同一个开关命令管两个方向|  payload: object({ capturePaused: booleanValue }),
CLAIM|19|不一致|packages/gateway-contracts/src/contracts-v2.ts:2780|来源 `packages/gateway-contracts/src/contracts-v2.ts:1494` 起，`memory.settings.set` 的正文是 `payload: object({ capturePaused: booleanValue })`|  ...commandEnvelope("memory.settings.set"),\n  payload: object({ capturePaused: booleanValue }),
CLAIM|20|一致|docs/adr/0229-native-apple-clients-and-device-api.md:98|每台设备有两把密钥|每台设备配对时在自己的安全芯片里生成两把 P-256 密钥：设备密钥（平时签请求）和确认密钥（每次用都要面容或解锁，给高风险审批和换网页会话用）。
CLAIM|21|一致|docs/adr/0229-native-apple-clients-and-device-api.md:98|确认密钥每次使用都要面容或解锁|确认密钥（每次用都要面容或解锁，给高风险审批和换网页会话用）
CLAIM|22|一致|docs/adr/0229-native-apple-clients-and-device-api.md:103|设备密钥本来就能发消息|设备能调用的命令是一张白名单（发消息、回答审批、提交感知记录、回报动作结果等）
CLAIM|23|一致|docs/adr/0229-native-apple-clients-and-device-api.md:103|来源 ADR 0229 决定第 4 条原话：“设备能调用的命令是一张白名单（发消息、回答审批、提交感知记录、回报动作结果等）”|设备能调用的命令是一张白名单（发消息、回答审批、提交感知记录、回报动作结果等）
CLAIM|24|一致|docs/adr/0229-native-apple-clients-and-device-api.md:96|ADR 0229 决定第 3 条里“不常用的页面嵌网页”和“嵌入的网页用设备凭据换短期网页会话”不再执行|嵌入的网页用设备凭据向服务器换一个短期的网页会话
CLAIM|25|一致|docs/adr/0229-native-apple-clients-and-device-api.md:98|ADR 0229 决定第 4 条里“给高风险审批和换网页会话用”改为“给高风险审批和‘改’这一档的命令用”|给高风险审批和换网页会话用
CLAIM|26|一致|docs/adr/0229-native-apple-clients-and-device-api.md:103|“App 里嵌的网页要另换一个短期网页会话”一句不再执行|App 里嵌的网页要另换一个短期网页会话
CLAIM|27|一致|docs/adr/0229-native-apple-clients-and-device-api.md:103|只拿到设备密钥、主人不在场时，仍然做不了改规则、删记忆、导出这些事|所以只拿到设备密钥、主人不在场时，做不了改规则、删记忆、导出这些事。
CLAIM|28|找不到|-|第一次批准的一版存在 `docs/assets/apple-clients/2026-11-12-v1/`|-
CLAIM|29|不一致|docs/execution/specs/2026-11-11-apple-device-body-design.md:202|换成选定图标并补齐页面后的现行基线在 `docs/assets/apple-clients/2026-11-12-v2/`|现行的一版存在 `docs/assets/apple-clients/2026-11-25-v4/`
CLAIM|30|一致|docs/execution/specs/2026-11-11-apple-device-body-design.md:1188|没验证：连续改几处设置时每次都刷面容是否太烦，要真机上试（详细设计“还没核实的事”第 26 条）|连续改几处设置时，能不能几分钟内只刷一次面容（苹果的“认证结果可重复使用时长”对安全芯片里的密钥管不管用）
CLAIM|31|一致|docs/adr/0229-native-apple-clients-and-device-api.md:8|ADR 0229：被本 ADR 修订决定第 3、4 条|amended_by: "docs/adr/0247-apple-clients-are-fully-native-with-a-capability-table.md"

未核实：`2026-11-12-v1/` 目录确实存在，但没有读到能证明它是 Andy“第一次批准的一版”的记录；方案中第 11 批、`check:client-parity`、`POST gateway` 等新增或修改内容属于计划，未按现状核对。
