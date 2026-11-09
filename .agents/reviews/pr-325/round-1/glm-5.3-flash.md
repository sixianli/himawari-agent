# 复核结论

## 严重度排序的问题

**01 · 高 · packages/integration-github/test/github-integration.unit.test.ts:732-747**
- 问题：删除 `session.revoke` 后，这个测试在运行时必然失败——结构性调用方漏删。ADR 声称「逐个确认过没有隐藏调用方……没有测试使用」，与代码不符。
- 证据（读代码证实）：测试第 732-747 行用 `gatewayV2MessageSchema.parse({...monitorCommand(...), type: "session.revoke", ...})` 构造非 GitHub 命令并委托。解析入口 `readType`（contracts-v2.ts:2127）用 `enumeration(GATEWAY_V2_MESSAGE_TYPES).parse(...)`，而本 PR 把 `session.revoke` 从该数组删掉（contracts-v2.ts 的 diff）；`packages/gateway-contracts/src/validation.ts:38-43` 对不在白名单的字符串直接 `fail(...)` 抛错。该测试文件本 PR 没改，一跑就红。
- 另注：TS 类型上 `Extract<GatewayV2Command, {type:"session.revoke"}>` 变成 `never`，`as never` 可编译，所以 typecheck 不报、只有运行会炸，更隐蔽。
- 建议：改这条测试用仍存在的无关命令（如 `thread.message.submit` 或某个 pending 名单里的命令）做「委托给 control plane」的反例；同时在 ADR 里修正「没有测试使用」的说法。

**02 · 中 · test/tooling/operations-check.test.mjs / scripts/check-operations.mjs（覆盖缺口）**
- 问题：新检查（）只「向前」验证约定里的操作齐全，没有任何自动化负向检查能发现「测试仍在使用已删除的操作」，正是 01 漏网的原因。
- 证据（读代码证实）：`check-operations.mjs` 的三类错误只有 `OPERATION_INCOMPLETE` / `OPERATION_PENDING_*` / `OPERATION_INSTALLED_NOT_IN_CONTRACT`（脚本 137-153 行逻辑）；`operations-check.test.mjs` 的反向用例也只覆盖这几类，没有「仓库里出现约定外名字即红」的整体扫描（`OPERATION_INSTALLED_NOT_IN_CONTRACT` 只扫 agent-service 的 `PRODUCTION_*` 名单，测试文件不受它约束）。
- 建议：加一条全局检查——除 gateway-contracts 自身外，任何生产/测试文件里出现的 `GATEWAY_V2_MESSAGE_TYPES` 之外的影响 v2 消息字面量都要报红，或至少给 integration-github 补发现在改这一类。

**03 · 中 · apps/control-center/src/app/control-center-inventory.ts:183-188, 396-417 + apps/control-center/src/app.tsx:191-199**
- 问题：`sessions-devices` 行为和叙事不一致。
- 证据（读代码证实）：`sessions-devices` 的 queries/mutations 现在是空数组，但仍是 `contractStatus:"frozen"`、`integrationPolicy:"allowed"`、`blockers:[]`（inventory.ts:396-417）；而同样零操作的任务/收件箱/追踪/设置页都按「约定缺失、集成被阻止」改了。`isSurfaceInstalled` 对空操作列表现在返回「未安装」（inventory.ts:66-71），`app.tsx` 靠 `nativeDevices = identityMethod === "built-in" && route.surfaceId === "sessions-devices"`（app.tsx:191）打补丁。
- 推测二（无覆盖）：改成 built-in 之外（如 cloudflare-access）时，sessions 页将从「已安装」变为「未安装」——此前 `.every()` 对空数组返回 true。这可能是故意的（ADR 64 行说该页走原生设备接口，原生设备面板属于 built-in），但 ADR 未提这点，存在无意回归的可能。
- 建议：把 sessions 页的豁免逻辑写进 ADR/注释；或给该页也标注 `contractStatus:"missing"+blocked` 并靠 `nativeDevices` 判安装，规则统一。

**04 · 中低 · tasks 页残留（apps/control-center/src/app/control-center-inventory.ts:152-173）**
- 问题：该页叙事说「没有实现者的操作已在 P1-4 删出约定」，但它 `mutations:["github.monitor.set_state"]`（158 行）仍在约定里、且有后端实现和测试（integration-github），只是没生产装配。「contractStatus:"missing"」是从整页视角粗判，页内残留契约操作与文案相抵。
- 证据：上面引用的行；`ci/operations-pending.json` 里 `github.monitor.set_state` 只登记「缺：调用方」。
- 建议：文案改为「核心操作已删，保留的监控操作未装配」；或把 `github.monitor.set_state` 从该页摘出。

**05 · 低 · scripts/check-operations.mjs 判定启发式偏松（前后都可误判）**
- 证据（读代码证实）：后端实现判定是 `text.includes('"name"')`（脚本 143 行附近）——src 里任何出现同名字面量的注释、错误文本都算实现；调用方判定 `frontendSends`只要字面量前 24 字符不是 `message(` / `messageId:` 即算（脚本 67-77 行），脚本目录、admin-cli 里任何字符串都用。方向都是「偏漏报不缺项」（宽松方向），保护了当前仓库通过，但放宽未来。反向用例已覆盖主要边界（operations-check.test.mjs:51-127），但没有 `OPERATION_SCHEMA_MISSING`、注释假实现一类用例。
- 建议：接受为一级近似也可，但应至少把「测试判定」同样停掉 `scripts` 下非测试脚本（目前 testFiles 只收 `.test.` 文件，OK），并在文档里写明松判风险。

**06 · 低 · 文案与文档残留**
- 证据：`apps/control-center/src/i18n/message-ids.ts:583` 及三个资源文件仍保留 `"inbox.digest"` 文案（收件箱页已改 blocked，此为死文案，未被检查发现，i18n 目录被排除是合理的）；`packages/persistence-sqlite/src/schema-catalog.ts:662` 注释仍写「scheduled until dismissed」，constraint 已经多了 `cancelled`。
- 建议：清理死文案；注释补 `cancelled`。

**07 · 低 · 0085 迁移对旧数据的直接用例缺失**
- 证据（读代码证实）：迁移 SQL 本身安全——0055 源表与 0085 新表逐列同构，`memory_id UNIQUE`、FK、两个索引名一致，旧 CHECK `(status='dismissed')=(dismissed_at IS NOT NULL)` 与新 CHECK `(status='scheduled')=(dismissed_at IS NULL)` 逻辑等价，旧数据的 scheduled/dismissed 行都能通过新表约束复制。但 `packages/persistence-sqlite/test/` 没有「先按 0084 建含 memory_reminders 旧行、apply 0085、读回」的用例，engine 测试只做 `foreign_key_check`。ADR 87 行承诺的门槛实际偏弱。
- 建议：补一条 memory_reminder 迁移用例。`ON CONFLICT (memory_id)` 依赖的 UNIQUE 已重建（0085 第 5 行 + `schedule` 里 `ON CONFLICT (memory_id)`），能对上。

**核实一致的项（读代码证实）**：
- 18 个操作 + 8 个回执的删除：全仓搜 `task.list|inbox.*|trace.*|settings.*|identity.*|health.*|memory.search|memory.detail|memory.snapshot|...(字符串字面量)` 后，生产代码与 e2e 均无残留（`production-run-composition.ts:227` 的 `"memory.search"` 是耗时标签不是网关调用；i18n/`memory-page.tsx:1482` 的 `"memory.search"` 是 UI 文案 id 同名）；契约夹具、e2e 夹具同步清理完整；`rebuildSearch`（端口/adapter/SQLite/测试）已无任何引用。
- `cancelled` 全链路接受：`memory-reminders.ts:14` 端口类型；`sqlite-memory-reminder-operations.ts:167` update 校验、125/142 行 listDue/listUpcoming 只取 `'scheduled'`；`production-web-push.ts:476` 只发 `'scheduled'`；`production-memory-control.ts:269/512/546` overview 只用 listDue/listUpcoming；治理删除走 memory_records `ON DELETE CASCADE`。写侧 `production-memory-control.ts:883`（respond cancel）、`production-reminder-writer.ts:299`（工具 cancel）都写 `cancelled`，年度提醒取消不顺延（868-888 行逻辑正确）。契约 `memory.reminder.respond` 本就允许 `cancel`（contracts-v2.ts:1125）。
- `ci/operations-pending.json` 23 项与 ADR 数字一致，且全部存在于当前 `GATEWAY_V2_MESSAGE_TYPES`（contracts-v2.ts:21-119），检查对「名单项齐全须移出」「名单外缺项报红」的判定实现与 ADR 48 行一致。
- `check:operations` 已进 `check:steps`（package.json diff），workspace-lifecycle-audit `SUPPORTED_SCHEMA_MAX` 已同步 85。
- 迁移引擎登记（migration-engine.ts:665-671）与相关契约测试的 sequence 85 更新一致。

## 侧重检查

我选的最普通流程：**用户在提醒页取消一条提醒**。

- 入口 `apps/control-center/test/memory-interactions.unit.test.ts:1087-1130`（用例 [MP-8]）：点「不再提醒」→ 发 `memory.reminder.respond action:"cancel"` —— 前端有覆盖。
- 之后 `apps/agent-service/src/production-memory-control.ts:855-899` 读提醒 → update → `sqlite-memory-reminder-operations.ts:173-186` 写库 —— 后端集成覆盖：`test/integration/production-memory-capture.test.ts:1167-1180`（新增 cancelled 断言）、`1395-1407`（老断言从 dismissed 改 cancelled，反转即失败）、1285-1290（工具 cancel）。
- 消费端到期/即将到来/web push —— 由「只取 scheduled」同一条件覆盖（`sqlite-memory-reminder-operations.ts:125,142`），cancelled 间接覆盖。
- **未覆盖段**：0085 迁移把旧库的已取消/已忽略行搬进新表（见 07）；`update` 返回 false 的 MEMORY_REMINDER_CHANGED 冲突路径在本 PR 相关断言里未见。
- 本次全程未走到的：网关 v2 listDue 与 tidy 联动、yearly 均年顺延的回归（1395 用例标了 dueAt: "2028-05-12"，应已覆盖）。

## 必答问题逐条

1. **请求开头（只追加）**：不受影响（读代码证实）。本 PR 只改了 HTTP 网关契约删项、SQLite 状态和 UI，唯一能到模型的是 `reminder_cancel`/`reminder_list` 工具；其 descriptor、参数说明均未改动（production-reminder-writer.ts 本 PR 只改了 `cancel()` 内一处状态字符串，296-306 行），返回形状不变（`{cancelled, reminderId, due}`）。系统提示、历史消息、遮盖结果、工具定义的组装在整个 diff 里没有任何文件被触碰；每轮变化的值没有新增来源。
2. **同段文字字节稳定性**：未引入（读代码证实：没有新增时间戳字段、无序集合、依赖前缀的遮盖；迁移和检查脚本不含任何发给模型的路径）。
3. **自动检查与反向用例**：`check:operations` 已挂进 `check:steps`，`operations-check.test.mjs` 反向用例覆盖缺后端/调用方/测试/名单异常/名单齐全，『去掉这次修改断言即失败』的说法对 `production-memory-capture.test.ts` 成立。缺口：没有任何检查能发现 01 那种「测试仍引用已删除操作」（见 02）。「真实仓库零报红」用例存在但我无法运行，未核实。
4. **每个新值两端的校验**：`cancelled`（写侧两处 + DB CHECK + update 校验 + 全部读侧排除）、迁移 0085（engine 注册、audit 上限 85、契约测试 sequence）、`ci/operations-pending.json` 的 23 个键（全在约定内）、check 脚本各错误码进 CI——逐处核对均吻合；唯一不吻合的是 **契约删掉的 `session.revoke`** 在 integration-github 测试端没有相应改写（01）。
