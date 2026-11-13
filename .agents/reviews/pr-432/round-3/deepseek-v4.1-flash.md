## 结论

这次增量只改开发期的检查脚本、单元测试、待办清单和复核记录，没有改动任何生产/请求路径，因此不会影响发给模型的请求开头。主要问题是：新的 `notInstalled` 节没有和“控制中心清单已声明”做双向校验，这与清单说明和 I-73 的教训不一致；另外 ADR 文档没有同步。

## 读代码证实的问题（按严重度）

### 1. 中：`notInstalled` 的键没有校验“控制中心清单已声明”

- 文件:行：`scripts/check-operations.mjs:389-400`，`ci/operations-pending.json:2`
- 问题：说明里写 `notInstalled` 是“控制中心清单已声明、但还没装进生产网关”的操作，但代码只在遍历 `declared` 时让 `undeployed` 起豁免作用；反过来没有任何地方检查 `notInstalled` 的每个键确实出现在控制中心清单里。一个既不安装、又没被清单声明的操作，只要后端/调用方/测试齐全，就能安静地留在 `notInstalled` 里。这正是 I-73 那类“产生清单项的一端和校验清单项的一端没有对上”的缺口。
- 证据：
  - `ci/operations-pending.json:2`：`"notInstalled 是控制中心清单已声明、但还没装进生产网关已安装清单的操作"`
  - `scripts/check-operations.mjs:389-394`：
    ```js
    for (const { id, name } of declared) {
      if (routing.installedNames.has(name)) continue;
      notInstalled.add(name);
      if (pending[name] === undefined && undeployed[name] === undefined)
        errors.push(`OPERATION_DECLARED_NOT_INSTALLED ${name} (${id})`);
    }
    ```
  - `scripts/check-operations.mjs:396-400` 只检查“已在 notInstalled 但已安装”，没有反向检查。
  - `scripts/check-operations.mjs:416-419` 只校验契约存在性和理由长度：
    ```js
    for (const [name, reason] of [...Object.entries(pending), ...Object.entries(undeployed)]) {
      if (!contractNames.has(name)) errors.push(`OPERATION_PENDING_NOT_IN_CONTRACT ${name}`);
    ```
- 建议：在读取清单时额外保留“所有声明名”集合，对每个 `undeployed` 键检查 `!declaredNames.has(name)` 就报新错误（例如 `OPERATION_NOT_INSTALLED_NOT_DECLARED`），并补一条反向单测。

### 2. 低：同一操作允许同时出现在 `operations` 和 `notInstalled`

- 文件:行：`scripts/check-operations.mjs:392`、`:410`、`:416`
- 问题：两个字典没有交集检查。若同名同时存在，`pending[name]` 会压住缺失检查，而 `undeployed[name]` 又豁免已声明未安装；两份理由还可能互相矛盾。
- 证据：`scripts/check-operations.mjs:410-414` 只用 `pending` 判断完整性，`:416` 却把两份条目合并校验。
- 建议：对 `Object.keys(undeployed)` 中出现在 `pending` 的键报错，要求二选一。

### 3. 低：删除 `!notInstalled.has(name)` 后，局部 `notInstalled` Set 成了死代码

- 文件:行：`scripts/check-operations.mjs:383`、`:391`
- 问题：`const notInstalled = new Set()` 只有 `.add`，没有任何读取；这说明清理不完整，也容易让后续维护者误以为它仍参与判断。
- 证据：
  ```js
  const notInstalled = new Set();
  ...
  notInstalled.add(name);
  ```
  之后全文没有 `notInstalled.has(...)`。
- 建议：删除该 Set，或若本意是恢复某种豁免，明确使用它。

### 4. 低：`OPERATION_PENDING_BUT_COMPLETE` 的提示会把“应移到 notInstalled”的情况引向错误操作

- 文件:行：`scripts/check-operations.mjs:413-414`
- 问题：一个操作已齐全、已声明但未安装，如果还留在 `operations`，现在会报“从 ci/operations-pending.json 移除”；但真移出后它又会被 `OPERATION_DECLARED_NOT_INSTALLED` 打回。正确动作应是移到 `notInstalled`，提示没有说。
- 证据：
  ```js
  if (missing.length === 0 && reason !== undefined)
    errors.push(`OPERATION_PENDING_BUT_COMPLETE ${name} 已齐全，从 ${PENDING_LEDGER} 移除`);
  ```
- 建议：判定该名字是“已声明未安装”时，提示改成“移到 notInstalled”；或在文档/清单说明里写清。

### 5. 低：`withoutInstalledArrays` 按“内容字符串”替换，可能替换错位置

- 文件:行：`scripts/check-operations.mjs:140-145`
- 问题：`balancedArray` 从原文取数组内容，再用 `stripped.replace(body, "")` 按值删除第一次出现的同样字符串。若同样的数组内容在文件更早位置（注释、其他表达式）先出现，删掉的就不是目标数组；这里本来有 `match.index`，按区间切片更可靠。
- 证据：
  ```js
  for (const match of text.matchAll(GATEWAY_ARRAY_PATTERN))
    stripped = stripped.replace(balancedArray(text, match.index + match[0].length - 1), "");
  ```
- 建议：收集所有数组内容区间，按原索引从后往前切片，或对 `stripped` 中对应位置做区间替换。

### 6. 低：对象键查找会命中 `Object.prototype` 继承属性

- 文件:行：`scripts/check-operations.mjs:392`、`:410`
- 问题：`pending[name]` / `undeployed[name]` 用普通对象下标。若契约里出现名为 `constructor`、`toString`、`hasOwnProperty` 的操作，查找结果会是继承函数而非 `undefined`，从而压住 `OPERATION_DECLARED_NOT_INSTALLED` 和 `OPERATION_INCOMPLETE`。`pending` 上这是旧问题，本轮把同样的模式扩展到了 `undeployed`。
- 证据：`if (pending[name] === undefined && undeployed[name] === undefined)`；`const reason = pending[name];`
- 建议：统一用 `Object.hasOwn(pending, name)` / `Object.hasOwn(undeployed, name)` 判断，或把 JSON 结果放进 `Object.create(null)`。

### 7. 低：文档与代码不一致

- 文件:行：`docs/adr/0192-delete-unimplemented-gateway-operations-and-gate-new-ones.md:48`
- 问题：文档仍写“名单目前登记 23 项，按理由分四组”，并完全没有提到新的 `notInstalled` 节；当前清单是 29 项 `operations` + 10 项 `notInstalled`。这个 23 项在本次改动前就已过时，但本轮新增的 `notInstalled` 概念没有任何文档。
- 证据：同上第 48 行；`ci/operations-pending.json:34-44` 新增 10 项。
- 建议：本轮作者说 Docs deferred，但至少应把 ADR 的清单说明补上 `notInstalled`，否则规则文件、说明文档和代码不一致。

### 8. 低：反向用例覆盖有两个缺口

- 文件:行：`test/tooling/operations-check.test.mjs:394-437`
- 问题一：新增测试只覆盖了 `installedGatewayV2Operations = [...]` 的赋值写法（`test:420-424`），没有覆盖 `installedOperations = [...]`。作者声称“数组存在性判断与解析统一用 `[:=]`”，但网关安装数组的赋值写法没有反向用例。
- 问题二：没有“`notInstalled` 键未被清单声明”的用例，所以上面第 1 条问题不会被测试发现。
- 证据：
  ```js
  const assigned = {
    ...wired,
    [compositionFile]: "installedGatewayV2Operations = [ ...PRODUCTION_DEMO_OPERATIONS ];",
  };
  ```
- 建议：补两条反向单元测试；并把 `notInstalled` 与声明集合的校验写进脚本。

## 推测的问题

- 低（推测）：`readInventoryOperations` 的切分改为 `text.split(/(?<![\w.])id:\s*"/)` 后，会匹配清单文件里任何非标识符前的 `id: "..."`，包括注释、嵌套对象或其它顶层对象。当前真实清单只有 surface 条目，所以现在不出错；将来清单里若出现嵌套 `id`，可能把查询/变更归到错误的 surface id 上。
  - 证据：`scripts/check-operations.mjs:183`
  - 建议：只在 `CONTROL_CENTER_SURFACE_INVENTORY` 数组范围内切分，或要求条目同时出现 `route:` / `sourceSpec:`。
- 低（推测）：`withoutInstalledArrays` 的最坏复杂度是“数组个数 × 文件长度”，如果将来有超大源文件且包含大量安装数组，检查会变慢；当前仓库规模下没有资源耗尽风险。

## 作者说法核对

- “新增 `notInstalled` 只豁免控制中心已声明但没装进生产网关” —— **部分属实**。豁免确实存在（`scripts/check-operations.mjs:389-393`），但没有校验 `notInstalled` 键必须来自清单声明，见问题 1。
- “不再压住后端、调用方、测试缺失” —— **属实**。完整性检查只用 `pending[name]`（`scripts/check-operations.mjs:410-412`），`undeployed` 不会压住 `OPERATION_INCOMPLETE`。
- “装好后报 `OPERATION_NOT_INSTALLED_BUT_INSTALLED`” —— **属实**。`scripts/check-operations.mjs:396-400`。
- “真实仓库 capability.* 7 个、grant.* 3 个移到 notInstalled” —— **属实**。清单第 34-44 行正好 7+3；这些名字都在 `control-center-inventory.ts:213-224、240-261` 声明；都在 `contracts-v2.ts:89-94、108-111` 定义；`apps/agent-service/src` 的生产安装数组里没有它们，`packages/application/src/services/governance-gateway-adapter.ts` 有实现，前端和测试也有引用。
- “数组存在性判断与解析统一用 `[:=]`” —— **基本属实**。`scripts/check-operations.mjs:109、206、240` 都用了 `[:=]`；但 `installedOperations = [...]` 没有测试覆盖（见问题 8），`readInventoryOperations` 里的 `queries`/`mutations` 仍是仅冒号（那是清单内数组，不在此说法范围内）。
- “清单切分支持内联 id” —— **属实**。`scripts/check-operations.mjs:183`，测试 `test:414-419`。
- “路由分支解析前先去掉安装数组内容” —— **属实**。`scripts/check-operations.mjs:241` 调用 `withoutInstalledArrays`；测试 `test:427-437`。
- “单测 29 条通过” —— **未实际运行核实**，但文件里确实是 29 个 `it(`，且新用例覆盖了上述行为。
- “真实仓库检查通过” —— **未实际运行核实**；我人工核对了清单声明、契约名称、生产安装数组和三条完整性检查的数据，未发现会报红的组合。
- “去掉去数组内容这一步后新用例会失败” —— **逻辑上成立**：不剥离时 `dangling` 用例里的 `command.type.startsWith("demo.")` 会与数组体里的 `options.otherControl` 配成一条错误路由，测试期望的唯一错误之外会多出 `OPERATION_ROUTED_TO_OTHER_HANDLER`。未实际运行。

## 侧重检查

- 错误路径：核查了清单文件缺失/不可读、JSON 解析失败、理由缺失或过短、契约里不存在的名字。脚本都会报错，不会静默通过。`notInstalled` 的结构若是数组或异常值，多数情况会通过 `Object.keys`/理由校验报错，不会静默接受。
- 不合规范或不可信的输入：主要缺口是问题 1（`notInstalled` 不要求清单声明）和问题 6（继承属性名可压住检查）。清单和 JSON 都来自仓库、非用户输入，但作为 CI 门禁仍应按不可信输入处理。
- 安全：没有密钥、网络或文件写入；`check-operations.mjs` 只读仓库并在 stderr 输出错误。`notInstalled` 不能压住后端/调用方/测试缺失，因此没有发现它能绕过这三项检查的路径。
- 资源耗尽：`withoutInstalledArrays` 有潜在二次复杂度，但输入是开发者控制的源文件，当前无实际风险。
- 不可撤销的操作：没有。改动都是可回滚的仓库文件，测试只写临时目录。
- 规则/文档一致性：我通过 `git show HEAD:.claude/rules/prompt-prefix.md` 读了规则（工作区是稀疏检出，文件不在本地）。规则要求“工具定义 → 系统提示 → 历史 → 最后一条用户消息”且只追加；本次改动没有触碰这些路径。文档方面只发现 ADR 0192 过时（问题 7）。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 改动文件清单只有 `ci/operations-pending.json`、`scripts/check-operations.mjs`、`test/tooling/operations-check.test.mjs` 和 `.agents/reviews/...`；`check-operations.mjs` 只被测试导入，待办 JSON 也只被该脚本和文档引用，没有生产/提示词组装路径读取它。因此系统提示、工具定义、历史消息、遮盖结果都没有变化；运行时原有的“只在末尾追加、每轮变化值放最后一条用户消息”行为不受影响。
2. **不会。** 没有改动请求序列化、遮盖或资料块生成；`notInstalled` 理由都是静态字符串，没有时间、随机数或依赖后文的值。`Object.keys` 对同一份 JSON 字节是确定的；错误输出顺序不影响请求内容。
3. **有自动检查。** `package.json:33` 的 `check:operations` 会运行脚本和 29 条 `test/tooling/operations-check.test.mjs`。新增的“notInstalled 不压缺失”“装好后要求移出”“内联 id / 赋值数组”“剥离安装数组内容”都有对应用例，逻辑上把修复删掉会失败。但我没有实际运行测试（工具限制）。覆盖缺口见问题 1 和问题 8。
4. **逐个核对过。** `notInstalled` 新字段只被 `scripts/check-operations.mjs:343` 读取；10 个新键都在契约里（`contracts-v2.ts:89-94、108-111`）、都在控制中心清单里（`control-center-inventory.ts:213-224、240-261`）、都不在生产安装数组里，理由长度也满足 `MINIMUM_REASON_LENGTH`。新错误码只被脚本和测试使用，没有其它消费者。**唯一没有对齐的是：`notInstalled` 键没有反向校验“必须在清单里声明”**，即问题 1；另外 ADR 文档没有同步新增字段。

## 未核实

- 没有运行 `npm run check:operations`、Vitest 或真实仓库检查，因此“29 条通过”“真实仓库通过”“去掉剥离步骤后用例会失败”只做了代码和数据的静态核对，未做执行验证。
- `.claude/rules/prompt-prefix.md` 不在当前稀疏工作区，我是用 `git show HEAD:` 读到的；结论只基于该内容。
