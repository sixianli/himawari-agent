CLAIM|1|一致|packages/gateway-contracts/src/contracts-v2.ts:22|来源 `packages/gateway-contracts/src/contracts-v2.ts:22` 原话：`export const GATEWAY_V2_MESSAGE_TYPES = [`|export const GATEWAY_V2_MESSAGE_TYPES = [
CLAIM|2|一致|packages/gateway-contracts/src/thread-contracts-v3.ts:19|来源 `packages/gateway-contracts/src/thread-contracts-v3.ts:19` 原话：`export const THREAD_GATEWAY_MESSAGE_TYPES = [`|export const THREAD_GATEWAY_MESSAGE_TYPES = [
CLAIM|3|一致|packages/gateway-contracts/src/thread-contracts-v3.ts:20-40|网关合约把消息类型列成两个数组，里面有查询和命令，也有服务器发的事件和快照|"thread.create", "thread.message.submit", "thread.events", "thread.execution_events", "thread.list", "thread.detail", "thread.execution_snapshot",
CLAIM|4|一致|apps/control-center/src/app/control-center-inventory.ts:23-39|网页有一份页面清单，16 个页面|readonly id: | "threads" | "approvals" | "tasks" | "inbox-digest" | "memory" | "capabilities-adapters" | "authorizations-grants" | "host-workspaces" | "suggestions" | "reflection" | "workers" | "improvements" | "trace" | "settings" | "sessions-devices" | "health-deployment";
CLAIM|5|一致|apps/control-center/src/app/control-center-inventory.ts:43-44|每个页面有 `queries` 和 `mutations` 两栏|readonly queries: readonly string[]; readonly mutations: readonly string[];
CLAIM|6|一致|apps/control-center/src/app/control-center-inventory.ts:179-180|有的是空的|queries: [], mutations: [],
CLAIM|7|一致|docs/execution/specs/2026-11-11-apple-device-body-design.md:293|列了的也不全|页面清单里不全，例如没有 `memory.settings.set`
CLAIM|8|一致|apps/control-center/src/app/control-center-inventory.ts:198|memory 一项只列了 queries: ["memory.overview.read"]|queries: ["memory.overview.read"],
CLAIM|9|一致|apps/control-center/src/app/control-center-inventory.ts:199|mutations: ["memory.mutate"]（同文件第 198、199 行）|mutations: ["memory.mutate"],
CLAIM|10|一致|apps/control-center/src/app/control-center-inventory.ts:198-199|没有 `memory.settings.set`|queries: ["memory.overview.read"], mutations: ["memory.mutate"],
CLAIM|11|一致|packages/gateway-contracts/src/contracts-v2.ts:1496|同一个开关命令管两个方向|payload: object({ capturePaused: booleanValue }),
CLAIM|12|一致|packages/gateway-contracts/src/contracts-v2.ts:1496|`memory.settings.set` 的正文是 `payload: object({ capturePaused: booleanValue })`|payload: object({ capturePaused: booleanValue }),
CLAIM|13|一致|docs/adr/0229-native-apple-clients-and-device-api.md:96|ADR 0229 决定第 3 条写的是“聊天和语音用原生界面做，不常用的页面嵌网页”|3. **聊天和语音用原生界面做，不常用的页面嵌网页。**
CLAIM|14|一致|docs/adr/0229-native-apple-clients-and-device-api.md:103|第 4 条里写嵌入的网页用确认密钥换一个短期网页会话|App 里嵌的网页要另换一个短期网页会话，换的时候必须用确认密钥签（主人本人当场解锁）
CLAIM|15|一致|docs/adr/0229-native-apple-clients-and-device-api.md:96|ADR 0229 决定第 3 条里“嵌入的网页用设备凭据换短期网页会话”|嵌入的网页用设备凭据向服务器换一个短期的网页会话，不自己保管长期凭据。
CLAIM|16|一致|docs/adr/0229-native-apple-clients-and-device-api.md:98|每台设备有两把密钥，确认密钥每次使用都要面容或解锁|每台设备配对时在自己的安全芯片里生成两把 P-256 密钥：设备密钥（平时签请求）和确认密钥（每次用都要面容或解锁，给高风险审批和换网页会话用）。
CLAIM|17|一致|docs/adr/0229-native-apple-clients-and-device-api.md:103|设备密钥本来就能发消息|设备能调用的命令是一张白名单（发消息、回答审批、提交感知记录、回报动作结果等），不是网页能做的全部。
CLAIM|18|一致|docs/adr/0229-native-apple-clients-and-device-api.md:98|ADR 0229 决定第 4 条里“给高风险审批和换网页会话用”|确认密钥（每次用都要面容或解锁，给高风险审批和换网页会话用）
CLAIM|19|一致|docs/adr/0229-native-apple-clients-and-device-api.md:103|“App 里嵌的网页要另换一个短期网页会话”一句|App 里嵌的网页要另换一个短期网页会话，换的时候必须用确认密钥签
CLAIM|20|一致|docs/adr/0229-native-apple-clients-and-device-api.md:103|只拿到设备密钥、主人不在场时，仍然做不了改规则、删记忆、导出这些事|所以只拿到设备密钥、主人不在场时，做不了改规则、删记忆、导出这些事。
CLAIM|21|一致|docs/execution/specs/2026-11-11-apple-device-body-design.md:195|第一次批准的一版存在 `docs/assets/apple-clients/2026-11-12-v1/`|第一次批准时的原样留在 `2026-11-12-v1/`，不再照它做
CLAIM|22|一致|docs/execution/specs/2026-11-11-apple-device-body-design.md:195|换成选定图标并补齐页面后的现行基线在 `docs/assets/apple-clients/2026-11-12-v2/`|现行的一版存在 `docs/assets/apple-clients/2026-11-12-v2/`：二十张图（01 到 14 是第一次批准的十四屏，换成了后来选定的图标；15 到 20 是补画的六排三十七屏，Andy 2026-11-12 回“可以”）
CLAIM|23|一致|docs/execution/plans/2026-11-11-apple-device-body-plan.md:47-57|实施计划多一批（第 11 批原生管理页面），共 11 批|｜ 11  ｜ 原生管理页面：服务器加客户端能力表、`POST gateway`、`POST payload/text`、确认密钥验签和一次性挑战值、`check:client-parity`；客户端做记忆、规则、设置、审批、提醒记录、文件、用量、“感知到的”、设备管理、数据导出的原生页面。不改表（挑战值不建表，见详细设计） ｜ 云端加 Mac                  ｜ 1、2 ｜ 在手机上逐页验收                                                   ｜
CLAIM|24|一致|docs/execution/specs/2026-11-11-apple-device-body-design.md:1024|没验证：连续改几处设置时每次都刷面容是否太烦，要真机上试（详细设计“还没核实的事”第 26 条）|｜ 26  ｜ 连续改几处设置时，能不能几分钟内只刷一次面容（苹果的“认证结果可重复使用时长”对安全芯片里的密钥管不管用） ｜ 未核实，真机试；不行就每次改动刷一次 ｜

未核对的部分：Andy 的原话、业界做法里引用的外部网站和第三方产品（按要求不算仓库现状），以及方案中关于新增功能和后续批次的计划性表述；这些没有当作现状判断。
