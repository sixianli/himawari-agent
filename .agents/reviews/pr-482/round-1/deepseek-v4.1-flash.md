## 结论

没有发现高或中严重度问题。作者“只改报错文本、删三处注释不改逻辑、加一条测试”的说法与代码一致。改动不会进入模型请求，也没有改变覆盖率判定逻辑。发现 2 个低风险点和 2 个信息级建议；背景里的根因推断无法在仓库内核实。

## 读代码证实的问题

### 低：新错误信息把未校验的 `branch.type` 直接写进 CI 日志

- 文件：`scripts/ci/coverage-model.mjs:244`
- 问题：`branch.type` 在这条路径上没有做类型或取值校验，就被插进错误字符串。正常 mapper 输出是常量，但覆盖率报告最终来自可被改动的工作树测试产物，异常内容可能带换行、控制字符或超长文本，污染 CI 日志。
- 证据（我读到的代码）：

```js
for (const [id, branch] of Object.entries(record.branchMap)) {
  location(branch.loc, lines, filename);
  assert(
    Array.isArray(branch.locations) &&
      branch.locations.length > 0 &&
      Array.isArray(record.b[id]) &&
      record.b[id].length === branch.locations.length,
    `branch map/count arity differs: ${filename}`,
  );
  ...
  assert(
    record.b[id].every(integer),
    `invalid branch hit count: ${filename} line ${branch.loc?.start?.line} ${branch.type} counts ${JSON.stringify(record.b[id])}`,
  );
}
```

这里只校验了 `branch.loc`、`branch.locations`、数组长度和命中数，没有校验 `branch.type`。报告输入见 `scripts/ci/check-coverage.mjs:546` 的 `analyzeCoverage({ coverage: JSON.parse(reportBytes), ... })`。
- 建议：把 `branch.type` 限制在已知集合，或至少用 `JSON.stringify(branch.type)` 并截断长度；同时输出分支 `id` 和出错的下标，定位更准。
- 补充：正常路径下不是泄密，也不是可执行的注入，只是低风险的日志格式问题。

### 低：详细错误字符串对每条合法分支都会提前构造和序列化

- 文件：`scripts/ci/coverage-model.mjs:242-245`
- 问题：`assert` 是普通函数，第二个参数无条件求值，所以即使命中数合法，也会为每条分支执行模板字符串和 `JSON.stringify(record.b[id])`。这属于新增的固定开销；在很大或被恶意构造的命中数组上还会放大内存占用。
- 证据：

```js
const assert = (condition, message) => {
  if (!condition) throw new Error(`COVERAGE_INVALID: ${message}`);
};
...
assert(
  record.b[id].every(integer),
  `invalid branch hit count: ${filename} line ${branch.loc?.start?.line} ${branch.type} counts ${JSON.stringify(record.b[id])}`,
);
```

- 建议：只在失败时构造详细信息，例如先 `if (!record.b[id].every(integer)) throw new Error(...)`，或让 `assert` 接受惰性消息函数。

### 信息：新增测试没有覆盖动机中的 `if` 隐式 else 负数命中形状

- 文件：`test/tooling/coverage.test.mjs:334-338`
- 问题：新用例用的是 `cond-expr`，而 PR 动机是 `if` 的隐式 else（`locations[1]` 为空、命中数可能为负）。两者最终走同一个命中数断言，所以不是功能缺陷；但没有把最想确认的那条路径锁进测试。
- 证据：

```js
const negative = record();
negative.b[0][1] = -2;
expect(() => analyze({ [filename]: negative })).toThrow(
  `invalid branch hit count: ${filename} line 2 cond-expr counts [1,-2]`,
);
```

`record()` 的默认分支类型是 `cond-expr`（`test/tooling/coverage.test.mjs:79-87`）。
- 建议：再加一条 `type: "if"`、`locations[1] = { start: {}, end: {} }`、`b[0][1] = -2` 的用例，断言报错里仍是 `branch.loc.start.line` 和负数数组。

### 信息：删注释合规，但有一条实现理由没有替代记录

- 文件：`scripts/ci/coverage-model.mjs` 中原三处注释附近（对应 `git diff` 的三个删除块）
- 问题：三处删除都没有改变逻辑。仓库规则 `.claude/rules/owner-global-instructions.md:41` 明确要求“删除你编辑的每个文件里已有的注释”，所以删除本身是对的。第三条关于 90/85→80/70 的授权仍在 `docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:225` 有记录；但第一条解释“`end.column` 为 `null` 是因为 mapper 用 Infinity、JSON 编码成 null”的理由，我在文档中未找到替代记录。
- 建议：按规则把这条理由写进交付说明或相关文档，避免以后有人把 `value.end.column === null` 当成错误改掉。

## 推测与未核实

- **推测**：攻击者若能控制 `coverage-final.json` / 测试报告，就能利用未校验的 `branch.type` 做 CI 日志注入。缺少校验已证实；实际可利用性取决于 CI 是否允许 PR 修改生成报告的链路，我未做运行验证。
- **未核实**：作者关于 `ast-v8-to-istanbul 1.0.5` 把隐式 else 命中数算成“整个 if 命中数减去 if 体命中数”并可能为负的说法。仓库没有安装 `node_modules`，无法读依赖源码；也没有 CI 日志。仓库代码只能证明项目预期隐式 else 是空位置（`coverage-model.mjs:233-239`、`changedMetrics` 的 `reason` 字符串），不能证明减法算法。
- **未核实**：提交信息中的 lint、测试通过记录。本次只读复核，没有运行测试。

## 侧重检查

- **错误路径，已证实安全**：如果 `branch.loc` 缺失，`scripts/ci/coverage-model.mjs:224` 的 `location(branch.loc, ...)` 会先抛出 `missing source-map location`，不会走到新报错。反过来说，PR 464 能报出 `invalid branch hit count`，说明它已经通过了 `branch.loc` 校验，因此新报错里的 `branch.loc.start.line` 一定存在；`?.` 只是冗余保险。
- **隐式 else 路径，已证实安全**：`branch.locations[1]` 为空时在 233-239 行被跳过，但新报错用的是 `branch.loc`，不是为空的 `locations[1]`，不会崩溃或打印空位置。
- **不可信输入，低风险**：`branch.type` 未校验；`filename` 已由 `normalizePath`/`safeRelativePath` 限制在仓库内，且旧报错本来就包含文件名。命中数和行号是仓库自身覆盖率元数据，不是秘密；正常路径没有发现新的敏感信息泄露。
- **资源耗尽，低风险**：详细消息在合法分支上也会执行 `JSON.stringify`；命中数组长度受 `locations` 数量约束，且位置循环本来也要遍历，影响有限，但不是只在失败时才付出成本。
- **不可撤销操作**：本次改动没有删除、写入或修改外部资源，只改 CI 报错和测试，无不可撤销操作。
- **规则/文档一致性，已证实一致**：删除注释符合 owner 全局规则；90/85→80/70 的授权仍在 CI 质量门槛 Spec 中；代码行为未变，没有发现文档与代码冲突。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。改动只在 `scripts/ci/coverage-model.mjs` 和 `test/tooling/coverage.test.mjs`；`coverage-model.mjs` 的导入方只有 `scripts/ci/run.mjs:30`、`scripts/ci/check-coverage.mjs:33`、`scripts/ci/check-policy.mjs:21` 和测试文件，都是 CI/测试路径。没有触碰系统提示、工具定义、历史消息或遮盖。发给模型的内容仍然只在末尾追加，没有把每轮变化的值加入开头；新错误只经 `check-coverage.mjs:612` 写到 stderr。
2. **会不会让同一段文字在不同请求里变成不同字节？**
   不会。新文本不进入模型请求。即使只看 CI 错误文本，它由文件名、`branch.loc.start.line`、`branch.type` 和按数组顺序 `JSON.stringify` 的命中数组成，同一份报告每次应得到相同字节；没有时间、随机数或无序集合。不同报告产生不同文本是预期行为。
3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有。新增用例在 `test/tooling/coverage.test.mjs:334-338`；`test/tooling/**/*.test.mjs` 属于 tooling 项目（`ci/policy.json:197`），`ci/quality-policy.json:27-30` 也列出该测试文件。静态核对：旧实现只报 `invalid branch hit count: <文件名>`，不含新期望的 ` line 2 cond-expr counts [1,-2]`，所以把新用例放回旧代码会失败，反向用例有效。测试未实际运行，这是静态结论。
4. **改动产生的每个值，使用它的地方都能接受吗？**
   改动产生的值只有新的错误字符串。生产者是 `scripts/ci/coverage-model.mjs:244`；消费者是测试 `test/tooling/coverage.test.mjs:336-338`（子串匹配，已同步）和 `check-coverage.mjs:612`（原样写 stderr，未解析、无 schema），两端都能接受。没有修改标识、配置键或序列化格式。
   - `branch.type` 是唯一未校验的输入，见上面的低风险项。
   - `branch.loc` 在到达新报错前已由 `location()` 校验，因此 `branch.loc.start.line` 必然存在。
   - 删除 3 行注释会改变该文件的行号和文件哈希，从而改变覆盖率 `sourceTreeSha256`；未发现 scripts/tests 中硬编码该文件行号或哈希的使用方。历史资格证据的 `frozen-inputs.json` / `source-freeze.json` 仍记录旧哈希 `df63d19...`，但 grep 未发现自动读取这些清单对照当前文件的代码；它们是历史快照，不应为了匹配当前文件而改写，也没有闸门因此失败。
