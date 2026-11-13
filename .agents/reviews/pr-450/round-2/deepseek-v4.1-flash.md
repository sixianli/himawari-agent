## 结论（按严重度）

### 1. 中 — `scripts/model-review/plan-claims.mjs:126-138`：分号拆分只查“片段在文件里”，编造的组合引文能通过

问题：新的回退路径把 `；` 当成和 `…` 一样的省略分隔符，但只要求每个片段（≥4 字符）在文件任意位置出现，不检查顺序、相邻关系，也不检查是否在引用的行附近。完全虚构的片段仍过不了，但把文件里真实存在、彼此无关的片段用 `；` 拼成一句，就能通过。

证据（我读到的代码）：

```js
128:  const everyFragmentPresent = (separator) => {
129:    const fragments = stripQuoteMarks(quote)
130:      .split(separator)
131:      .map((fragment) => collapse(stripQuoteMarks(fragment)))
132:      .filter((fragment) => fragment !== "");
133:    return (
134:      fragments.length > 0 &&
135:      fragments.every((fragment) => fragment.length >= 4 && haystack.includes(fragment))
136:    );
137:  };
138:  return everyFragmentPresent(/…|\.\.\./) || everyFragmentPresent(/…|\.\.\.|；/);
```

按这段实现可以确认：`.github/workflows/ci.yml:326` 有 `if: always()`，`:348` 有 `CI_DRAFT_UNVERIFIED`，所以引文 `always()；CI_DRAFT_UNVERIFIED` 会返回 true，尽管文件里从来没有这一串；同理 `MemoryMax=20G；MemoryHigh=19G` 也能通过（源文件顺序相反）。这不是“逐字原文”。`…` 本来也没有顺序校验，所以不是全新类别的漏洞，但本次放宽让“用分号拼出来的伪引文”看起来更像文件里的原字面，扩大了门禁的盲区。

另外，`.agents/instructions/model-review.md:37` 仍写着“模型没读到代码、编了引文，都过不了”，和放宽后的实际能力不一致——组合出来的引文能过。

建议：分号回退时至少要求各片段按源文件顺序出现，并限制在引用的行号附近（或同一行区间）；或者维持严格检查，要求模型用 `…` 表示省略。补一条反向用例：`MemoryMax=20G；MemoryHigh=19G`（当前会通过），以及两段来自无关位置的拼接。文档改成“整段虚构的引文过不了；真实片段拼接仍可能通过”。

### 2. 中 — `docs/adr/0256-gate-job-gets-its-own-runner.md:50-55` 与 `.agents/evidence/ci-queue-2026-11-12.md:3`：证据文件没有被 ADR 引用，前提来源仍然不可追溯

问题：新文件自称“ADR 0256 背景和前提里的实测数字出自这里”，但我在 ADR 0256 里没有找到任何指向 `.agents/evidence/ci-queue-2026-11-12.md` 的引用；前提 7、11、12 仍然只写“GitHub 接口”“作业日志”。

证据：

```md
# .agents/evidence/ci-queue-2026-11-12.md:3
ADR 0256 背景和前提里的实测数字出自这里。……

# docs/adr/0256-gate-job-gets-its-own-runner.md:50
7. 实测（2026-11-12 19:30 JST，GitHub 接口）：……
# :54
11. ……来源：GitHub 接口 `actions/runs?status=queued` 和各运行的 `jobs`。
```

这和 `.claude/rules/proposal-premises.md` 的要求不符：“给每个前提注明来源（带行号的文件路径，或 URL），并引用它所依据的原话。”结果是从 ADR 根本找不到这份证据文件，文件成了孤立的记录；`plan-claims` 模型也只会看到 ADR 里的“GitHub 接口”，无法据此找到仓库内的证据。

建议：在前提 7、11、12（或背景）里加上 `../../.agents/evidence/ci-queue-2026-11-12.md` 的具体行号引用；数字来自外部接口这一点也写清“实测记录见该文件第 N 行”。

### 3. 低（推测）— `docs/adr/0256-gate-job-gets-its-own-runner.md:87`：PR A 改全局标签后，现有测试断言会先失败

问题：ADR 的 PR A 清单说“标签从全局一个值改成每个 runner 自己的值”，并把跨文件对照放到 PR B。但现有测试仍硬编码全局标签，且和 `contracts.mjs` 对照：

```js
// test/tooling/ci-runner-scripts.test.mjs:320-331
expect(runners).toContain(`RUNNER_LABEL=${linuxRunnerLabel}\n`);
expect(runners).toContain("RUNNER_HOST=ci-vps\n");
...
--labels "$RUNNER_LABEL"
...
LABEL=$RUNNER_LABEL
```

```js
// scripts/ci/contracts.mjs:7
export const linuxRunnerLabel = "ci-vps";
```

如果 PR A 按 ADR 删掉全局 `RUNNER_LABEL` 或改成按 runner 设置，这些断言在 PR A 就会失败，不用等 PR B。ADR 的 PR A 测试条目只说“断言 3 号的标签…”，没有明确说同时删除/改写上面这条旧的全局断言。这属于计划内部的衔接问题，不是本 PR 当前代码的错误；我没有看到 PR A 的实现，标为推测。

建议：在 PR A 的测试条目里明确写出“同时删掉/改写现有的全局 `RUNNER_LABEL=${linuxRunnerLabel}` 和 `LABEL=$RUNNER_LABEL` 断言”，避免 PR A 自带 CI 就红。

## 侧重检查

- 错误路径 / 不合规范输入：`claimEvidenceProblem` 仍会处理 `location-missing`、`location-file-missing`、`location-line-out-of-range`（`plan-claims.mjs:141-150`），`locationOf` 会校验路径；新变化只影响代码引文的匹配。模型答案可任意构造，因此上文的“片段拼接”就是这里最大的不可信输入风险。
- 安全：本次改的是本地复核脚本，没有联网、没有密钥、没有把值写进模型提示。证据文件里是公开的 run id 和仓库路径，没有看到像密钥的内容；合并门的密钥扫描在本环境无法运行，未核实。
- 资源耗尽：`quoteInText` 现在最多做两次拆分和两次 `includes` 扫描，复杂度仍受答案长度和文件大小约束，没有引入新的无界循环或递归。没有运行性能测试，未核实。
- 不可撤销操作：本 PR 没有执行任何删除/部署。计划里的 `uninstall-runner.sh all` 会增加删除 `ghgate.slice`，但现有流程会先停止 runner，再删共享单元；这是计划，未实现，未核实。
- 规则/文档与代码一致：前提 15 的 `register-runner.sh:11-14`、`uninstall-runner.sh:10-14`、`mac-runners.sh:4` 我逐行核对，和 ADR 改后的说法一致；PR A 清单提到的 `gh-runner.service.in`、`install-runner.sh`、`prepare-vps.sh`、`gh-runner-nft.service` 确实都有对应写死 1、2 号的地方。`amended_by` 两个目标文件都存在。没有发现“清单 id 过不了后端校验”这类问题，但证据文件未链接、以及 PR A 旧测试断言是两处不一致。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。改动只在 `plan-claims.mjs` 的合并检查函数里，不进提示词。`.agents/instructions/model-review.md` 虽然是必答问题的来源，但 `reviewQuestions` 只取 `<a id="checklist"></a>` 到下一个 `<a id=…`/`## ` 之间的编号条目（`scripts/model-review/opencode-review.mjs:236-247`），本次改的第 37 行在“合并检查”段落里，不在 checklist 内；必答问题仍按 `--base`（或 plan 模式的 head）读取（同文件 `:2504-2510`、`:3134-3145`）。因此固定的系统提示、工具定义、必答问题都不变，新内容只可能出现在末尾材料（ADR/证据）里。作者说“不改发给模型的任何内容”基本成立。

2. **同一段文字会不会在不同请求里变成不同字节？** 不会。`quoteInText` 是纯函数，只依赖 quote 和文件内容，没有时间、随机数或无序集合；新增证据文件里的日期和运行号也是提交里固定的字节。ADR 的 `amended_by` 是固定字符串。未发现新的非确定序列化。

3. **有没有自动检查，反向用例真的会失败吗？** `quoteInText` 有新用例（`test/tooling/plan-claims-gate.test.mjs:213-221`）：`MemoryHigh=19G；MemoryMax=21G`（一段不在文件）、`MemoryHigh=19G；20G`（一段不足 4 字符）、`；`（只有分号）都会是 false；如果把分号回退删掉，正例 `MemoryHigh=19G；MemoryMax=20G` 会变成 false。所以这部分有有效覆盖。但**没有**覆盖“真实片段顺序颠倒/来自无关位置的拼接”这一本次放宽带来的风险，也没有集成测试证明一条伪组合 CLAIM 会被拒。ADR 的 `amended_by` 改动没有自动校验：`scripts/check-adr-numbers.mjs` 只查文件名、标题和文档链接（`:11-30`、`:72-98`），不读 `amended_by` 的值。作者说的“37 条通过、biome/格式通过、文档 13 条错误和 main 相同”，本环境不能运行，未核实。

4. **改动产生/修改的每个值，使用方都能接受吗？** 逐个核对：
   - `quoteInText` 的新分隔符：唯一使用方是 `claimEvidenceProblem`（`plan-claims.mjs:149`），会接受；但如第 1 条所述，接受范围过宽。
   - `amended_by` 新增的 `docs/adr/0256-…`：两个目标文件都存在；没有代码读取这个字段，所以不会破坏程序，但也没有自动校验拼写。
   - 新证据文件路径：没有任何文件引用它，是孤立的；见第 2 条。
   - ADR 计划里的 `ci-vps-gate`、`ghgate.slice`、`gateRunnerLabel`、`upgradeGateRunnerPolicy`：现在都还不在代码里，不能做“两端校验”；`ci-vps-gate` 要等 PR B 才进 `contracts.mjs`/policy，跨文件测试也明确推迟到 PR B，这一点和 ADR 说明一致。
   - 现有 `RUNNER_LABEL` 全局值的使用方包括 `test/tooling/ci-runner-scripts.test.mjs:320-331`、`register-runner.sh:29`、`mac-runners.sh:4`、`runner-pause.sh:25`；ADR 已列出后三者，但我没有看到 PR A 对旧测试断言的明确处理，见第 3 条（推测）。

读代码证实的：前提 15 的行号与内容、`gh-runner.service.in:25-26/37`、`gh-runners.slice:6-7`、各脚本对 1/2 号的写死、`opencode-review.mjs` 的必答问题提取逻辑、`quoteInText` 的拼接放行逻辑。
推测或未核实的：GitHub 接口实测数字（28 次排队、20 次只剩 `ci/required`、run id、耗时）、37 条测试/lint/文档严格校验结果、PR A 实际实现是否会撞上现有测试断言。
