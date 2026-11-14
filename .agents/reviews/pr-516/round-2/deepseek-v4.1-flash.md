结论：未发现高、中严重度问题。两条低严重度意见，均与测试覆盖和文档一致性有关；第一部分的哈希同步本身未发现错误。

### 1. 低 — 合并队列触发器的删除没有自动断言，现有测试在改动前后都会通过

文件:行：`test/tooling/merge-queue.test.mjs:753-760`，`.github/workflows/merge-queue.yml:2-3`

问题：这次改动真正改变行为的部分是删掉 `workflow_run` 和 `schedule`，但现有工作流测试只检查“不检出 PR 代码、不用 `pull_request_target`、检出 main、运行队列脚本、并发组”，没有任何关于 `on:` 触发器的断言。因此“33 条通过”只能说明测试没有回归，不能证明删除触发器这件事被自动检查覆盖；反向用例（例如以后有人把 `workflow_run` 加回来）也不会失败。

证据（读代码证实）：

```text
test/tooling/merge-queue.test.mjs:753-760
  it("工作流只在 main 的检出上运行队列脚本，不检出 PR 代码，不用 pull_request_target", () => {
    const text = readFileSync(".github/workflows/merge-queue.yml", "utf8");
    expect(text).not.toContain("pull_request_target");
    expect(text).not.toMatch(/head\.sha|head_ref|head\.ref|github\.event\.workflow_run\.head/u);
    expect(text).toMatch(/ref: main/u);
    expect(text).toContain("run: node scripts/ci/merge-queue.mjs");
    expect(text).toMatch(/group: merge-queue\n\s+cancel-in-progress: false/u);
  });
```

```text
.github/workflows/merge-queue.yml:1-8
name: Merge queue
on:
  workflow_dispatch:
    inputs:
      resume:
```

建议：如果希望临时状态受自动检查保护，可在上述用例加一条针对 `on:` 的断言（例如只含 `workflow_dispatch`），恢复时同步改回；如果不加，应在 PR 或 ADR 里明确“这段临时配置没有自动检查，靠人工恢复”。这只影响未来误改的发现能力，不是当前功能错误。

### 2. 低 — ADR 0268 仍把 `workflow_run` 和每 10 分钟定时写成合并队列的触发方式，与当前代码不一致

文件:行：`docs/adr/0268-merge-queue-and-related-tests-on-prs.md:68-69`、`:89`，`.github/workflows/merge-queue.yml:2-3`

问题：代码现在只有 `workflow_dispatch`，而 ADR 0268 仍写“触发方式是 CI 跑完（`workflow_run`）、每 10 分钟定时、手动触发”，并且第 68 行说“不触发就等下一次触发”。例外期间已经不存在“下一次触发”。`.agents/instructions/delivery-mode.md:27` 已经写明例外和恢复办法，所以操作性规则是自洽的；但 ADR 作为说明文档，在当前时点会误导读者以为自动触发仍然存在。

证据（读代码证实）：

```text
docs/adr/0268-merge-queue-and-related-tests-on-prs.md:68-69
- 入口：线程在原来“调用合并接口”的地方改成给 PR 加 `merge-queue` 标签，加完可以手动触发一次
  “Merge queue” 工作流，不触发就等下一次触发。……
- 工作流 `.github/workflows/merge-queue.yml` 在 ARM 机器上跑，触发方式是 CI 跑完
  （`workflow_run`）、每 10 分钟定时、手动触发；……

docs/adr/0268-merge-queue-and-related-tests-on-prs.md:89
| ……改用 CI 跑完、定时和手动触发 |
```

```text
.github/workflows/merge-queue.yml:2-3
on:
  workflow_dispatch:
```

建议：在 ADR 0268 的“合并队列”一节加一行现状说明，例如“2026-11-14 临时例外期间只保留手动触发，见 delivery-mode.md；恢复门禁时加回 `workflow_run` 和定时”，避免读者把历史设计当成当前行为。若认为 ADR 只记录设计、不必随临时例外改动，也应在复核记录里明确这一点。

**读代码证实的事项**

- `9dd41fe..7b98122` 只改三个文件：测试里的哈希、`merge-queue.yml`、`delivery-mode.md`。
- PR 414 确实没有改 `production-runtime-tools.unit.test.ts`：`git diff d611a2104..afcaff91c -- apps/agent-service/test/production-runtime-tools.unit.test.ts` 为空。因此“二分时 `d611a2104` 通过、`afcaff91c` 失败”与代码一致：414 改了 `tools.ts` 的 `rule_set` 文字，但没同步测试里的期望值。
- 测试计算哈希的方式是 `createHash("sha256").update(JSON.stringify(descriptors)).digest("hex")`（`production-runtime-tools.unit.test.ts:1892`），新常量是 64 位十六进制（`:2105-2106`）。这个值唯一的消费者就是同一个 `expect(...).toBe(...)`，没有发现第二处使用。
- `merge-queue.mjs:648` 只用 `GITHUB_EVENT_NAME === "workflow_dispatch" && env.MQ_RESUME === "true"` 判断恢复，`main()` 只要求 `GITHUB_ACTIONS`、`GITHUB_RUN_ID`、`GITHUB_RUN_ATTEMPT`（`:632-636`）；手动触发仍然满足这些条件，不依赖已删除的 `workflow_run` 负载。
- `scripts/ci/run.mjs:270-276` 仍把 `merge-queue.yml` 交给 actionlint 检查，工作流文件仍存在，不会被漏掉语法检查。
- `delivery-mode.md:27` 与代码一致：只保留手动触发，并写明恢复时加回两个触发器。

**推测 / 未核实**

- 我无法运行 vitest，因此 `dcd8b2fa...` 是否精确等于当前 `descriptors` 的 JSON 哈希、以及“118 条全过”“33 条通过”，均未独立核实。可从代码路径确认：本 PR 没有改动任何影响 `descriptors` 的代码，若该值是在基准 `9dd41fe` 上运行测试得到的，它在 HEAD 仍然成立。
- 删除定时触发后，如果队列进入 `stopped` 状态，只有人工 `workflow_dispatch` 且 `resume=true` 才能继续；这是预期行为，但属于运行流程变化，不是代码错误。
- 作者说“只改了测试里的哈希”，这只对第一个提交 `99236ba` 成立；整个 PR 还改了工作流和说明文档。作者随后单独描述了第二个提交，所以不算错误，但按“整个 PR”理解时不要漏掉后两个文件。

**侧重检查**

- 错误路径：`merge-queue.mjs` 的手动触发路径仍要求 `GITHUB_ACTIONS=true`、数字型 `GITHUB_RUN_ID` 和 `GITHUB_RUN_ATTEMPT`，删除 `workflow_run`/`schedule` 不影响这些条件的满足；未发现新增错误路径。
- 不可信输入：`workflow_dispatch` 的 `resume` 是布尔输入，经环境变量 `MQ_RESUME` 传入，没有拼进 shell；工作流只检出 `main`，不执行 PR 代码。未发现注入风险。
- 安全：没有引入 `pull_request_target`，删除自动触发反而减少了无人工介入的运行面。未发现新安全问题。
- 资源耗尽：删除每 10 分钟定时和 CI 结束触发，正是为了减少 ARM runner 占用，方向正确。
- 不可撤销操作：本改动没有新增删除、合并、部署等不可逆操作；合并队列自动合并被暂时关掉，风险降低。
- 规则/文档一致：`delivery-mode.md` 已同步；ADR 0268 仍描述旧触发方式（见意见 2）。
- 哈希值的两端：产生处是测试常量，使用处只有同一测试的等值断言，格式和长度正确；未发现其他消费者。

**必答问题**

1. **会不会改变模型已经见过的请求开头？** 本 PR 不会。它只改测试常量、GitHub 工作流和说明文档，没有触碰系统提示、工具定义、历史消息、遮盖逻辑或请求组装代码，因此发给模型的内容仍由现有机制只在末尾追加，每轮会变的值仍应只在最后一条消息里；这一点由现有 `check:prompt-prefix` 负责，我没有运行它（未核实）。需要区分的是：`rule_set` 工具文字的变化来自已合入的 PR 414，不是本 PR；按 [prompt-prefix.md](.agents/instructions/prompt-prefix.md#stable) 第 6 条，工具的旧字节按对话冻结，已有对话的请求开头不变，新对话使用新文字。至于第 11 条提到的“旧固定文字掉出信任清单可能影响老对话遮盖”，我检查了旧 `rule_set` 文字，未看到像密码/验证码的长数字序列；实际遮盖结果未运行验证（未核实）。

2. **会不会让同一段文字在不同请求里变成不同字节？** 本 PR 没有引入这种变化。测试哈希是固定常量，工作流和文档不参与模型请求；没有新增时间字段、随机值或无序集合。底层 `descriptors` 的序列化方式没有改变，且本 PR 未改产生它的代码。未发现依赖前后文的遮盖、带时间字段或无序集合。

3. **有没有对应的自动检查，反向用例是否真的会失败？** 哈希部分有：同一测试用等值断言检查，期望值错了测试就失败；基准提交上旧哈希对应新工具文字，按代码构造应当失败（我未运行 vitest，未独立确认）。工作流部分没有：`merge-queue.test.mjs:753-760` 不检查 `on:` 触发器，改动前后都会通过，删掉或加回 `workflow_run`/`schedule` 都不会让现有反向用例失败。文档部分没有自动检查。

4. **每个产生或修改的值，使用它的地方都能接受吗？**
   - 新哈希：产生于 `production-runtime-tools.unit.test.ts:2105-2106`，只被 `:1892-1894` 的断言使用，格式是 64 位十六进制，两端都是测试自身；未发现其他消费者。精确值未核实。
   - 删除的 `workflow_run`/`schedule`：GitHub Actions 是消费者，剩下的 `workflow_dispatch` 合法；`scripts/ci/merge-queue.mjs:648` 的恢复逻辑只认 `workflow_dispatch`，兼容；`scripts/ci/run.mjs:275` 仍能找到文件做 actionlint；`test/tooling/merge-queue.test.mjs:754` 仍能读取文件。唯一不接受的地方是 ADR 0268 的文字（见意见 2）。
   - `delivery-mode.md` 的新说明：读者是人和代理，内容与代码一致，并写明了恢复办法；没有发现校验脚本依赖这段文字。
