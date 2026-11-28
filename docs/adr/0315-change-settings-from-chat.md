---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-28"
implementation: in_progress
covers: "packages/gateway-contracts/src/chat-settings.ts, packages/gateway-contracts/src/client-capabilities.ts, apps/agent-service/src/production-settings-tools.ts, apps/agent-service/src/production-runtime-tools.ts, apps/agent-service/src/production-tool-actions.ts, packages/prompt-catalog/src/settings.ts"
verified_at: "af6310e5ab72191c404589704e17d8595c67c6a5"
---

# ADR 0315：在聊天里直接改 Himawari 的设置：一张从命令表生成的设置目录，三个通用工具，四档权限

<a id="contents"></a>

## 阅读导航

- [两个问题的回答](#answers)
- [前提](#premises)
- [决定](#decision)
  - [设置目录](#catalog)
  - [三个工具](#tools)
  - [四档](#tiers)
  - [改完读回和撤销](#verify)
  - [门槛](#gates)
- [后果](#consequences)

<a id="answers"></a>

## 两个问题的回答

**大厂怎么做。** Claude Code 的 `/config`、`/model` 让用户一句话改自己的偏好，当场生效、不确认；模型自己去改权限类设置一律先弹确认（[Claude Code 设置](https://code.claude.com/docs/en/settings)、[权限](https://code.claude.com/docs/en/permissions)）。ChatGPT、Claude App 的记忆总开关只在设置页。我们照 Claude Code 的分法：自己的偏好说了就改，权限和删除先问。

**是不是根治。** 是。现在每项设置只能从设置页按钮改，模型没有一条通用的路去读和改设置。这次给所有设置一条统一的路，从现有命令表生成，不给“暂停记忆”“换模型”各写一个工具。

Andy 2026-11-28 17:42 JST 在方案文档 <https://claude.ai/artifact/4ngT3J87EBrYgqTVQaGgmt> 上同意了四档（含换模型、恢复记忆放第 2 档）。他说的“勿扰”是 Himawari 自己的勿扰时段（`quiet_hours.set`）和暂停主动提醒，不是 iPhone 系统的勿扰；系统设置不在范围内。

<a id="premises"></a>

## 前提

1. 手机能发的每条命令都已经登记在命令表里并分了档：`packages/gateway-contracts/src/client-capabilities.ts` 第 20 行 `CLIENT_CAPABILITY_TIERS = ["read", "routine", "tighten", "change", "not_on_phone"]`，第 112 行起 `CLIENT_CAPABILITY_TABLE`；`requiredClientTier` 按参数判断一次改动是不是收紧，例如 `tightenOrChange("v2", "memory.settings.set", { capturePaused: true })`。
2. 每条命令的参数结构写在 `packages/gateway-contracts/src/contracts-v2.ts`，例如 `quietHoursSetCommandSchema` 的 `payload: object({ expectedVersion, enabled, start, end })`。
3. `.agents/instructions/prompt-prefix.md` 第 28 行：“系统提示和工具定义里不得出现会变的值”；第 45 行：“工具集合尽量不变”。
4. 权限出口按动作和“读过外来内容没有”决定问不问：`packages/application/src/rules/action-rules.ts` 的 `preauthorizeOwnerData` 直接放行“CREATE_OR_UPDATE、MEDIUM、能撤回、不外发、没读过外来内容”的动作；`askAfterExternalContent` 在读过外来内容后先问，Himawari 自己这边（`himawari_side_only`）的除外。
5. 需要 Face ID 的确认卡：`packages/application/src/services/action-policy-service.ts` 建卡时 `recentAuthenticationRequired: intent.finalRisk === "CRITICAL" || ... POLICY_FACT_CODES.ownerPresenceRequired`。
6. 手机发来的消息带着发消息那台设备的登录会话：`packages/platform-node/src/device-api-routes.ts` 第 1881 行 `sessionId: authentication.sessionId`；对话网关只认活着的会话（`apps/agent-service/src/production-http-composition.ts` 的 `activeSession`）。
7. [ADR 0285](0285-one-main-thread-subthreads-and-one-inbox.md) 决定 7：“只在 Himawari 自己这边、能撤回的……直接做……发出去、删东西先问，Andy 给过的长期同意在读过外来内容后不算数”。
8. 愿景原则 6：“核实结果而非假设成功”（`docs/product-vision.md` 第 66 行）。

<a id="decision"></a>

## 决定

<a id="catalog"></a>

### 设置目录

1. 新文件 `packages/gateway-contracts/src/chat-settings.ts` 给命令表里每一条手机能发的 v2 命令登记一行：要么是设置（三种语言的名字、读回用的查询、聊天档位），要么写明“不是设置”和原因。只读查询和 `not_on_phone` 的命令不登记，它们本来就不会被当成改设置。设置目录由这张表和命令表合成，不另写清单。
2. 参数结构不手写第二份：`validation.ts` 的每个结构函数多带一个 `describe()`，把 contracts-v2 的定义转成 JSON Schema 片段；`settings_list` 直接给出这份片段，`settings_change` 用 contracts-v2 的同一个解析器校验。
3. 保险箱里的密码和密钥永远不在目录里：保险箱不走 v2 命令，目录生成时再拒绝任何名字带 `vault` 的类型。

<a id="tools"></a>

### 三个工具

4. 模型只多 `settings_list`、`settings_change`、`settings_undo` 三个固定工具，定义是提示词目录里的固定文字。设置清单、当前值、可选值只出现在工具结果里；以后新加设置，工具定义不变。三个工具第一次出现时工具集合变一次，按[按对话冻结](../../.agents/instructions/prompt-prefix.md#stable)只在新对话或换新时生效。
5. 哪句话对应哪项设置由模型判断，不写关键词表。程序只做固定的事：查档位、补全参数、校验、核对版本号、读回。
6. 改设置用发这条消息的那个登录会话去发 v2 命令（前提 6），和设置页走同一个网关、同一套校验和版本号检查，所以聊天里改完设置页立刻是新值。运行没有活着的登录会话（例如定时运行、外部事件）时一律拒绝改设置。
7. `settings_change` 只要模型给出要改的字段；其余字段从读回的当前值补全，`expectedRevision`、`expectedVersion` 从当前值的 `revision`、`version` 补上。

<a id="tiers"></a>

### 四档

8. 档位由程序按表和参数算，模型不能选：命令表判为收紧的（`requiredClientTier` 得出 `tighten`，或聊天表另写的收紧条件）是第 1 档；否则用聊天表登记的档。
9. 档位接到现有权限出口，不另做一套审批：
   - 第 1、2 档用“Himawari 自己这边、能撤回”的意图（`himawari_side_only`），由前提 4 的规则直接放行；读过外来内容后也直接做，回执里写明读过哪些外来内容。
   - 第 3 档的意图标成不能撤回，没有规则放行，出同意卡片；读过外来内容后，以前给过的“以后都行”照前提 7 不算数。
   - 第 4 档再加 `owner_presence_required`，卡片要 Face ID（前提 5）。
10. Andy 在聊天里亲口说出来的改动，算本人确认：手机设置页把 `quiet_hours.set` 当“改动”档要确认，聊天里第 2 档直接改。

<a id="verify"></a>

### 改完读回和撤销

11. 命令发出后再查一次读回查询；改的字段没有变成要的值，就报失败，不说“已改好”（前提 8）。
12. 每次改动存一条记录（改前的值、改后的值、这次的参数），给出编号；`settings_undo` 按编号把字段改回改前的值，撤销本身照常过档位。

<a id="gates"></a>

### 门槛

13. 测试 `test/tooling/chat-settings.test.ts`（CI 的工具测试会跑）：命令表里每条手机能发的 v2 命令都必须在聊天表里有一行，聊天表不能有命令表里没有的类型；设置的读回查询必须是命令表里的查询；删除类、登录类不得登记成第 1、2 档，放宽类不得登记成第 1 档（反向用例）。
14. 同一个测试扫描 iPhone、Mac 设置页（`clients/apple/Sources/HimawariManage/Settings/`）里发的每一条命令，必须登记成设置。

<a id="consequences"></a>

## 后果

- 好处：以后加一个设置，在聊天表登记一行，模型就能用；漏登记 CI 报错。
- 代价：多三个工具，新对话的工具定义变一次。读回多一次查询。
- 要跟进：三档都在生产上验收后，去掉 `implementation: in_progress`。
