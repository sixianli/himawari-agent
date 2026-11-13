# PR 432 复核报告

## 侧重检查（先走一遍普通流程）

流程：开发者改动 `apps/agent-service/src/production-approval-gateway.ts` → 跑 `npm run check` → `check:steps`（package.json:27）包含 `check:operations`（package.json:33）→ 先 `node scripts/check-operations.mjs` 读契约（contracts-v2.ts）、扫 apps/packages 的 src、解析 `PRODUCTION_*_OPERATIONS` 名单、网关 `installedOperations`/`installedGatewayV2Operations` 数组、路由分支、控制中心清单、两份台账，再跑 `test/tooling/operations-check.test.mjs`。

走到一半我核对了真实网关（production-approval-gateway.ts:101-272）和真实清单（control-center-inventory.ts:87-437），确认解析器假设与真实代码形状一致（多行 `...(options.X ? LIST : [])` 能被 `\s*` 覆盖；清单条目按 `id:` 切分、`surface.id === "threads"`/`"health-deployment"` 豁免与 control-center-inventory.ts:64,68 吻合）。

**没有测试覆盖的代码路径（本次流程中标出）**：
- `OPERATION_LIST_NOT_IN_GATEWAY`（scripts/check-operations.mjs:225）——新检查里唯一没有反向用例的错误码（测试文件只测了 NOT_INSTALLED 和 NOT_ADVERTISED，test/tooling/operations-check.test.mjs:258-275）。
- 「网关整个缺失 + 清单存在」的组合（check-operations.mjs:194-197 + 356-365）——下述发现 1 的 fail-open 路径没有用例。
- `handlerOf`（check-operations.mjs:229-230）——构建后从未使用，死代码。
- `balancedArray` 遇到不配对括号返回 `""`（check-operations.mjs:111-121）——无边界用例。
- `readInventoryOperations` 的豁免解析对真实清单只被「passes on the real repository」这条 happy path 间接覆盖（test/tooling/operations-check.test.mjs:319-321）。

## 发现（按严重度从高到低）

**1.（中）scripts/check-operations.mjs:196,251 —— `installedNames` 对「没装上」的名单也照算，清单检查在坏场景里失效（fail-open）**
证据：`checkInstalledRouting` 在无网关分支直接 `return { errors, installedNames: new Set(lists.flatMap((list) => list.names)) }`（196 行）；有网关时 251 行同样把**所有**名单的名字算进 `installedNames`，与 209-212 行「名单没被网关安装要报 `OPERATION_LIST_NOT_INSTALLED`」的判定无关。而清单检查（358-364 行）用 `routing.installedNames.has(name)` 判断「已安装」。结果：把 `installedOperations` 数组整个删掉或某名单掉出网关时，清单里声明的操作仍被当作「已安装」，`OPERATION_DECLARED_NOT_INSTALLED` 不报，且 378 行的 `!notInstalled.has(name)` 继续豁免 `OPERATION_PENDING_BUT_COMPLETE`。有伴随报错（GATEWAY_MISSING / LIST_NOT_INSTALLED）兜底，不至于全静默，但「四处一致」恰好在装错的场景下不再成立。建议：`installedNames` 只收 `installed` Map 里真正进网关的名单的名字。

**2.（中）scripts/check-operations.mjs:232-233 —— 纯展开（无 `options.X` 条件）的名单完全跳过路由和处理方检查**
证据：232 行 `const option = [...optionList].find(...)?.[0]; if (!option) continue;`。真实仓库里 `PRODUCTION_APPROVAL_OPERATIONS`（production-approval-gateway.ts:58-64，258 行裸展开）、`PRODUCTION_WEB_PUSH_OPERATIONS`、`PRODUCTION_OWNER_PREFERENCE_OPERATIONS`、`PRODUCTION_SENSITIVE_INTERCEPTION_OPERATIONS`、`PRODUCTION_SERVER_STATUS_OPERATIONS`（production-http-composition.ts:684,688-690 也是裸展开）都没有 option，路由/处理方检查全部跳过。其中 `search.authorization.set` 唯一的处理路径是兜底分支 `searchAuthorization.set(command, ...)`（production-approval-gateway.ts:243）——若这个兜底被删或被前面的分支截胡，请求会落到 `unsupported()`（95-100 行），现有检查查不出来。作者说法「检查契约、已安装清单、生产网关路由分支、处理方四处一致」对这五组名单不成立，只对带条件装配的名单成立。

**3.（低）scripts/check-operations.mjs:154-160 —— 路由分支解析可能把上一段兜底条件的谓词「粘」到文件后面下一个 `options.X` 上（推测，当前真实代码未触发）**
证据：事件流按整个文件顺序收集，`pending` 只在遇到 `options.X` 时清空。我核对过真实网关的事件顺序（reads 链 109-128 行每段谓词后都有紧跟的 options.X，subscribe 块 162 行 `options.memoryControl?.revision()` 时 pending 已空），当前不触发。但没有任何测试守住「兜底分支后不再有谓词残留」这一顺序前提；将来在链尾加一个不带 options 守卫的条件，其谓词会挂到文件后面（可能属于另一个 delegate 的）下一个 `options.X` 上，造成假 `OPERATION_ROUTED_TO_OTHER_HANDLER` 或掩盖真 `OPERATION_NOT_ROUTED`。建议加一条「链尾兜底后不得残留谓词」的负向用例。

**4.（低）test/tooling/operations-check.test.mjs:142,155 —— 两条既有测试从 `toEqual` 放宽为 `toContain`**
证据：`[P1-4] rejects an installed operation that the contract does not define` 和 `does not let the installed list itself stand in for the implementation` 原来断言错误集合精确等于一条，现在只断言包含。这两条夹具加了网关/组合文件后，任何**额外的**新检查误报都会被静默放过，测试变弱。

**5.（低）docs/adr/0192:47-48 —— 文档与代码不一致**
证据：ADR 0192 把 `check:operations` 描述为只查「后端实现、调用方、测试 + 安装名单名字在契约里」，并写「名单目前登记 23 项」。现在检查还做路由分支、处理方、组合层宣告、控制中心清单四处一致（check-operations.mjs:189-252,356-365），待办名单实际 39 项（ci/operations-pending.json 数得 39 条）。ADR 未随本次改动更新。

**6.（信息）作者说法与代码的出入**
- 「新增 11 条反向用例」：读代码证实新增的是 **9** 条 `it`（test/tooling/operations-check.test.mjs:206,210,220,230,241,258,277,308,314；其中 258 那条含 2 个负向断言）。「单测 21 条」对（全文件 21 个 `it`）。
- 「真实仓库跑检查通过」「改名后报 3 条」：未核实（我不能执行命令）。静态核对与真实代码形状一致，`workspace.copy.*` 恰好 3 个命令（production-workspace-copies.ts:28-30），说法可信但未经我运行证实。
- 其余说法（不改表、不改产品运行代码、不改发给模型的内容）读 diff 证实成立。

## 必答问题

**1. 会不会改变模型已见过的请求开头？** 不会。读 diff 证实改动只有 4 个文件：scripts/check-operations.mjs、test/tooling/operations-check.test.mjs、ci/operations-pending.json、一份复核说明（.agents/reviews/...），没有任何系统提示、工具定义、历史消息或遮盖逻辑文件。发给模型的内容未被触碰，「只在末尾追加」的前提不受影响。作者该条说法与代码一致。（被引用的 `.claude/rules/prompt-prefix.md` 在本检出里不存在，规则原文未核实，但不影响此结论。）

**2. 会不会让同一段文字在不同请求里变成不同字节？** 不会（对模型内容无改动）。脚本自身输出顺序依赖 `readdirSync` 枚举顺序（check-operations.mjs:20-36,265-272，未排序），错误行的先后可能随文件系统不同而不同——但这只是开发期 stderr，不是发给模型的字节，且判红判绿与顺序无关。台账 JSON 为固定键序，无时间、无随机字段。

**3. 有没有对应的自动检查、反向用例会不会失败？** 有：`check:operations`（package.json:33）同时跑脚本和 21 条单测，且在 `check:steps`（package.json:27）里随 `npm run check` 执行。9 条新反向用例断言的错误码（OPERATION_NOT_ROUTED 等）只有新代码才会产出，对基线脚本必然失败——这是静态推断，我没能实际运行（环境限制，未核实执行结果）。缺口：`OPERATION_LIST_NOT_IN_GATEWAY`（check-operations.mjs:225）和发现 1 的 fail-open 路径没有用例。

**4. 每个新产生/修改的值，两端都能接受吗？** 逐项核对如下（读代码证实）：
- 8 个新错误码：产生方 check-operations.mjs:195,211,223,225,241,244,248,363；使用方只有脚本出口（397-404 行 stderr/退出码）和测试断言，仓库内无其他解析器（grep 证实），两端一致。
- `INVENTORY_FILE`（check-operations.mjs:11）：只在本文件 357 行使用，路径与真实文件 apps/control-center/src/app/control-center-inventory.ts 一致。
- 待办清单新增 10 项（capability.* 7、grant.* 3）：与控制中心清单声明的集合精确吻合（control-center-inventory.ts:217-224,245-246）；全部在契约 `GATEWAY_V2_MESSAGE_TYPES` 里（contracts-v2.ts:89-94,108-111），不会触发 `OPERATION_PENDING_NOT_IN_CONTRACT`；理由长度远超 10 字下限；与 378 行 `!notInstalled.has(name)` 的豁免逻辑闭环核对一致（装进名单后 `notInstalled` 不再含它，若已齐全会报 PENDING_BUT_COMPLETE 逼其移出）。I-73 的教训（只看改动不看使用端校验）在这一项上这次是做到了。
- 未改任何既有配置键、序列化格式或清单 id。
