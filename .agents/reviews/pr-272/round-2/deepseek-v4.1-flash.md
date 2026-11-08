## 结论摘要

本轮增量只改了 `scripts/check-egress-redaction.mjs`、`test/tooling/egress-redaction-check.test.mjs` 和复核记录；没有改运行时请求组装，因此**不会改变发给模型的请求开头**。第 1 轮三条意见的方向都实现了，但找到 1 个会抛异常的登记校验缺口，以及几个正则会误报/漏报的边界。

## 会出错的问题

### 1. 中｜`scripts/check-egress-redaction.mjs:330-341, 346-349, 385`｜登记行缺 `calls` 时不是报错，而是 TypeError

【读代码证实】

`registryViolations` 用 `const calls = entry.calls ?? {}` 做了兜底，但后面比较时又把原始的 `entry.calls` 直接交给 `sameCounts`：

```js
const calls = entry.calls ?? {};          // 330
const names = Object.keys(calls);          // 331
...
if (!sameCounts(counts, entry.calls))      // 385
```

而：

```js
function sameCounts(left, right) {
  const names = new Set([...Object.keys(left), ...Object.keys(right)]);  // 347
```

只要某条登记行漏写 `calls`（或写成 `null`），且该文件确实有调用，`findSensitiveGateViolations` 就会在 `Object.keys(undefined)` 处抛 `TypeError`，而不是输出刚加上的“调用数要写成 `{ 函数名: 正整数 }`”。这正好是新增校验最应该覆盖的场景。新增测试只测了 `{ scanMachineSecrets: 0 }`（测试第 248-251 行），没有测缺字段或 `null`。

**建议**：把 `const calls = entry.calls ?? {}` 提到循环开始处，在校验和 `sameCounts` 中都用 `calls`；或让 `sameCounts` 对 `undefined/null` 按 `{}` 处理。补一条“登记行缺 `calls` 且文件有调用”的用例，断言输出新错误串而不是抛异常。

### 2. 低｜`scripts/check-egress-redaction.mjs:312, 371-374`｜改名检查不是只认导入，正常的 `as` 断言、注释、字符串会误报

【读代码证实：正则匹配范围；推测：未来会误伤】

作者说这是“找改名导入”，但代码是在**整段源码**上匹配：

```js
const GATE_ALIAS = new RegExp(`\\b(${GATE_NAMES})\\s+as\\s+[A-Za-z_$][\\w$]*`, "gu");
...
for (const match of text.matchAll(GATE_ALIAS))
  violations.push(
    `${relative}: 给整段拦下的函数 ${match[1]} 起了别名，检查会数漏；请直接用原名调用`,
  );
```

以下都会被当成“改名”而报错：

- `const guard = scanMachineSecrets as GateFn;`
- `const x = assertMachineSecretFree as any;`
- `// use scanMachineSecrets as a guard`
- `import type { scanMachineSecrets as ScanMachineSecrets }`
- `export { scanMachineSecrets as default }`

当前仓库里用 `grep` 没找到这些写法（只命中测试文件里的真实改名用例），所以现在不会立刻失败；但这是新引入的误报面，日常注释或类型断言就可能让 CI 假失败。

**建议**：把检查限制在 import/export 声明中的 `ImportSpecifier`/`ExportSpecifier`，或用轻量语法分析；至少要求同一行前面出现 `import`/`export`。补一条“类型断言/注释里的 `as` 不报错”的守护用例。

### 3. 低｜`scripts/check-egress-redaction.mjs:311, 315-318`｜计数正则放宽到 `\s*` 后，注释和字符串里的“函数名 (”也会被计数

【读代码证实：匹配语义；当前仓库未命中这类文本】

旧正则要求函数名后紧跟 `(`；新正则变成 `\s*(?:\?\.\s*)?\(`，因此 `// 调用 scanMachineSecrets (见文档)` 这类注释、字符串或带空格的声明也会被算成调用，进而和登记数不一致，产生假失败。

当前仓库 `grep` 到的 75 处都是真实调用或声明，暂未触发；但这是比旧实现更宽的误报面。

**建议**：要么在剥离注释/字符串后再计数，要么至少补一条“注释里的调用不计数”的反向用例。

### 4. 低｜`scripts/check-egress-redaction.mjs:312`｜改名检查仍有漏报，起别名后仍可绕开计数

【读代码证实：这些写法不匹配；推测：是否有人这样写】

`GATE_ALIAS` 只匹配 `名字\s+as\s+[A-Za-z_$][\w$]*`，以下都不会被拦住：

- `import { scanMachineSecrets as 扫描 }`（Unicode 标识符）
- `import { scanMachineSecrets /*x*/ as scan }`（注释隔开）
- `const { scanMachineSecrets: scan } = pkg;`
- `const scan = scanMachineSecrets;`

后两种本来就不是 `as` 改名，但同样会让调用计数漏掉。当前 `packages/sensitive-capture/src/index.ts` 是 `export *`，没有这种写法；这属于边界风险。

**建议**：如果目标是“调用点不能改名到检查认不出”，要么改用语法分析检查绑定，要么明确把这条规则降级为启发式并在文档里写清限制。

### 5. 低（本轮未改，顺带发现）｜`scripts/check-egress-redaction.mjs:361-366`｜`catch { continue; }` 会吞掉目录读取错误

【读代码证实：吞错；推测：实际触发条件】

```js
let files = [];
try {
  files = sourceFiles(directory);
} catch {
  continue;
}
```

`packages` 或 `apps` 下任意子目录不可读、损坏或遍历出错时，整个 base 被静默跳过，`findSensitiveGateViolations` 返回“没有违规”。CLI 里 `findEgressViolations` 的未捕获遍历通常会先把错误抛出来，掩盖这个问题；但 `findSensitiveGateViolations` 是导出的，测试或未来调用方直接调用时会得到假通过。

**建议**：只对 base 目录不存在的 `ENOENT` 放行（给测试夹具用），其他错误重新抛出；或在扫描前显式断言两个目录存在。

### 6. 低｜`scripts/check-egress-redaction.mjs:357, 391-395`｜重复的 `file` 登记行会被 Map 静默覆盖，新校验查不出来

【读代码证实：覆盖行为；当前 registry 无重复行】

```js
const registered = new Map(registry.map((entry) => [entry.file, entry]));  // 357
```

同一文件在 `SENSITIVE_GATE_CALLS` 里出现两次时，后面的行覆盖前面的行；`seen` 只记录文件路径，最后检查“登记里还有它”时两行都被视为已见。于是前一行里错误的 `calls` 不会参与比较，也不会被新校验拒绝。

**建议**：在 `registryViolations` 里检查 `entry.file` 唯一，重复直接报错；顺带校验 `entry.file` 是字符串。

## 侧重检查

- **错误路径**：decision/reason/非法 calls 值都有报告；但缺 `calls`/`null` 会在 `sameCounts` 抛异常；目录读取错误被 `catch` 吞掉。均已读代码确认。
- **不合规范或不可信输入**：检查直接对源码文本跑正则，不区分注释、字符串、类型断言；会产生上述误报，也可能被 Unicode/注释隔开的改名绕过。
- **安全**：脚本只读文件、不执行输入、不打印秘密；两个新正则都是线性结构，没有明显 ReDoS。检查本身是启发式门槛，不是运行时安全边界。
- **资源耗尽**：仍然递归遍历整个 `packages`/`apps`（旧行为），新逻辑只是多一遍 `matchAll` 和 O(登记行数) 校验，没有新增无界循环。
- **不可撤销的操作**：无。
- **规则/文档一致性**：`.claude/rules/prompt-prefix.md` 的只追加、字节确定要求与本次改动不冲突；但代码里新增的 `SENSITIVE_GATE_CALLS` 登记与校验在 `docs/`、ADR 中没有对应说明，作者“找改名导入”“调用数缺失会报错”的说法也和实现不完全一致。第 1 轮复核记录本次读取被 `records-path` 保护拒绝，未核实其原文，只按作者摘要和代码核对。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。改动文件只有检查脚本、测试和复核记录；脚本只做 `readdirSync`/`readFileSync`，不参与系统提示、工具定义、历史消息或遮盖结果的组装。发给模型的内容仍然只在末尾追加，每轮变化的值不受影响。

2. **会不会让同一段文字在不同请求里变成不同字节？** 不会。这是离线静态检查，不生成发给模型的内容；正则和错误消息都是确定性的。`readdirSync` 的顺序只影响违规输出顺序，不影响模型请求字节。

3. **有没有对应的自动检查，反向用例真的会失败吗？** 有新增用例（可选调用、改名导入、登记行校验、外部地址守护）。按代码推导，在 `61c9f35a` 上：可选调用用例和改名用例会失败，登记行用例也会因缺少新错误串而失败；但本次没有运行测试（只能读代码和用只读 git 命令），这是推导而非实测。外部地址守护用例在旧代码上也会通过，它是守护用例，不是反向用例。缺少“缺 `calls`/`null`”“注释或类型断言里的 `as` 不误报”的反向用例。

4. **改动产生的每个值，使用它的地方都能接受吗？** 我逐个核对了 `SENSITIVE_GATE_CALLS` 的 27 条登记：`decision` 都是 `保留`/`改成发往外部时遮值`/`改成原样放行`，`reason` 都非空，`file` 都存在且唯一，`calls` 中的函数名都在 `SENSITIVE_GATE_FUNCTIONS` 里，调用数与源码中的实际调用数一致（例如 `exa-public-search.ts` 的 `scanMachineSecrets: 4`、`pi-host-publication.ts` 的 `containsToolOutputSecret: 2`/`scanMachineSecrets: 3` 都对得上）。`SENSITIVE_GATE_CALLS` 和 `GATE_*` 没有其他外部消费者（只在脚本和本测试里使用）。唯一不能接受的是第 1 条的缺 `calls`/`null` 路径：`registryViolations` 能接受并报错，但后面的 `sameCounts` 不接受，会崩溃；第 6 条的重复 `file` 行则不会被校验。
