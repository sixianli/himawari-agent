## 结论摘要

这是一个只改开发期检查脚本/测试/待办清单的 PR，没有触碰模型请求组装，因此必答问题 1、2 的答案都是“不改变”。但新检查本身有几处会让它漏掉目标问题（尤其是无 `option` 的已安装清单被整段跳过、对外声明数组整个消失时静默通过），以及测试覆盖和文档不一致的问题。

---

## 读代码证实的问题（按严重度从高到低）

### 1. 高：无 `options.X` 的已安装清单被整段跳过，路由和处理方检查不覆盖它们

**文件:行**：`scripts/check-operations.mjs:231-233`（配合 `apps/agent-service/src/production-approval-gateway.ts:258`）

**问题**：新检查只为“已安装清单能关联到一个 `option`”的条目做路由和处理方校验；关联不到 `option` 的清单直接 `continue`。而生产网关里 `PRODUCTION_APPROVAL_OPERATIONS` 是无条件展开的：

```js
const option = [...optionList].find(([, listName]) => listName === list.listName)?.[0];
if (!option) continue;
```

```ts
installedOperations: [
  ...PRODUCTION_APPROVAL_OPERATIONS,
  ...(options.workspaceCopies ? PRODUCTION_COPY_OPERATIONS : []),
```

`PRODUCTION_APPROVAL_OPERATIONS` 里的 `approval.list`、`approval.detail`、`approval.respond`、`search.authorization.read`、`search.authorization.set` 完全不检查路由和处理方。若以后往这个无条件清单追加一个新命令，只要它已有后端字面量、调用方和测试，但没有路由分支，这道新检查会通过——正是本 PR 想拦的事故类型（落到 `searchAuthorization.set` 被拒）。作者“四处一致”的说法对这一清单不成立。

**建议**：不要用“没有 option”作为跳过条件。对每个已安装清单，要么解析出处理方，要么只对明确的兜底/基础清单（如 approval/search）列入白名单并单独校验兜底处理；否则报 `OPERATION_NOT_ROUTED`/`OPERATION_HANDLER_MISSING`。同时给 `PRODUCTION_APPROVAL_OPERATIONS` 加一条反向用例。

---

### 2. 中：整个 `installedGatewayV2Operations` 声明消失时，检查静默通过

**文件:行**：`scripts/check-operations.mjs:213-226`

**问题**：

```js
const advertisedArrays = ...filter((array) => array.field === "installedGatewayV2Operations");
const advertised = advertisedArrays.flatMap(...);
if (advertisedArrays.length > 0) {
  for (const listName of installed.keys())
    if (!advertised.includes(listName)) errors.push(`OPERATION_LIST_NOT_ADVERTISED ${listName}`);
```

如果 `production-http-composition.ts` 里整段 `installedGatewayV2Operations` 被删掉/改名，`advertisedArrays.length === 0`，整个“未对外声明”检查被跳过；此时网关仍安装着 10 个清单，检查却通过。作者“已安装清单与生产网关对外声明一致”的目标在这种情况下落空。

**建议**：在存在网关和清单但找不到任何 `installedGatewayV2Operations` 数组时显式报错（例如 `OPERATION_ADVERTISING_MISSING`），不要用 `length > 0` 静默跳过。补一条删除该字段的反向用例。

---

### 3. 中：处理方检查只查后端任意位置是否出现同名字面量，证明力弱

**文件:行**：`scripts/check-operations.mjs:246-248`

**问题**：

```js
const elsewhere = handlerTexts.some((text) => text.includes(`"${name}"`));
if (!ownText.includes(`"${name}"`) && !elsewhere)
  errors.push(`OPERATION_HANDLER_MISSING ...`);
```

只要 `apps/*/src`、`packages/*/src` 任意文件里出现 `"operation.name"`（类型联合、注释、映射表、其他适配器、字符串常量都算），就被当作有处理方。现有反向用例是“把唯一那处处理分支删掉且全仓不再出现该字面量”，并没有覆盖“同名字面量存在于无关代码里”的情况。因此“处理方一致”只能算弱启发式。

**建议**：在处理方所在模块中要求出现可执行的 `case`/`===`/`!==` 分支或明确的处理映射，而不是任意后端字面量；至少把 `ownText` 限定为处理模块并排除类型/注释位置。

---

### 4. 中低：反向用例没有覆盖几个新增分支，且作者“新增 11 条反向用例”的说法不准确

**文件:行**：`test/tooling/operations-check.test.mjs:213-226,258-275`；`scripts/check-operations.mjs:225`

**问题**：
- `OPERATION_LIST_NOT_IN_GATEWAY`（脚本第 225 行）没有任何用例：现有用例只覆盖“已安装但未对外声明”和“整个网关缺失”，没有构造“对外声明了某个清单但网关未安装”。
- `routeMatches` 的精确 `===` 匹配只被用作“不匹配”的反例（`command.type === "demo.other"`），没有“精确等于某操作名并成功匹配”的正例。
- `readInstalledArrays` 的第二种形式（`...(变量 ? PRODUCTION_X : [])`）没有用例。
- 实际新增是 9 个 `it`（基准 12 条、现状 21 条），其中反向场景 8 个，不是 11 条反向用例。

**建议**：补上述分支的用例；修正作者说明里的测试数量。

---

### 5. 低：清单文件缺失或格式变化时静默停止检查

**文件:行**：`scripts/check-operations.mjs:358`、`scripts/check-operations.mjs:171-187`

**问题**：

```js
if (existsSync(inventoryPath) && lists.length > 0) { ... }
```

清单文件路径被移动、或 `id:` 的书写格式变化导致 `readInventoryOperations` 解析出空数组时，新检查静默不生效，不会报任何错误。这是错误路径上的静默失败。

**建议**：存在已安装清单时，若清单文件缺失或解析出的 surface 数为 0，显式报 `OPERATIONS_INVENTORY_MISSING`/`OPERATIONS_INVENTORY_UNPARSED`，并可断言解析出的 surface 数与预期一致。

---

### 6. 低：待办清单文件说明和 ADR 与代码语义不一致

**文件:行**：`ci/operations-pending.json:2`；`docs/adr/0192-delete-unimplemented-gateway-operations-and-gate-new-ones.md:47-48`

**问题**：清单说明写“每一项是……缺后端实现、调用方或测试之一的操作”，但新增的 `capability.*`、`grant.*` 已确认有契约、页面/后端实现，只是“生产网关没装配”；代码为此新增了 `!notInstalled.has(name)` 来抑制 `OPERATION_PENDING_BUT_COMPLETE`（`scripts/check-operations.mjs:378`）。ADR 0192 第 4 条仍只描述后端/调用方/测试三项，没有提“已安装”这一条新门槛，第 5 条也没有这个新的待办理由类别。

**建议**：更新 `ci/operations-pending.json` 的“说明”，并在 ADR 0192（或新 ADR）里写明“已声明但未装配”是合法待办理由，以及检查新增了装配一致性要求。

---

### 7. 低：检查把所有后端文件读了两遍

**文件:行**：`scripts/check-operations.mjs:191-193`、`213-216`、`234`

**问题**：`gateways` 和 `advertisedArrays` 各自对 `files` 全量 `readFileSync`，最后又重读 `list.file`。`checkOperations` 前面已经读过 `backendTexts`，这里造成约 2 倍 I/O。功能上无害，但会让 `npm run check:operations` 在大仓上变慢。

**建议**：复用已读的 `backendTexts` 或建立一次性的 `Map<file, text>`。

---

## 推测（未在真实仓库触发，但属于结构风险）

- `readRouteBranches` / `readInstalledArrays` 都是正则启发式：改用别名变量、`switch`/映射表分发、模板字符串、注释或字符串里的 `options.X` 时，可能误报“未路由”或把谓词关联到错误的 `option`（`scripts/check-operations.mjs:128-160`）。我按当前网关、composition、inventory 的实际写法核对了已知形式都能匹配，但这是脆弱点。
- 检查只比较清单名，不比较“网关安装条件”和“对外声明条件”是否一致（`scripts/check-operations.mjs:213-226`）。当前 `workspaceCopiesAvailable`/`memoryAvailable` 等与网关的 `options.*` 恰好对齐，未来任何一侧条件变化不会被发现。
- `routing.installedNames` 用“所有 `PRODUCTION_*` 清单定义”而不是“真正进入 `installedOperations` 的清单”（`scripts/check-operations.mjs:196/251`）。当前定义但未安装的清单会由 `OPERATION_LIST_NOT_INSTALLED` 报红，所以不会完全静默，但 inventory 检查对“已安装”的定义比字面意思宽。

---

## 作者说法核对

- “只动三个文件”：diff 还包含 `.agents/reviews/pr-432/briefs/brief-round1.md`（`git diff --numstat` 显示 `- -`，内容读取被环境拒绝，未核实）。与作者约束不一致。
- “单测 21 条通过”：当前测试文件确有 21 个 `it`；但“新增 11 条反向用例”不准确，实际新增 9 个 `it`、约 8 个反向场景。
- “真实仓库跑检查通过”：受工具限制不能运行 node/vitest，**未核实**。按代码阅读，`PRODUCTION_APPROVAL_OPERATIONS` 的无 `option` 清单不会误报，`workspace.copy.*` 的处理方字面量存在于 `packages/application/src/services/host-workspace-gateway-adapter.ts`，当前形式应能通过。
- “改名 `workspace.copy.` 后报 3 条 `OPERATION_NOT_ROUTED`”：与代码逻辑一致（该清单 3 个命令、关联 `workspaceCopies`，改名后没有分支匹配），但未实际运行验证。
- “新查出 10 个已声明未安装（capability.* 7、grant.* 3）”：已核对这 10 个名字都在 `packages/gateway-contracts/src/contracts-v2.ts` 的契约里，且不在任何 `PRODUCTION_*_OPERATIONS` 清单中，与说法一致。

---

## 侧重检查

- **错误路径**：待办清单 JSON 有 try/catch；网关缺失有 `OPERATIONS_GATEWAY_MISSING`；但清单文件缺失/解析为空被静默跳过（见问题 5），对外声明数组整体缺失被静默跳过（见问题 2）。
- **不合规范/不可信输入**：脚本只读仓库文件，不执行仓库代码；正则解析可被注释/字符串/别名误导（推测，见上）。路径来自 `walk` 和固定常量，无路径穿越。
- **安全**：不联网、不读秘密、不拼 shell、不打印敏感内容；错误信息只含文件路径和操作名。
- **资源耗尽**：`balancedArray` 线性；正则未见明显灾难性回溯；主要问题是全量文件重复读取（见问题 7）。
- **不可撤销操作**：无。
- **规则/文档与代码一致**：`ci/operations-pending.json` 说明和 ADR 0192 未跟上新语义（见问题 6）；`.claude/rules/prompt-prefix.md` 与本改动无关。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。改动只涉及 `scripts/check-operations.mjs`、`test/tooling/operations-check.test.mjs`、`ci/operations-pending.json`（外加一份 review 记录），没有触碰系统提示、工具定义、历史消息、遮盖或模型请求组装。发给模型的内容仍然只在末尾追加、每轮变化的值仍在最后一条消息里——这条性质由既有实现决定，本 PR 未改。

2. **会不会让同一段文字在不同请求里变成不同的字节？** 不会。本改动不参与任何模型请求序列化。检查脚本本身没有时间、随机数或网络读取；文件遍历顺序可能影响错误输出顺序，但不影响模型字节。

3. **有没有对应的自动检查，反向用例是否真的会失败？** 有：`package.json:33` 的 `check:operations` 同时运行脚本和 `test/tooling/operations-check.test.mjs`，并包含“真实仓库”用例。新增用例覆盖了大部分新错误码，但 `OPERATION_LIST_NOT_IN_GATEWAY`、精确 `===` 路由正例、无 `option` 清单的路由检查没有反向用例（问题 4、1）。受工具限制，我没有实际运行测试，**“反向用例实际会红”未核实**。

4. **新产生/修改的每个值，使用方都能接受吗？**
   - `INVENTORY_FILE`：脚本生成并用于读文件；测试使用同一路径字面量，两端一致。
   - 8 个新错误码：只在本脚本产生，测试按完整字符串断言，无其他消费者，一致。
   - 10 个新增待办键：在 `ci/operations-pending.json` 产生，由脚本 `pending[name]` 读取；已核对均在契约中（`contracts-v2.ts:89-111,1862-2101`），且都不在任何 `PRODUCTION_*_OPERATIONS` 清单中，`OPERATION_PENDING_NOT_IN_CONTRACT` 和新的 `notInstalled` 抑制逻辑都能接受。
   - `installedNames`/`notInstalled`：生产与消费都在本脚本内；但 `installedNames` 取“清单定义”而非“实际安装项”，语义偏宽（见推测）。
   - inventory 里的 `id`：只用于错误消息，不做枚举校验，可接受。
   - 未发现需要与后端/前端另一套校验对齐的新标识或序列化格式。
