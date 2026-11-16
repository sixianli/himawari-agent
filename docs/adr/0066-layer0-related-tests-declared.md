---
status: superseded
document_type: adr
decision_status: superseded
supersedes: ""
superseded_by: "docs/adr/0108-layer0-check-in-repository-and-fast-mode.md"
date: "2026-10-22"
---

# ADR 0066：第 0 层的直接相关测试由脚本推导，提交说明逐行声明

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

第 0 层是改产品代码前后跑的定向测试：能复现缺陷的测试，加上和改动直接相关的测试文件（[ADR 0057 的分层规则](0057-batch-layers-one-two-for-small-defects.md#batch-layers)）。“直接相关”一直由写方案的人凭印象挑选。同一类错误发生了三次：第 0 层漏掉了直接引用被改文件的测试，要等第 2 层（整个受影响的 Vitest 项目，Vitest 是本项目的测试运行器）才暴露，每次多花一整轮测试：

1. 2026-10-19 D-52（提交 `882cc959`）：改了 `apps/execution-worker/src/production-sandbox-execution-v2.ts`，漏了直接引用它的 `test/integration/sandbox-v2-container-route.test.ts`。
2. 2026-10-22 D-54（提交 `9969a646`）：同样改了那个文件，第 0 层只跑 3 个文件；第 2 层发现 `sandbox-v2-container-route.test.ts` 整体替换 `@himawari-agent/runtime-sandbox` 的替身缺了新增的导出，5 个用例超时。
3. 2026-10-22 D-55（提交 `51f8b927`）：改了 `packages/runtime-sandbox/src/job-host-main.ts`，漏了它自己的单元测试 `packages/runtime-sandbox/test/job-host-main.unit.test.ts`；第 2 层发现一个旧用例在新行为下失败。

按 [ADR 0060](0060-hard-constraint-on-third-repeat.md)，第三次要加所有代理都绕不过的硬约束。三次漏掉的文件都能从代码机械算出；三次的提交说明正文其实都写到了漏掉的文件（第 2 层发现后才补写），所以“在说明全文里找文件名”的检查三次都会放行。Claude 与 DeepSeek V4.1 Flash 各写了独立方案，取舍记录在 `.ci-output/handoff/2026-10-22-l0-omission-decision.md`。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **直接相关测试由脚本推导。** 改动里的产品源文件是 `apps/*/src/`、`packages/*/src/` 下文件名不含 `.test.`、`.spec.` 的脚本文件；测试文件是 `ci/policy.json` 的测试项目会收集的文件（各项目的包含规则减排除规则），要求哪些文件时用基线（`commit-msg` 用 `HEAD`，`pre-push` 用被检查提交的父提交）里的那一份，所以一个提交改 `ci/policy.json` 缩小不了它自己的要求；基线里还没有 `ci/policy.json` 时用本次的，声明的路径只要新旧任一份会收集就认；`ci/policy.json` 缺失、格式不对或没有任何包含规则时报错拒绝。一个测试文件满足任一条就是直接相关：
   - 用相对路径引用被改文件：静态 `import`/`export ... from`、动态 `import()`、`require()`、`vi.mock()` 等，以及 `new URL("...", import.meta.url)`；`.js` 说明符也匹配同名 `.ts`，目录说明符匹配其中的 `index`。
   - 和被改文件同包同名，例如 `src/job-host-main.ts` 对 `test/job-host-main.unit.test.ts`。
   - 被改文件的增删行里有 `export` 开头的行，而测试整体替换（`vi.mock`、`vi.doMock`）了被改文件所在的包。
   - 不追裸包名引用：几乎所有测试都按包名引用公共包，改一个公共包会命中上百个文件，第 0 层就变成了第 2 层。
2. **第 0 层清单至少包含推导结果，只可增加不可删减。** 推导命令：`python3 "$(git rev-parse --git-common-dir)/hooks/check-layer0-tests.py" derive`（工作区，含未暂存和未跟踪的文件，相对 `HEAD`；在仓库任何子目录和 `git worktree` 建的工作树里都可以运行，所以脚本路径从共享 git 目录取，不写成 `.git/hooks/...`），`derive --staged`（暂存区），或 `derive <提交>`。复现缺陷的测试和经包名、上层调用者到达的场景测试，仍由写方案的人另外加。
3. **提交说明逐行声明第 0 层跑过的文件。** 改了产品源文件的提交，说明里每个第 0 层文件一行 `Layer-0-tests: <仓库相对路径>`；推导为空时写一行 `Layer-0-tests: none`。只改文档、测试或配置的提交不要求。有意不跑某个推导出的文件时，仍要声明它，并在正文写明原因；这种情况应当很少。
4. **两道本机钩子强制执行。** 仓库共享的 git 目录 `.git/hooks/` 里（和检查新注释的 `pre-commit` 并列，主目录和所有 `git worktree` 共用）：
   - `commit-msg` 用暂存区相对 `HEAD` 的改动推导，声明缺文件、没有声明、声明了不是测试文件的路径时拒绝提交，错误码分别是 `L0_RELATED_TESTS_OMITTED`、`L0_RELATED_TESTS_UNDECLARED`、`L0_RELATED_TESTS_UNKNOWN`；
   - `pre-push` 对每个待推送的非合并提交按“父提交到该提交”重查，覆盖 `git commit --amend`（这时 `commit-msg` 的基线是被修改的旧提交，只看到这次修改的增量）和跳过 `commit-msg` 的提交。
   - git 出错、读到的对象不完整、`ci/policy.json` 或 `package.json` 不可用时，以 `L0_RELATED_TESTS_ERROR` 拒绝，不放行。
   - 合并提交不做这项检查，打印 `L0_RELATED_TESTS_SKIPPED_MERGE` 后放行：项目只在用户要求时合并，合并里解决冲突改了产品源时，说明里照常写声明行，由审核核对。根提交和还没有提交的分支按空树作基线检查。
   - 钩子文件和自测是本机文件，不在仓库里；安装、摘要和排障见[代理工具 Runbook](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/runbooks/agent-tooling-runbook.md)。opencode 和 Grok 的禁止规则已拒绝 `--no-verify`、改 `hooksPath` 和直接操作 `.git/hooks`。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

### 方案 A：在提交说明全文里找推导出的文件名（Claude 初稿）

- 好处：不需要新的说明格式。
- 代价：三次的真实说明正文都写到了漏掉的文件，检查三次都会放行，拦不住要拦的错误。

### 方案 B：专用声明行，加 `commit-msg` 和 `pre-push` 两道本机钩子（采用，声明行来自 DeepSeek 方案）

- 好处：声明行是第 0 层清单本身，和事后叙述分开；所有在本机提交的代理都经过同一组钩子；推导结果在写第 0 层脚本前就能拿到，清单从一开始就是全的。
- 代价：改产品源的提交说明多几行；改公共模块时推导出的文件可能有十个左右。

### 方案 C：再加一道 CI 检查（DeepSeek 方案的一部分，暂不采用）

- 好处：覆盖没装钩子的新克隆。
- 代价：要改 `scripts/ci/`，按 [ADR 0064](0064-layer3-individual-trigger-scope.md) 触发完整第 3 层；分支上已推送的历史提交都没有声明行，按范围检查会全部失败。所有代理目前都在本机提交，两道钩子已覆盖；出现绕过本机钩子的提交时再加。

### 方案 D：在上传或运行第 0 层脚本时检查

- 代价：第 0 层脚本形态各异，包装脚本只看到 `bash <脚本>`，要可靠检查就得解析任意 shell，误拒会教人绕开包装脚本。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 第 0 层的“直接相关”有了可重复的下限，漏掉的文件在提交前就会被点名。
- 钩子只证明声明里包含推导出的文件，不证明它们真的跑过并通过；谎报仍由第 0 层证据、提交说明和互相审核约束。
- 找不到的相关测试：只经包名引用又不整体替换的测试、经上层调用者到达的场景测试、按构建产物路径引用的产品路径测试、计算出来的模块路径；改 `test/fixtures/` 下的辅助文件不要求引用者。这些仍靠写方案的人判断和第 2 层兜底。
- 两道钩子只看暂存区和提交对象；`derive` 不带参数时读工作区，供写第 0 层清单时使用。
- 合并提交不检查，靠合并时的审核。
- 判断“导出列表 `export { ... }` 里有没有增删名字”时，按行找到第一个 `}` 就当列表结束；列表里的字符串含 `}`、或 `export {` 前面同一行还有别的语句时会判错。项目代码里这种写法极少，漏判时由第 2 层兜底。
- 以下引用方式不识别，当前仓库都没有用到，以后用到时由第 2 层兜底或扩展规则：`vi.mock(import("..."))` 这种以导入表达式作参数的替身、经 `index` 重新导出（`export * from "./x"`）到达被改文件的引用、`?raw` 等带查询的说明符、路径别名、`import.meta.resolve` 和用模板字符串拼出的模块路径。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0057：小缺陷批量跑第 1、2 层](0057-batch-layers-one-two-for-small-defects.md#batch-layers)
- [ADR 0060：第三次重复就加硬约束](0060-hard-constraint-on-third-repeat.md)
- [ADR 0064：第 3 层单独触发的范围](0064-layer3-individual-trigger-scope.md)
- [经验教训：第 0 层漏跑直接相关测试](../lessons.md#layer0-related-tests)
- [代理工具 Runbook](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/runbooks/agent-tooling-runbook.md)

[↑ 返回阅读导航](#contents)
