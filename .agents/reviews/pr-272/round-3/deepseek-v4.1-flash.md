# PR #272 第 3 轮复核结论

## 说明

本轮核对的是 `67684cdb..4baa6ba3` 的增量（脚本 + 测试），并核对了相关规则文件与 IPC/文档。按要求只报“会出错”的问题；未核实处已标注。

先给结论：**四处修改本身没有发现会导致崩溃或直接误判的高/中严重度缺陷，仓库现状按代码推断仍可通过。** 下面按严重度列出真正值得处理的问题（均为低），随后是“读代码证实/推测”分栏、侧重检查、必答问题。

---

## 发现的问题（按严重度）

### 1. 低 — `scripts/check-egress-redaction.mjs:312-315`

**问题**：改名检查的新正则要求 `import`/`export` 与 `{` 之间必须有空白（`\s+`），因此对合法的无空格写法 `import{scanMachineSecrets as scan}...` / `export{...}` 不匹配；同时 `[^}]*` 不能跨越花括号内的 `}`（例如 `import { /* } */ scanMachineSecrets as scan }`）。这类文件里通过别名调用时，`GATE_CALL` 数不到原函数名，`GATE_ALIAS` 又不报，检查会静默漏掉调用数，达不到“改名就报错”的目的。

**证据**（我读到的当前代码）：
- `scripts/check-egress-redaction.mjs:312-315`
  ```js
  const GATE_ALIAS = new RegExp(
    `\\b(?:import|export)\\s+(?:type\\s+)?\\{[^}]*\\b(${GATE_NAMES})\\s+as\\s+[A-Za-z_$][\\w$]*`,
    "gu",
  );
  ```
- 对比 `scripts/check-egress-redaction.mjs:311` 的 `GATE_CALL` 只按原函数名计数，别名调用不会被计数。

**建议**：把 `\s+` 改成 `\s*`（`import{` 合法），并考虑用更稳的解析方式或至少允许花括号内出现注释；另外增加一条用例覆盖 `import{...}` 与带注释的写法。若认为这种写法在 Biome 格式化后不会出现，应在注释或规则里写明“假设格式化器保证有空格”，并接受该缺口，而不是隐含假设。

---

### 2. 低 — `scripts/check-egress-redaction.mjs:375-380`

**问题**：`catch` 只在 `error.code === "ENOENT"` 时 `continue`，但 `sourceFiles` 内部对每个文件执行 `statSync`（第 262 行）。如果 `packages/` 或 `apps/` 树下存在悬空软链（或扫描期间文件被删），`statSync` 会抛 `ENOENT`，整个 base 的扫描被 `continue` 掉，等于静默跳过该目录下的全部整段拦下调用检查，可能让真实违规通过。

**证据**：
- `scripts/check-egress-redaction.mjs:375-380`
  ```js
  try {
    files = sourceFiles(directory);
  } catch (error) {
    if (error?.code === "ENOENT") continue;
    throw error;
  }
  ```
- `scripts/check-egress-redaction.mjs:257-267` 的 `sourceFiles` 递归中对 `full` 调 `statSync(full)`。

**建议**：“只放过顶层目录不存在”应与“子项 ENOENT”区分；可在 `sourceFiles` 内对单个条目 `statSync` 包 try/catch（悬空/消失条目跳过或报错），只有顶层 `readdirSync` 的 ENOENT 才整体跳过。当前行为是上一轮“只放过 ENOENT”的延伸，并非本轮引入，但本轮把它当成了明确的错误策略，建议一并收紧。

---

### 3. 低（测试覆盖）— `test/tooling/egress-redaction-check.test.mjs:254-279`

**问题**：本轮四个修复中，只有“缺 calls/重复登记”和“改名只看导入导出”有反向用例；**“文件路径为空时报错”和“非 ENOENT 重新抛出”没有对应用例**。因此这两个新分支即使被改坏（例如空路径不再报错、非 ENOENT 被吞掉）也不会被自动检查发现。

**证据**：
- 新增测试只覆盖：`calls: undefined`、重复登记（第 258-265 行）、改名（第 268-279 行）。
- `scripts/check-egress-redaction.mjs:332-336` 的空路径/重复分支中，空路径无测试。
- `scripts/check-egress-redaction.mjs:377-379` 的非 ENOENT `throw` 无测试（fixture 里 `apps` 缺失只走 ENOENT 分支）。

**建议**：补两条用例：`file: ""` 必须报“每一行都要写文件路径”；把某个 base 造成非 ENOENT 错误（例如把 `packages` 写成同名文件触发 `ENOTDIR`）时必须抛出而不是返回空违规。

---

### 4. 低（自动检查接线）— `package.json:44` 与 `ci/policy.json:242-246`

**问题**：`npm run check` 的 `check:egress-redaction` 只运行脚本本身，不运行 `test/tooling/egress-redaction-check.test.mjs`。该测试文件只通过 `ci/policy.json` 的 `tooling` 项目（`test/tooling/**/*.test.mjs`）在 `npm test`/CI 的 `test` 作业里执行。因此作者用“`npm run check` 35 步通过”作为验证，**并不覆盖本轮新增的反向用例**；快速模式下脚本内部回归不会被执行。

**证据**：
- `package.json:44`：`"check:egress-redaction": "node scripts/check-egress-redaction.mjs"`
- `package.json:27` 的 `check:steps` 里只有 `check:egress-redaction`，没有该 vitest 文件。
- `ci/policy.json:243`：tooling 项目 `include: ["test/tooling/**/*.test.ts", "test/tooling/**/*.test.mjs"]`；`ci/policy.json:148` 的 coverage/test 作业才包含 `tooling`。

**建议**：若希望本轮反向用例成为快速模式门槛，把该测试文件加入 `check:egress-redaction`（例如 `node ... && vitest run ... test/tooling/egress-redaction-check.test.mjs`）；否则在提交说明里明确“反向用例由 `npm test` 覆盖，`npm run check` 不跑”，不要把两者混为一谈。

---

## 读代码证实的结论

1. **`gateCalls` 修复正确**：`scripts/check-egress-redaction.mjs:324-326` 对 `null`/非对象返回 `{}`；`registryViolations`（343 行）和 `findSensitiveGateViolations`（399 行）都用它，`calls` 缺省不再触发 `sameCounts` 的 `Object.keys(undefined)` TypeError。错误信息仍用 `entry.calls`（401 行），`JSON.stringify(undefined/null)` 不会抛错。
2. **改名叫检测范围收窄正确**：`GATE_ALIAS`（312-315 行）只在 `import`/`export` 花括号内匹配 `名字 as 别名`，`const guard = assertMachineSecretFree as unknown as Guard` 不再误报；`export { ... as ... } from` 仍会报。新增用例 `test/tooling/...:268-279` 的断言与实现一致（该 fixture 只应产生 1 条别名违规）。
3. **重复登记/空路径会报错**：`scripts/check-egress-redaction.mjs:330-336` 用 `files` Set 检测重复，空字符串走第一个分支报错；没有引入崩溃。
4. **ENOENT 处理方向正确**：非 ENOENT 已改为 `throw`（377-379 行），符合“其他错误照常抛出”的说法；问题只在 ENOENT 的范围偏宽（见问题 2）。
5. **仓库现状推断通过**：`SENSITIVE_GATE_CALLS` 27 个 `file` 逐个看过，无重复；新正则匹配集是旧正则的子集（新匹配必然包含 `名字 as 别名`），不会新增仓库级违规；`packages/`、`apps/` 均存在，ENOENT 分支不会误触发。仓库中除测试 fixture 外，未搜到 gate 函数的 `... as ...` 别名。因此 `findSensitiveGateViolations()` 应仍返回 `[]`。**我没有运行测试/脚本，这一点是读代码推断，未实测。**
6. **新测试的“旧代码会失败”成立**：旧脚本对 `calls: undefined` 会在 `sameCounts` 抛 TypeError；旧 `GATE_ALIAS` 会把类型断言那行也算作改名，导致新增用例的 `toHaveLength(1)` 失败。作者关于这两条反向用例会失败的说明与代码一致。
7. **作者“只改了两个文件并加记录”基本属实**：`git show --stat 4baa6ba3` 显示改动为 `scripts/check-egress-redaction.mjs`、`test/tooling/egress-redaction-check.test.mjs`、round-2 复核记录与 `usage.jsonl`；与“上一轮之后只有一个提交”一致。
8. **`round-2/judgments.md` 中“不改的两条”理由**：**未核实**。工作区是 sparse checkout，`.agents/` 不在本地，`git show` 对 records-path 被拒绝（`REVIEW_GIT_REFUSED records-path`），无法读取该文件原文。

## 推测（未实测）

- 问题 1 的 `import{...}` 与花括号内注释写法在真实代码中出现的概率低；若 Biome 保证空格，影响有限。
- 问题 2 需要 `packages/`/`apps/` 下存在悬空软链或扫描期删除文件才会触发，常规 CI 工作树稳定，实际触发概率低。
- 关于“仓库通过”的判断基于读代码，未运行 `node scripts/check-egress-redaction.mjs` 或 vitest。

---

## 侧重检查（错误路径、不合规范输入、安全、资源耗尽、不可撤销操作、文档一致性）

- **错误路径/不合规范输入**：核对了 `calls` 为 `undefined/null/原始值/数组` 的行为（`gateCalls` 统一归一为 `{}`；数组/字符串会被 `Object.keys` + 函数名白名单拒绝，不崩溃）。`entry` 本身为 `null` 时仍会 `entry.file`/`entry.calls` 抛 TypeError，但这是既有行为、且真实常量注册表不会出现，未作为本轮问题上报（可视为“未覆盖”）。
- **安全**：该脚本是仓库静态门槛，不处理不可信外部输入；新增的 `[^}]*` 正则无灾难性回溯风险（按 `}` 线性推进）。改名绕过风险见问题 1。
- **资源耗尽**：`sourceFiles` 递归 + 两次全树扫描（egress 与 gate 各一遍）只增加线性时间；未见无限递归防护，但符号链接环会抛 ELOOP 而非静默，且非本轮引入。
- **不可撤销操作**：改动只读文件、打印违规、`process.exit(1)`，无写操作，无不可撤销风险。
- **规则/文档一致性**：`.claude/rules/prompt-prefix.md` 与本改动无关；`docs/incidents-and-gates.md` 的 I-73 教训（清单值必须过所有下游校验）在本改动中对应“注册表 `calls`/`file` 值是否被两个消费者接受”，已用 `gateCalls` 统一；未发现描述与代码冲突的文档。`docs/adr/0167` 只描述检测规则、未描述 `SENSITIVE_GATE_CALLS`，不构成不一致。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？**
不会。本改动只修改 `scripts/check-egress-redaction.mjs`（静态检查脚本）及其测试、复核记录；脚本只读源文件并输出违规字符串，不参与系统提示、工具定义、历史消息、遮盖结果的组装。依据 [prompt-prefix.md 第 4 条“已发出的内容只能追加”](.claude/rules/prompt-prefix.md#append-only)，本改动没有触碰任何发送给模型的字节；`findEgressViolations`/`findSensitiveGateViolations` 的输出只是退出码/日志，不进入请求。结论：不改请求开头，仍只在末尾追加，会变的值位置不受影响。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**
不会。改动不生成也不序列化任何模型请求内容；脚本内部 `JSON.stringify(counts)` 的键顺序取决于 `Object.keys` 插入顺序（来自文件匹配顺序），仅影响错误信息顺序，且 `sourceFiles` 用 `readdirSync` 的 OS 顺序，**这一点在脚本输出层面是不确定的**，但该输出不会发给模型，因此不影响请求字节的确定性。若严格要求检查日志可重复，可对 `counts` 键排序，但与本项目 KV 缓存规则无关。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**
有测试但不完全接在 `npm run check`：
- 脚本本身由 `npm run check` 的 `check:egress-redaction`（`package.json:44`）执行。
- 反向用例在 `test/tooling/egress-redaction-check.test.mjs`，经 `ci/policy.json:243` 的 tooling 项目在 `npm test`/CI `test` 作业运行，**不在 `npm run check` 里**（见问题 4）。
- 两条新增反向用例在旧脚本上会失败（缺 `calls` 会抛 TypeError；类型断言旧正则误报导致长度断言失败），判断与代码一致；但“空路径报错”“非 ENOENT 重抛”没有反向用例（见问题 3）。因此：**新增的两条有反向校验且会失败；另外两个修复分支没有对应的反向用例。**

**4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？**
改动涉及的值与两端核对如下（读代码）：
- `entry.calls`：产生于 `SENSITIVE_GATE_CALLS`（92-255 行）及测试注入的 registry；使用于 `registryViolations`（343 行）和 `findSensitiveGateViolations`（399 行），两端现在都经过 `gateCalls`（324-326 行）归一，`null`/非对象/缺省都能接受，不再抛 TypeError；仅 401 行错误消息直接 `JSON.stringify(entry.calls)`，对 `undefined/null` 安全。
- `entry.file`：使用于 `registryViolations`（332-336 行）、`registered` Map（370 行）、最终 `seen` 检查（405-409 行）。空字符串在 332 行被拒绝；非字符串不会进入 Set 但会在 Map 中作为键，后续不会崩溃。
- `entry.decision`/`entry.reason`：使用于 `registryViolations`（337-342 行），非允许值/空白理由会报错，接受面一致。
- `GATE_ALIAS` 的 `match[1]`：产生于正则捕获，使用于 387 行消息；始终属于 `SENSITIVE_GATE_FUNCTIONS` 白名单，安全。
- `gateCalls(entry)` 的返回值：同时供给校验（343-355 行）和比较（399 行），语义一致，符合 I-73“清单里的值必须过所有使用端校验”的教训。
- 唯一两端不完全对称的是错误消息用原始 `entry.calls`（401 行）而非归一值，但这是展示层、不参与判断，不属于“无法接受”。

**结论**：本轮四处修改正确，未发现会直接导致崩溃或仓库检查失败的新问题；需要关注的是改名正则的两个边界漏报、ENOENT 范围偏宽、空路径/非 ENOENT 缺反向用例，以及新测试未接入 `npm run check`。由于我未运行任何命令，仓库“当前通过”为读代码推断，未实测。
