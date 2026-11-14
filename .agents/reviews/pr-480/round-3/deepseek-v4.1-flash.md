## 结论概览

代码中的 `joins` 与改动前 `previousProblem` 的链检查逐行等价（只是抽成内部函数并调整了返回前缀的拼接位置）；`use=new-round` 的新逻辑在正常入口下不会把可补跑的情况误判成新开一轮；惰性 `skip` 在所有 low-fix 点确实拿到同一份缓存 Set。没有发现高严重度的运行时错误。发现的主要问题是**文档与代码不一致**和**一处新分支没有测试**。

---

## 发现（按严重度）

### 1. 中 — 新产生的 `use=new-round` 没有写进任何规则/说明文档

文件：`scripts/model-review/opencode-review.mjs:1438-1446`（产生处）
文件：`.agents/instructions/model-review.md:59`、`docs/incidents-and-gates.md:133`、`docs/lessons.md:758`（消费/说明处）

问题：代码新增了第三类建议值 `use=new-round`，但三处文档仍只枚举 `--previous <提交>` 和 `no-previous`。规则文件是线程/代理实际照做的操作说明，I-98 的目的就是避免白花复核费；给出一个未定义的值，代理看到后可能仍带着原 `--previous` 重跑同一轮，再次被拒或继续浪费钱。

证据（我亲自读到）：

```js
// opencode-review.mjs:1440-1446
const use =
  sameRound.length > 1 || joins(recorded)
    ? "new-round"
    : recorded === null
      ? "no-previous"
      : `--previous ${recorded}`;
return `REVIEW_PREVIOUS_REFUSED round-previous-differs round=${round} use=${use}`;
```

```md
<!-- .agents/instructions/model-review.md:59 -->
…并在 `use=` 后面写出该传的提交或 `no-previous`（不传 `--previous`，从分叉点整份复核）
```

```md
<!-- docs/incidents-and-gates.md:133 -->
…写明该传的提交（`use=--previous <提交>`）或 `use=no-previous`
```

建议：把 `new-round` 写进上述三处，并明确它的操作含义（新开一轮且不带 `--previous`，从分叉点整份复核）；或者干脆让代码继续只输出 `no-previous`，由线程自行决定换轮，避免新增未文档化的值。

---

### 2. 低 — “同轮有多个不同 previous”分支没有任何测试覆盖

文件：`test/tooling/opencode-review-merge-gate.test.mjs:1666-1689`

问题：作者声称“同轮有多个不同 previous 时提示 `use=new-round`”，但新加的 `new-round` 断言只有一处，走的是**单个** recorded previous + 早期 low-fix 不合格的路径（`sameRound.length === 1`，靠 `joins(recorded)` 为真）。`sameRound.length > 1` 的短路分支没有用例；一旦以后有人把这个条件删掉，测试不会红。

证据（我亲自读到）：

```js
// test:1681-1685
const invalid = [...f.first.slice(0, 2), { ...f.first[2], findings: ["V9"] }];
const stuck = [...invalid, ok(2, f.ledgerCommit, deepseek, { previous: f.fixed })];
expect(f.ask(undefined, { records: stuck })).toBe(
  "REVIEW_PREVIOUS_REFUSED round-previous-differs round=2 use=new-round",
);
```

全仓 `new-round` 在测试里只出现这一处（grep 确认）。

建议：补一条同轮存在两个不同 `previous` 的用例，断言 `use=new-round`。反向验证时删掉 `sameRound.length > 1 ||` 应能看到该用例失败。

---

### 3. 低（推测） — `use=new-round` 的可执行性偏弱，且多值分支未尝试挑出“能接上”的那个

文件：`scripts/model-review/opencode-review.mjs:1438-1446`

问题（推测，未构造到真实可达路径）：当 `sameRound.length > 1` 时无条件 `new-round`，即使其中一个 recorded previous 其实能接上链，也不会给出来；另外 `joins(recorded)` 失败时把 `chain-already-broken … use=no-previous` / `head-not-after-accepted … use=no-previous` 的具体 `use=no-previous` 吞掉，只留下 `new-round`，用户看不到“新轮也不要传 `--previous`”这一关键信息。

我核对过可达性：`roundForRun`（`opencode-review.mjs:1894-1902`）会拒绝给已 ok 的模型重跑、并要求同轮 head 完全一致，而 `REVIEW_MODELS` 只有 deepseek/glm 两个模型（`scripts/model-review/review-models.json:2`），所以“多值且其中一个可接链”在正常入口下基本不可达。因此这只是可读性/次优建议，不是会出错的缺陷。

建议：多值时可优先挑“唯一能接上链”的那个给 `use=--previous`；`new-round` 文案里带上“不要传 `--previous`”。

---

## 读代码证实的 vs 推测

- 读代码证实：
  - `joins` 与旧链检查逐行等价，仅同一轮分支的判断被有意改动（见下）。
  - `use=new-round` 确实未出现在三处文档中。
  - `sameRound.length > 1` 分支无用例。
  - 惰性 `skip` 用 `??=` 缓存 Set，main 的 `lowFixCheck` 每次新建 checker 但拿到同一 `claimsOwned`。
  - `previousProblem` 在 `opencodeBinary()`/`installGateway()`/`prepareCopy` 之前执行（`3293-3322` 早于 `3323`）。
- 推测（未执行、未构造真实账本）：
  - 多 previous 时“有一个可接链却被判 new-round”在正常 `roundForRun` 约束下不可达。
  - 测试反向用例“删条件会红”是按代码推理，未实际运行（工具限制只能用 read/grep/glob/git）。

---

## 侧重检查

- 错误路径：`previousProblem` 抛错位置在 `opencodeBinary()`、网关安装、建副本、写账本、花钱之前（`3293-3322` 对比 `3323-3347`）；入口用例 `1704-1760` 断言被拒时没有 `REVIEW_PID` 且工作区账本不被改动。结论：拒绝路径不花钱、不写账本，符合 I-98。
- 不可信输入/账本：工作区账本被当作输入，`lowFixChecker`（`1372-1404`）会重核 verdicts、quote、文件清单和 findings；入口用例把刚写坏的 `findings: ["V9"]` 账本喂进去，`1750-1756` 期望 `findings-differ` 被拒。结论：不合格 low-fix 不会因缓存/懒算被放过。
- 安全：`previous` 只作为 `git merge-base --is-ancestor` 的参数数组传入，无 shell 拼接；新增值只进错误字符串，无注入面。未发现秘密外泄路径（`skip` 只用于过滤 `claimsProblems` 文件，不进入任何输出）。
- 资源耗尽：`joins` 会为链上每个 low-fix 点调用 `lowFixProblems`（内部含 `unreviewedFiles`/逐文件 `git diff`），这是上一轮已有行为；本次把 `claimsProblems` 改为惰性只减少无 low-fix 点的开销，没有引入新的无界循环或写入。
- 不可撤销操作：本改动只读并抛错，没有新增任何写操作或需要回滚的动作。
- 规则/文档一致性：发现第 1 条不一致；其余“替补后重跑传同一个 `--previous`”的说法与 `sameRound` 只取 `outcome === "ok"` 的记录、且替补记录写入 `previous`（`3424`、`3488-3491`）一致。

---

## 必答问题

**1. 会不会改变模型已见过的请求开头？**
不会。改动只动了 `previousProblem`/`lowFixChecker`/`main()` 和测试、文档，没有触碰 `buildPrompt`（`opencode-review.mjs:345-375`）或 `resolveCommits`。发给模型的仍是同一个 `prompt` 字符串：固定指令在前（`350-361`），每轮会变的 `${head}`/`${base}`/`${previous}`/brief 追加在后面的 material 段（`362-374`）；`reviewModel` 重试也复用同一 `prompt`。新增逻辑只在开跑前拒绝，不会发出任何请求，因此不存在前缀变化，仍是“固定的在前、每轮变量追加在后”。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
不会。新增的 `"new-round"` 只出现在错误信息里，不进入 prompt。`sameRound` 是 Set，但长度 >1 时短路（顺序不影响结果），长度为 1 时唯一取值，输出确定；`claimsOwned` 只做 `has` 成员判断，不序列化；没有新增时间字段或无序集合进入请求字节。惰性缓存反而让同一轮多次查询得到同一份清单。

**3. 有没有对应自动检查，反向用例是否真会失败？**
有：`test/tooling/opencode-review-merge-gate.test.mjs` 的 5 条 `[I-98]` 用例（`1626-1760`），本次增量又加了 `new-round` 断言（`1681-1685`）和入口坏账本用例（`1750-1756`）。按代码推理：删掉 `joins(recorded)` 条件，`1683` 的期望会变成 `use=--previous f.fixed` 而失败；删掉 `main()` 调用，入口用例会跑到自检（`REVIEW_PID`/退出码变化）而失败。空白：`sameRound.length > 1` 无用例、惰性 skip 无专门用例；且我无法执行测试，实际红/绿未核实。

**4. 新产生/修改的每个值，所有使用处都能接受吗？**
逐个核对：
- `"new-round"`：生产代码只拼进 `REVIEW_PREVIOUS_REFUSED` 字符串，仓库内没有解析 `use=` 的代码；测试预期接受它。**但文档只接受 `--previous`/`no-previous`，此处不接受**（第 1 条）。
- `lowFixChecker({...})` 的 `skip`：现在要求是 Set。`assertReviewed` 传 `claimsOwned`（`1538`）、`main` 传 `skip()` 的缓存 Set（`3316-3319`）、测试传 `new Set()`（`1619`），三处类型一致。
- `ledgerPath`：`main` 用 `reviewKey(options)`（`3294`），`assertReviewed` 用 `reviewKey({ pr })`（`1521`），对 code-review 都是 `pr-<n>`，两端的 `lowFixProblems` 校验一致。
- `claimsOwned` 惰性值：只在 `lowFixProblems` 的 `skip?.has` 使用（`1246`），`??=` 保证同一份 Set，所有 low-fix 点一致。
- 其余 `point.files`/`point.findings` 的遮盖比较沿用上一轮逻辑，改为导出函数后没有改变参数含义。

未核实项：`.agents/reviews/pr-480/round-2/judgments.md` 因稀疏检出不在工作区，无法读取上一轮判断原文（`git show` 也被记录路径保护拒绝）；不影响以上基于当前代码的结论。
