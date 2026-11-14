## 结论范围

本轮复核了 `55af4340f..e243e4817` 的增量（`scripts/ci/merge-queue.mjs`、`test/tooling/merge-queue.test.mjs`、ADR 0268、复核记录），并跟到它直接影响的调用点：`processQueue` 的 `advance/start`、`mergeCandidate/failCandidate`、`createGithub.addLabel/call`，以及测试项目配置 `ci/policy.json`、`scripts/ci/test-scope.mjs`。旧代码只在证据指向时回看（`55af` 的 `mergeCandidate`/`failCandidate`/孤儿清理）。我没有执行任何测试（工具限制只允许读文件和指定 git 命令），下面关于“旧代码会失败”的结论是静态推演。

## 意见

### 1. 中 — 复核子进程持续失败会让整个队列永久停在一个 PR 上，且不计数、不停下、不通知

文件：`scripts/ci/merge-queue.mjs:518`、`scripts/ci/merge-queue.mjs:556`

问题：`review.broken` 现在返回 `halt`，`start` 随即 `break`，排在后面的 PR 本轮不再检查。问题是这个“本轮”会每轮重复：只要某个 PR 的复核子进程持续非正常退出（脚本崩溃、ENOENT、输出超限、超时），它既不会被移出，也不进入任何计数；队列不会 `stop`，不会在 PR 上留言，只有一行 `MQ_REVIEW_CHECK_BROKEN`。这会把原来“跳过坏 PR、继续处理后面的 PR”的局部问题升级成全局停摆，且没有上限。同轮新增的 `undecided` 只约束候选 CI，不覆盖复核子进程，两者语义不一致。

证据：

```js
    if (review.broken) {
      const first = (review.output.split("\n")[0] ?? "").slice(0, 200);
      log(`MQ_REVIEW_CHECK_BROKEN #${number} ${first}`);
      return { skip: true, halt: true };
    }
```

```js
      const verdict = await readiness(number, main);
      if (verdict.eject) await eject(number, verdict.eject);
      if (verdict.ready) ready.push(verdict.ready);
      if (verdict.halt) break;
```

建议：给 `broken` 单独的连续计数（或复用 `undecided`），到阈值后 `stop` 并在 PR/工作流摘要里留下可见原因；或者至少只在连续若干轮后才 `halt`，首轮仍继续检查后面的 PR，避免单个坏 PR 无声地饿死整条队列。

### 2. 低 — “超时计入 undecided”没有自动断言，改回 `drop("timeout")` 所有测试仍会通过

文件：`test/tooling/merge-queue.test.mjs:413`、`scripts/ci/merge-queue.mjs:484`、`docs/adr/0268-merge-queue-and-related-tests-on-prs.md:111`

问题：作者说法 1 明确把“候选 3 小时超时”算作一次没有结论，代码也确实调用了 `undecidedDrop`，但现有超时用例只断言 `cancel` 被调用、候选被重建，完全没有检查 `state.undecided`；新增的连续 3 次用例只覆盖 `startup_failure`（`ci-not-judged`）和 `run-missing`。把代码改回旧的 `return drop("timeout")`，测试仍然全绿，这条声明没有反向保护。ADR 验证清单也没有承诺超时计数的用例。

证据：

```js
    const created = Date.parse(state.candidate.createdAt);
    state = await step(env, { now: () => created + candidateTimeoutMs + 1 });
    expect(env.fake.calls.filter((c) => c[0] === "cancel")).toHaveLength(1);
    expect(state.candidate.branch).toMatch(/^mq\//);
```

建议：在该用例里补 `expect(state.undecided).toBe(...)`，并加一个连续 3 次超时就 `stop` 的用例（或把现有 3 次循环扩展成超时/找不到运行各一条），让“超时计数”与“run-missing 计数”一样有反向用例。

### 3. 低 — `halt` 在分组轮次里会把整个待测分组从状态中丢掉

文件：`scripts/ci/merge-queue.mjs:556`、`scripts/ci/merge-queue.mjs:558`

问题：`halt` 跳出循环后，如果本组前面没有产生任何 ready 候选，代码会走 `groups.slice(1)`，把当前分组整组从 `state.groups` 删除。PR 本身仍带标签、下次会按标签时间重新排队，所以不是数据丢失，但拆分出来的先后顺序（尤其是 CI 失败后拆半的顺序）会丢失，下一次可能把已知“合在一起会失败”的 PR 重新合批，再浪费一次完整 CI。这个 `slice` 是旧代码，但 `halt`（新代码）让“只处理了组内一部分就结束”更容易发生。

证据：

```js
      if (verdict.halt) break;
    }
    if (ready.length === 0) {
      if (fromGroup) state = { ...state, groups: groups.slice(1) };
      log("MQ_IDLE");
      return;
    }
```

建议：`halt` 时直接 `return`，不推进 `groups`；或者把 `halted` 记进返回值，让 `start` 区分“组内已全部检查完但都不就绪”和“因复核子进程失败提前中止”。

### 4. 低 — `undecided` 状态字段没有默认值或版本迁移，作者“分支不存在”只能在本地间接证实

文件：`scripts/ci/merge-queue.mjs:53`、`scripts/ci/merge-queue.mjs:36`、`scripts/ci/merge-queue.mjs:181`

问题：`undecided` 是 `55af` 才加进 `emptyState`/`validateState` 的，`version` 仍是 1，`loadState` 没有给缺字段的旧状态补默认值。如果 `merge-queue-state` 分支里存在 `55af` 之前的 `state.json`，第一次运行会 `MQ_STATE_UNDECIDED` 抛错，`main` 捕获后退出，队列直接不可用。作者说法 4 说分支还不存在；我在本地 `git log --all` 里没有看到任何 `merge-queue state` 提交，和说法一致，但远程分支当前是否存在无法离线确认。代码本身没有为这个前提兜底。

证据：

```js
  assert(Number.isSafeInteger(value.undecided) && value.undecided >= 0, "MQ_STATE_UNDECIDED");
```

```js
  return { version: 1, stopped: null, candidate: null, groups: [], undecided: 0 };
```

建议：`loadState` 时用 `{ ...emptyState(), ...parsed }` 或 `value.undecided ?? 0` 兜底；如果确实要区分旧格式，则提升 `version` 并写明确的迁移逻辑，而不是让唯一防线是一次外部事实（分支未创建）。

## 读代码证实的

- 增量只改了合并队列脚本、对应测试、ADR 和 `.agents` 复核记录；没有改提示词、工具定义、历史消息、遮盖或请求组装代码。
- `undecidedDrop` 的行为与作者说法一致：先 `drop`（删分支、清候选），再写 `undecided`，到 3 调 `stop`（`merge-queue.mjs:402-410`）。
- `run-missing`、`timeout`、`ci-not-judged` 三条路径都改用 `undecidedDrop`（`merge-queue.mjs:474`、`:486`、`:495`）。
- CI 给出成功或失败结论时，在进 `mergeCandidate`/`failCandidate` 之前清零（`merge-queue.mjs:496`）；人工 `resume` 也清零（`:597`）。
- 非 CI 原因的 `drop` 不增加 `undecided`（`merge-queue.mjs:392-396`）。
- `review.broken` 时日志首行截 200 字符并返回 `halt`（`merge-queue.mjs:518-521`）。
- `call` 抛出的错误带上 `status` 和完整 `body`（`merge-queue.mjs:226-231`）；`addLabel` 只在 `422 && errors[].code === "already_exists"` 时放过（`:325`、`:202-208`）。
- 测试项目 `tooling` 的 include 含 `test/tooling/**/*.test.mjs`（`ci/policy.json`）；`scripts/ci` 不属于 `test-scope.mjs` 的 `sourceFile`（`scripts/ci/test-scope.mjs:9-16`），因此本 PR 会触发全量 tooling，而不是只跑相关测试。
- 本地 `git log --all -40` 没有合并队列状态提交，间接支持“`merge-queue-state` 分支还没被创建”。

## 推测与未核实

- 远程 `merge-queue-state` 分支当前是否存在：未核实。只能确认本地所有 ref 里没有相关提交。
- 新用例在旧代码上的失败：我无法运行测试，以下为静态推演。测试①“成功结论后 main 被改也清零 + run-missing 计数”在 `55af` 上会失败，因为旧 `mergeCandidate` 的 `undecided: 0` 写在所有合并完成之后，`main-moved` 提前返回时不会清零；测试②“复核被杀后不再检查后面的 PR”在 `55af` 上会得到 `[1,2]`；测试③“长 message 下的 already_exists”在旧正则把响应截到 300 字符后匹配不到。孤儿分支用例在更早的 round-2 代码上失败也成立，因为 `55af` 才把清理从 `start` 开头挪到建候选之前。
- GitHub 创建标签返回 422 时的 `errors[].code === "already_exists"` 形状按官方文档和我读到的测试夹具推断，未在真实 GitHub 上复现。
- 意见 1 的“永久停摆”取决于复核子进程的失败是持续性的（脚本坏了、某个 PR 的记录必崩）；如果只是偶发超时，下一轮可能自行恢复。

## 作者说法核对

1. 基本准确。找不到运行、3 小时超时、跑完却没有成对结论都计一次；到 3 停；成对结论时在合并/判失败之前清零；`resume` 清零；非 CI 丢弃不计数。唯一没说的是 `undecided` 不会因非 CI 丢弃清零，所以“连续”并非严格相邻。
2. 准确。`halt` 和 200 字截断都在代码里。
3. 准确。错误对象带 `status`/`body`，标签检查改为按 `errors[].code` 判断。
4. 本地证据与说法一致（无状态分支提交），但远程未核实；代码没有默认值，前提若错会直接抛 `MQ_STATE_UNDECIDED`。
5. 准确。ADR 第 70、72、103、111 行确实补了状态字段、计数规则、跳过条件和验证清单。
- “3 条新用例在旧代码上失败”与静态推演一致；“孤儿分支用例在第 2 轮代码上失败”也与 `55af` 的 diff（把清理从 `start` 顶部挪到建候选前）一致。

## 侧重检查

- 错误路径：`run-missing`、`timeout`、`ci-not-judged` 都走同一个有上限的 `undecidedDrop`，不会再无限重跑；标签 422 只放过 `already_exists`。复核子进程 `broken` 是唯一没有上限的错误路径（意见 1）。
- 不合规范/不可信输入：`labelExists` 对响应体 `JSON.parse` 有 `try/catch`，畸形 JSON、非数组、`null` 都退回“不算已存在”，然后重抛原错误，安全。`state.json` 来自 `merge-queue-state` 分支，`validateState` 校验了类型，但 `createdAt` 只校验是字符串、不校验可解析（旧代码遗留）；如果状态被写成非法日期，`Date.parse` 得到 `NaN`，超时和 run-missing 判断永远为假，候选会一直等待。这个问题不是本增量引入的，但属于同一错误路径，建议顺手加 `Number.isFinite(Date.parse(...))`。
- 安全：没有新增执行 PR 代码的路径，复核仍在 PR 头的临时 worktree 里跑 `main` 上的脚本；新增的完整错误 `body` 只挂在 `Error` 对象上，`main` 的兜底只打印 `error.message`（仍截 300 字），不会把完整响应写进日志；没有新增密钥日志。
- 资源耗尽：复核超时 5 分钟、`maxBuffer` 16MB，候选超时 3 小时，`undecided` 上限 3；`halt` 减少了同一轮重复起复核，但没有限制跨轮重复（意见 1）。`review.output.split("\n")[0]` 是先 split 再 slice，虽然输出受 16MB 限制，仍会先分配整个行数组，属于很小的可优化点。
- 不可撤销操作：本增量在 `undecided` 路径上只删 `mq/*` 候选分支、清候选、写停止状态，不会合并、不会移出 PR；`eject`（摘标签、加失败标签）仍然只在明确的失败/不合规分支触发。没有引入新的不可撤销合并。
- 规则/文档一致：ADR 与代码在计数、清零、`halt`、标签 422 上一致；不一致之处是 ADR 的验证清单没有覆盖“超时计入 undecided”，也没有写出 `halt` 会跨轮持续阻塞后续 PR 的后果。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。增量只改 CI 合并队列脚本、测试、ADR 和复核记录；没有触碰系统提示、工具定义、历史消息、资料块或遮盖。`reviewChecker` 传给复核脚本的参数（`--assert-reviewed --pr --repo --main-ref`）在增量里没有变化（`scripts/ci/merge-queue.mjs:340-351`）。新增/变化的 `undecided`、`stopped.reason`、`error.status/body`、`halt` 只进入队列状态、日志和控制流，不会进入模型请求。发给模型的内容仍然只在末尾追加；每轮会变的值（时间、运行 URL）只在 `state.json`/日志里，既不在请求开头，也没有被塞进最后一条消息。依据 `.claude/rules/prompt-prefix.md` 第 1、4 条。
2. **会不会让同一段文字在不同请求里变成不同字节？** 不会影响模型可见内容。新增的动态字符串只出现在队列状态和日志；`saveState` 用 `JSON.stringify(state, null, 2)`，对象键由字面量固定、`groups`/`prs` 保持原顺序，同一状态快照序列化结果确定。`createdAt`、`stopped.at`、`run.url` 本身随时间/运行变化，但它们不参与模型请求，也不参与遮盖，因此不违反“字节必须确定”的请求约束。没有新增依赖前后文的遮盖。
3. **有没有对应的自动检查，反向用例真的会失败吗？** 有，`test/tooling/merge-queue.test.mjs` 在 tooling 项目里（`ci/policy.json` 的 `include` 含 `*.test.mjs`），而 `scripts/ci` 改动会让 PR 走全量测试。静态推演下，三条新用例在 `55af` 上都应失败：清零/run-missing、`halt` 只检查第一个 PR、长 message 下的 `already_exists`。但“超时计入 `undecided`”没有断言（意见 2），改回 `drop("timeout")` 不会红；另外标签用例只证明了“响应被截到 300 字时旧正则会误报”，没有加“`message` 里含 `already_exists` 但 `errors[].code` 不是它”的反向夹具，因此不能锁死“只按 code 判断”。我没有运行测试，以上是静态判断。
4. **改动产生或修改的每个值，使用端都能接受吗？** 逐一核对：
   - `undecided`：产生端 `emptyState`、`undecidedDrop`、清零/恢复处；使用端 `validateState` 要求非负安全整数（`:53`），持久化到 `state.json`，测试读取。上限到 3 即 `stop`，没有消费者要求别的范围，接受。
   - `stopped.reason`：产生端 `stop`，新增可能更长的含 URL 文本；使用端 `validateState` 只要求字符串，日志和步骤摘要按行输出，接受。
   - `halt`：产生端 `readiness`，唯一使用端是 `start` 的循环（`:556`），没有其他消费者，接受。
   - `error.status` / `error.body`：产生端 `call`（`:228-231`），唯一使用端 `addLabel`（`:325`）；`Error.message` 格式保持 `MQ_GITHUB_<status> ...`，测试和其它 catch（如 `main` 打印 `error.message`）不受影响，接受。
   - `labelExists`：内部函数，只被 `addLabel` 使用。
   - `undecidedLimit`：既有常量，未新增消费端。
   - 序列化格式没有变化（`version` 仍为 1，字段在 `55af` 已存在）；唯一跨版本风险是缺 `undecided` 的旧状态（意见 4）。
