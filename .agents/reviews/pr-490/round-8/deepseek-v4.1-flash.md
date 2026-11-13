## 结论概览
本轮增量（`b0abee2bf..61bfa10`）只改了 `exec-accounts.mjs` 的两个函数和测试文件。我核对了收敛/回滚路径，**没有发现高、中严重度的新缺陷**；只发现两处低严重度的测试断言问题（不影响生产行为）。作者本轮的说法与代码一致。

## 问题（按严重度从高到低）

### 低 — `test/tooling/multi-user-exec.test.mjs:394-402` 的负向断言不足，无法证明“保留 enabled 状态”
问题：该用例只断言调用里没有 `disable --now <socket>`，但若实现错误地同时发出 `stop` 和裸 `disable <socket>`（裸 `disable` 同样会删掉 enable 链接），断言仍会通过，于是“只停、不禁用”这一真正要守的行为没有被覆盖。

证据（我读到的新增用例）：
```js
const state = { "himawari-exec-andyaa.socket": { active: false, enabled: true } };
...
expect(calls).toContain("stop himawari-exec-andyaa.socket");
expect(calls).not.toContain("disable --now himawari-exec-andyaa.socket");
```
建议：直接断言该 socket 上没有任何以 `disable` 开头的调用，例如 `expect(calls.filter((c) => c.includes("himawari-exec-andyaa.socket") && c.startsWith("disable"))).toEqual([]);`。

### 低 — `test/tooling/multi-user-exec.test.mjs:404-410` 的用例名与模拟场景不符
问题：用例叫 “enable succeeds but start fails”，但 `fakeSystemctl` 对整条 `enable --now` 直接抛错（`run` 里 `throw new Error("ENABLE_FAILED")`），无法区分“enable 成功、start 失败”和“enable 整体失败”，所以它实际验证的是“抛错前已记下意图”，而不是名字所述的场景。断言本身仍有效（能反向验证 push-before-run），只是命名/覆盖面误导。

证据（`fakeSystemctl`）：
```js
run: (_command, args) => {
  calls.push(args.join(" "));
  if (failing && args[2] === failing) throw new Error("ENABLE_FAILED");
},
```
建议：改名（如“records intent before enable throws”）或在 fake 里区分 enable 与 start 两个阶段。

## 读代码证实的结论
- `enableSockets` 现在先记意图再执行，三种原状态的回滚都正确（`exec-accounts.mjs:303-304`、`308-315`）：
  - (false,false) → `disable --now`；(false,true) → `stop`；(true,false) → `disable`；(true,true) 不入账。
- 失败槽自身也会先入账，因此 `enable` 抛错后 `undoSockets` 能处理它；对未改动过的槽执行 stop/disable 是幂等的，未引入破坏性动作。
- 不再会把原本 enabled 但未运行的 socket 在回滚时误禁用（旧实现 `!wasActive` 一律 `disable --now`）。
- 没有新的文件/账本/系统状态序列化格式被引入；`changed` 数组的消费方只有 `undoSockets`。

## 推测 / 未核实
- （推测，低）socket 处于 `activating`/`failed` 时 `is-active --quiet` 为假，回滚会对其 `stop`，不能精确恢复原状态；这类边界旧实现同样存在，不是本轮引入。
- （未核实）`round-6/7/judgments.md` 不在工作树中，`git show` 也被策略拒绝，无法确认哪些条目已判定“不改”；本结论只基于本轮 diff 及当前文件内容。

## 侧重检查
- **错误路径/回滚**：失败时 `converge` 先 `undoSockets` 再 `restoreUnits`（`exec-accounts.mjs:354-367`）；本轮改动使失败槽也进入回滚集合，且三态恢复无新增误停/误禁用。结论：安全。
- **不可信输入**：`changed` 里的 `slot` 来自账本；`parseLedger` 用 `SLOT_PATTERN` 校验（`plan.mjs:203`），`addSlot` 再次校验（`plan.mjs:220`），`socketName` 仅做前缀拼接；systemctl 调用用 `execFileSync` 数组参数，无 shell 注入面。结论：一致。
- **不可撤销操作**：本轮只涉及 `stop`/`disable`/`disable --now`，均不删除目录/账号；`retire` 不在本轮 diff。结论：未引入新的不可撤销操作。
- **资源耗尽**：本轮改动不涉及内存/CPU/句柄配置或循环放大。结论：不适用。
- **规则/文档与代码一致性**：作者“失败回滚只停本轮之前没在运行的 socket”“先记意图再执行”与代码一致；本轮未触碰模型请求构造。

## 必答问题
1. **不改变已见过的请求开头。** 本轮 diff 只涉及 `scripts/operations/multi-user-exec/exec-accounts.mjs` 与测试，没有任何系统提示、工具定义、历史消息或遮盖逻辑被修改；发给模型的内容仍然只在末尾追加，每轮变化的值仍只在最后一条消息里（符合 `.claude/rules/prompt-prefix.md` 第 3、4 条）。
2. **不会。** 本轮没有新增序列化、时间字段或无序集合；`changed` 只是进程内数组，不进入任何请求内容，也不影响遮盖字节。
3. **有自动检查。** `package.json:40` 的 `check:multi-user-exec` 会运行整个 `test/tooling/multi-user-exec.test.mjs`，并已挂入 `check:steps`（`package.json:27`）。反向性我对照了 `b0abee2bf` 的旧实现：旧 `enableSockets` 在 `run` 之后才 `push`，抛错时 `changed` 为空；因此两条新用例在旧代码上会分别因缺少 `stop <socket>` / `disable --now <socket>` 而失败，确实能捕获本次改动。但用例 394-402 的负向断言不足以捕获“stop + 裸 disable”这一错误实现（见上）。
4. **两端一致。** 本轮新产生/修改的值的只有 `changed` 项 `{slot,wasActive,wasEnabled}`，唯一消费方 `undoSockets` 按同名字段读取布尔值，形状一致。`slot` 的产生端（账本解析 `plan.mjs:203`、`addSlot` `plan.mjs:220`）与使用端（`socketName`）的校验一致；`uid` 的下限/上限（`plan.mjs:205-206`）与 `converge` 的范围检查（`exec-accounts.mjs:326-331`）以及 `ensureAccount` 的账号 uid 比对（`exec-accounts.mjs:206`）互相吻合。没有新增配置键、清单项或序列化格式。
