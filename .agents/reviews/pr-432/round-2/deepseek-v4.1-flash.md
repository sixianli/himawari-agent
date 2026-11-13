## 结论

这轮增量只改开发期检查脚本、测试、待办清单和复核记录，没有触碰任何模型请求的组装。代码核对下来，主要问题集中在**新门槛本身是否可靠**：处理方检查可被任意字符串字面量绕过；新增的待接入条目会连带屏蔽原有的完整性检查；文档与新语义、新数量不一致。未发现高严重度问题。

---

## 发现（读代码证实）

### 1. 中：`OPERATION_HANDLER_MISSING` 可被任意字符串字面量绕过；反过来，处理方若与网关同文件又会误报

**文件：** `scripts/check-operations.mjs:256-260`，另见 `:233`、`:391`

**问题：** 判断“处理方代码存在”只看后端文本里是否出现 `"操作名"`，注释、类型联合、错误信息、映射键、另一份清单都能满足。并且 `handlerTexts` 把含 `installedOperations: [` 的整个文件排除，若处理方与网关同文件就会被漏掉。

**证据：**

```js
      const found =
        (option && ownText.includes(`"${name}"`)) ||
        handlerTexts.some((text) => text.includes(`"${name}"`));
      if (!found)
        errors.push(`OPERATION_HANDLER_MISSING ${name} (${list.file} 里没有处理它的代码)`);
```

```js
  const handlerTexts = backendTexts.filter((text) => !/installedOperations\s*:\s*\[/.test(text));
```

**建议：** 不要用“出现过字面量”代替“存在分派”。至少要求该名字出现在 `query.type` / `command.type` 的比较、`switch case` 或明确的处理方映射中；排除注释和无关文件。补一条反向用例：后端文件里只留一处 `const label = "demo.write"`，但处理分支已删，必须报 `OPERATION_HANDLER_MISSING`。另补一条处理方与网关同文件的用例。

---

### 2. 中：新增的 10 个待接入条目会连带屏蔽原有的“后端/调用方/测试缺失”检查

**文件：** `ci/operations-pending.json:4-10,19-21`，`scripts/check-operations.mjs:395-399`

**问题：** 为了让“清单已声明但未安装”不报红，把 `capability.*` 和 `grant.*` 共 10 项加入了 `operations`。但待接入名单同时被用来压住 `OPERATION_INCOMPLETE`。这 10 项在基准提交里并不在名单中，说明当时的检查认为三项已齐全；从此以后，只要条目还在名单里，删除它们的后端、调用方或测试都不会再报红。

**证据：**

```js
    const reason = pending[name];
    if (missing.length > 0 && reason === undefined)
      errors.push(`OPERATION_INCOMPLETE ${name} 缺：${missing.join("、")}`);
```

```json
    "capability.detail": "能力管理：契约和页面已有，生产网关还没装配（没进已安装清单、没有路由到处理方）。...",
    "grant.detail": "授权管理：契约和页面已有，生产网关还没装配（没进已安装清单、没有路由到处理方）。装进已安装清单后移出名单",
```

**建议：** 把“未安装”的豁免与“缺后端/调用方/测试”的豁免分开，例如单独维护一份“已声明未安装”集合；或让这 10 项仍然走完整性检查，只跳过 `OPERATION_DECLARED_NOT_INSTALLED`。补反向用例：清单已声明、未安装、在待接入名单里，但后端实现缺失，仍应报 `OPERATION_INCOMPLETE`。

---

### 3. 低：ADR 0192 与新语义、新数量不一致

**文件：** `docs/adr/0192-delete-unimplemented-gateway-operations-and-gate-new-ones.md:48`

**问题：** ADR 仍写待接入名单是“缺项”名单、“一旦补齐，检查要求移出”，并写“名单目前登记 23 项”；代码现在允许“已声明未安装”的条目，且只有“补齐并已安装”才要求移出；当前 JSON 有 39 个键（本次新增 10 个）。ADR 状态仍是 `active/accepted`。

**证据：**

> 名单里的操作一旦补齐，检查要求移出；名单外新增的缺项直接报红；……名单目前登记 23 项

代码对应语义：

```js
    if (missing.length === 0 && reason !== undefined && !notInstalled.has(name))
      errors.push(`OPERATION_PENDING_BUT_COMPLETE ${name} 已齐全，从 ${PENDING_LEDGER} 移除`);
```

**建议：** 更新 ADR 的相关段落，或新增一份取代它的 ADR，写清“已声明未安装”这一新类别，并同步数量。`ci/operations-pending.json` 的 `说明` 已更新，但上游决策文档仍不一致。

---

### 4. 低：`withField` 只认冒号，`readInstalledArrays` 却认冒号和等号

**文件：** `scripts/check-operations.mjs:196-199` 与 `:109`

**问题：** 检测“这个文件有没有该数组”用的是 `:`，真正解析数组用的却是 `[:=]`。若以后写成赋值形式 `installedGatewayV2Operations = [...]` 或 `installedOperations = [...]`，会被误报为 `OPERATIONS_ADVERTISING_MISSING` / `OPERATIONS_GATEWAY_MISSING`。

**证据：**

```js
  const withField = (field) =>
    files
      .map((file) => ({ file, text: readCached(file) }))
      .filter(({ text }) => new RegExp(`${field}\\s*:\\s*\\[`).test(text));
```

```js
const GATEWAY_ARRAY_PATTERN = /(installedOperations|installedGatewayV2Operations)\s*[:=]\s*\[/g;
```

**建议：** 两处使用同一个模式（允许 `[:=]`），或直接复用 `readInstalledArrays` 的解析结果，去掉“先判断字段存在”的第二套规则。补一条赋值形式的用例。

---

### 5. 低：控制中心清单只识别“行首的 `id: "..."`”，内联写法会被静默跳过

**文件：** `scripts/check-operations.mjs:176-184`

**问题：** 用 `split(/\n\s*id:\s*"/)` 切分清单项。若新页面写成 `{ id: "x", queries: [...], mutations: [...] }` 或改用单引号/模板字符串，该页面声明的操作不会被读取，`OPERATION_DECLARED_NOT_INSTALLED` 不会触发；只解析出一部分时也不会报 `OPERATIONS_INVENTORY_UNPARSED`。

**证据：**

```js
  const parts = text.split(/\n\s*id:\s*"/).slice(1);
  for (const part of parts) {
    const id = part.slice(0, part.indexOf('"'));
    ...
      const block = new RegExp(`\\b${field}:\\s*\\[([\\s\\S]*?)\\]`).exec(part);
```

**建议：** 用 TypeScript/正则之外的结构化解析，或至少同时支持行内 `id:`、单引号和模板字符串，并校验解析出的页面数量。补一条内联清单项的反向用例。

---

### 6. 低：控制中心清单缺失检查只在存在 `PRODUCTION_*_OPERATIONS` 时执行

**文件：** `scripts/check-operations.mjs:374-378`

**问题：** 作者说“控制中心清单缺失报 `OPERATIONS_INVENTORY_MISSING`”，但代码要求 `lists.length > 0`。若已安装清单定义被整体删掉，清单文件也缺失时，不会报清单缺失；台账里“已声明未安装”的豁免也不会建立。

**证据：**

```js
  const inventoryPath = path.join(root, INVENTORY_FILE);
  if (lists.length > 0 && !existsSync(inventoryPath)) errors.push("OPERATIONS_INVENTORY_MISSING");
  else if (lists.length > 0) {
```

**建议：** 清单的存在性检查应独立于 `lists.length`（只要仓库应存在控制中心清单就检查）；或明确在注释和测试中写清这个条件。补一条“无清单定义且无清单文件”的用例。

---

## 推测 / 潜在风险

### 7. `readRouteBranches` 把整份网关文本当路由逻辑，安装清单里的 `options.*` 也可能被当成路由事件

**文件：** `scripts/check-operations.mjs:233-234`、`:140-162`

**证据：**

```js
  const branches = gateways.flatMap(({ text }) => readRouteBranches(text));
```

`readRouteBranches` 只按 `predicate... option` 的先后关系配对，不识别函数边界，也不在遇到非路由语句时清空 `pending`。当前真实网关在 `installedOperations` 数组前恰好没有悬挂谓词，所以未触发误报；但若以后有“没有 `options.X` 的尾部分支”排在安装数组之前，数组里的 `options.workspaceCopies`、`options.memoryControl` 等可能把前面的谓词误配成一个分支，造成误报或掩盖真实分支。建议在解析前先去掉 `installedOperations` / `installedGatewayV2Operations` 数组体，或限定只解析明确的处理函数区域。

### 8. 未核实项

- `.agents/reviews/pr-432/round-1/judgments.md`、`round-1/*.md` 等复核记录因 sparse checkout 和 records-path 限制无法读取，未核对第 1 轮 7+5 条意见的具体内容。
- 未运行测试或真实仓库检查；仅静态核对测试数量为 25 条 `it`。

---

## 侧重检查

- **错误路径：** 清单缺失/解析为空、台账缺失/JSON 损坏、网关缺失、数组为空、路由缺失均有对应错误码；`readCached`（`scripts/check-operations.mjs:192-195`）没有 try/catch，文件在遍历后消失或不可读时会直接抛异常而不是输出结构化错误。CI 仍会红，但诊断信息不如其他错误路径一致。
- **不合规范/不可信输入：** 脚本输入是 PR 源码，正则模式本身只用常量拼接，不存在从代码内容注入正则的路径。但检查依赖“字面量出现”和“同文件自豁免”（`surface.id ===`），PR 作者可以通过注释、类型或自豁免代码影响检查结果；这不是安全边界，但门槛可被绕过，见发现 1、5。
- **安全：** 未发现读取密钥、打印敏感内容、网络访问或写入仓库的逻辑；测试只写临时目录并在 `afterEach` 删除。
- **资源耗尽：** `balancedArray` 和 `matchAll` 的循环都以文件长度为界，没有由外部输入控制的无界循环；本改动不引入明显资源耗尽风险。
- **不可撤销操作：** 本增量没有删除、迁移、发布或其它不可撤销操作；只读源码和写临时测试文件。
- **规则/文档一致：** `prompt-prefix.md` 与本改动无关；`ci/operations-pending.json` 的说明已补；但 ADR 0192 仍停留在旧语义和旧数量，见发现 3。

---

## 必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**不会。** 本次改动范围是 `ci/operations-pending.json`、`scripts/check-operations.mjs`、`test/tooling/operations-check.test.mjs` 和 `.agents/reviews` 记录，没有改系统提示、工具定义、历史消息、遮盖或任何运行时组装代码。因此发给模型的内容仍然只是在末尾追加；本轮没有新增“每轮会变”的值，也没有把会变的值放进最后一条消息。检查脚本的错误输出只写到开发期终端的 stderr。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**不会影响模型请求。** 新增的错误码、待接入清单键和检查结果都不参与模型请求序列化。唯一的不确定性是脚本用 `readdirSync` 遍历文件（`scripts/check-operations.mjs:24,41`），在不同文件系统上错误**顺序**可能不同；这不改变模型字节，但如果把检查输出当快照使用会不稳定。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

**有自动检查，覆盖了一部分，但有两个明显缺口。** `package.json:33` 的 `check:operations` 已把脚本和单测接进 `npm run check`，新增用例覆盖了：无条件清单被抢路由、无条件清单缺处理方、缺广告数组、缺清单、清单解析为空、`===` 精确路由、已声明未安装。静态推理下，这些用例在旧代码上会失败（旧代码对 `option` 为空直接 `continue`；旧代码只在数组存在时检查广告；旧代码只在清单文件存在时检查）。缺口是：没有用例证明“处理方名字只出现在注释/类型/无关字符串里时仍会报缺失”；也没有用例证明“待接入条目不会压住后端/调用方/测试缺失”。因此“反向用例真的会失败”只对已写出的场景成立。

### 4. 每个新值/新标识/新清单项，产生它的地方和使用它的地方都能接受吗？

- **新错误码**（`OPERATION_ROUTED_TO_OTHER_HANDLER`、`OPERATION_HANDLER_MISSING`、`OPERATIONS_ADVERTISING_MISSING`、`OPERATIONS_INVENTORY_MISSING`、`OPERATIONS_INVENTORY_UNPARSED`）：只在脚本产生，由单测按完整字符串消费，没有其它后端或 CI 消费者；两端一致。
- **新增待接入键**（`capability.*` 7 项、`grant.*` 3 项）：都是契约里的查询/命令（`contracts-v2.ts:89-94,108-111`），能通过 `OPERATION_PENDING_NOT_IN_CONTRACT`；理由长度足够；也都是控制中心清单声明的操作（`control-center-inventory.ts:217-223,245-246`），因此会被 `notInstalled` 接受。但它们同时会被 `OPERATION_INCOMPLETE` 的 `pending` 判断接受，产生发现 2 的覆盖回退。
- **`INVENTORY_FILE` 路径**：与实际文件 `apps/control-center/src/app/control-center-inventory.ts` 一致，只在脚本内使用；测试里重复写了同一路径，但真实仓库用例也覆盖了实际路径。
- **新解析字段**：`installedOperations` / `installedGatewayV2Operations` 的“存在性判断”和“数组解析”两端规则不一致（发现 4）；`id:` / `queries:` / `mutations:` 的读取规则只接受特定书写形式（发现 5）。这些是目前最大的“产生端和使用端校验不一致”风险。

---

## 作者说法逐条核对

| 作者说法 | 核对结果 |
| --- | --- |
| 无条件展开的清单也检查；被别的分支抢走报 `OPERATION_ROUTED_TO_OTHER_HANDLER`，处理方缺失报 `OPERATION_HANDLER_MISSING` | **行为属实**（`scripts/check-operations.mjs:235-260`，测试 `:335-361`），但处理方检查可被任意字面量绕过，见发现 1。 |
| 找不到 `installedGatewayV2Operations` 报 `OPERATIONS_ADVERTISING_MISSING` | **属实**（`:220-226`），但只认冒号形式，见发现 4。 |
| 控制中心清单缺失或解析为空报 `OPERATIONS_INVENTORY_MISSING` / `OPERATIONS_INVENTORY_UNPARSED` | **基本属实**（`:374-378`），但只在 `lists.length > 0` 时成立，见发现 6。 |
| `installedNames` 只取真正进了 `installedOperations` 的清单 | **属实**（`:263-267`）。 |
| 删掉死代码，文件读取走缓存 | **部分属实**：无用的 `handlerOf` 已删，`checkInstalledRouting` 内加了缓存（`:191-195`）；但 `checkOperations` 前面已经整份读过一次后端文件，这里仍会重复读，缓存不是全局的。 |
| 单测 25 条通过，真实仓库检查通过 | **未核实运行结果**；静态数到 25 个 `it`。 |
| `ci/operations-pending.json` 说明补上“已声明未安装” | **属实**（`ci/operations-pending.json:2`）。 |
