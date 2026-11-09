现在我来读取 `HEAD` 的拆分文件和 fixtures，以检查结构和共享状态。
# 复核报告：PR 317（CI 提速收尾）

## 读代码证实的结论（按严重度排列）

### 1.【低】作者材料把不属于本 PR diff 的文档改动列成了本次改动
- 文件：`docs/adr/0181-*` / `0189-*`（diff 中不存在）
- 问题：材料第 1 条说「把 ADR 0181 的编号冲突改为 ADR 0189（重命名并更新所有链接）」，但 `git diff 8b16d69..07d0bf7 --stat` 只含 4 个测试文件，没有任何 docs 改动。重命名在基准 8b16d69 上已经存在（main 的 020a31c 就完成了改名），分支上的 deedc73 是一次相同内容的独立改动，合并后是空操作。
- 证据：`git diff --stat` 仅列出 4 个 `test/tooling/` 文件；`git show 020a31c` 包含 `0181-drop-node-floor... => 0189-...` 的改名；`git log --all --find-renames -- docs/adr/0189-...` 命中 020a31c 和 deedc73 两条。
- 影响：最终树无问题（见第 4 条核对），但按材料去找 docs diff 会扑空，也说明作者对「本 PR 相对基准改了什么」的描述不准。
- 建议：材料改为「编号冲突已在 main 由 020a31c 修复；本分支 deedc73 与其重复，合并后无净改动」。

### 2.【低】merge 带入的密钥样例改写语义等价，确认无断言含义变化（核实项，非问题）
- 文件：`test/tooling/opencode-review-merge-gate.test.mjs:514`
- 证据：merge 3d97bbf 只给该文件带来 2 行变化：`const lone = \`[已遮盖:private-key-header] ${"说明".repeat(5000)}\`` → `` `${["-----BEGIN", "PRIVATE KEY-----"].join(" ")} ...` ``。两种写法求值结果逐字符相同（均为 `[已遮盖:private-key-header] `），目的只是避开仓库自身密钥扫描对测试源码的误报（`git log -S '"PRIVATE KEY-----"'` 命中 020a31c「清掉 main 上密钥扫描误报」）。
- 同时核实：`opencode-review.test.mjs` 的 diff 中，新增行只有共享 fixtures 的 import 块和一个 `describe("opencode review wrap-up")` 头，留下的测试正文没有任何修改；被移走的测试在 merge-gate 文件中逐字出现（抽查 low-fix、merge gate、spend guard 各段与基准文件一致）。

### 3.【观察】「两个 worker 均分耗时」无法从代码核实
- 机制成立：`ci/policy.json:193-197` 的 tooling project `fileParallelism: true`，把一个 2534 行的文件拆成两个即可让 Vitest 并行调度（拆之前单文件只能占一个 worker）。
- 未核实：merge-gate 文件（2317 行）保留了几乎所有 60 秒级的 `spawnSync` 慢用例（low-fix 退出码、report 脚本、proxy、rerun、wrap-up/owner-stop 全家桶），test.mjs 也留有真实自检和真实运行用例；是否真的「均分」取决于运行时，Hermes 上的实测数据我无法复核。

### 4.【观察】没有自动检查防止拆分丢测试；文档链接检查不覆盖 ADR
- 无测试数量基线或清单门禁：164 个用例的保全完全靠人工比对（我已静态核对，见必答问题 3）。
- `scripts/check-instruction-links.mjs:7-12` 只检查 AGENTS.md、CLAUDE.md、.claude/rules、.agents/instructions 四处；README 和 `docs/execution/specs/...md` 里的 ADR 链接坏了不会被门禁抓住，这次链接正确纯靠人工改对。

## 侧重检查

走的流程：`npm test`（package.json:73 → `scripts/ci/local.mjs --check coverage`）→ `vitest.workspace.ts:30-48` 读 `ci/policy.json` 组建 tooling project → `include: ["test/tooling/**/*.test.ts", "test/tooling/**/*.test.mjs"]`、`fileParallelism: true` → 拆出的 `opencode-review.test.mjs`（76 个 it）与 `opencode-review-merge-gate.test.mjs`（88 个 it）分到并行 worker，共同 import `opencode-review.fixtures.mjs`。

结论：
- 共享夹具无顺序依赖：fixtures 只有只读模块级值（`instructions`、`fakeOpenAiKey`），HTTP 桩、临时目录、env 修改都在每次调用内创建并在 `finally` 恢复（fixtures.mjs:124-156、186-252），两个测试文件之间不共享任何可变状态。
- 无覆盖的路径：fixtures 文件本身不匹配 `*.test.*`，不被任何 project 执行，其辅助函数只经使用方测试间接覆盖；`scripts/ci/test-concurrency.mjs` 没有同名测试文件（未核实是否被其他测试覆盖）；README/docs 的 ADR 链接无自动检查（见第 4 条）。
- 命名瑕疵：merge-gate 文件现在装着 wrap-up、credentials、masking、spending 等与合并门禁无关的内容，且三个文件里出现三个同名 `describe("opencode review wrap-up")`——不影响正确性，检索时会碍事。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？** 不会。diff 只含 `test/tooling/` 下 4 个文件，`scripts/model-review/opencode-review.mjs`（buildPrompt、遮盖、记录写入）零改动；测试搬移为纯移动（test.mjs 的 diff 新增行只有 import 和 describe 头），唯一的字符串级变化（第 2 条）求值结果逐字节相同。「仍只在末尾追加、每轮变的值都在最后一条消息」这条约束本次既未被触碰，也未失去其检查：对应反向用例（`packages/runtime-pi/test/prompt-prefix.compat.test.ts` 的 `[I-66]`，见 `.claude/rules/prompt-prefix.md:74`）原样保留。

**2. 会不会让同一段文字在不同请求里变成不同的字节？** 不会。改动没有触碰遮盖规则、时间字段或集合序列化的生产代码；`lone` 新旧写法求值相同。fixtures 无模块级可变状态，不会引入跨用例的不确定性。

**3. 有没有对应的自动检查、反向用例会不会真失败？** 分项：ADR 重号有 `check:adr-numbers` 门禁，`test/tooling/adr-numbers.test.mjs:29-41,55-62` 的反向用例（重号报 `ADR_NUMBER_DUPLICATE`、CLI exit 1）存在且断言具体，另有 `:80-82`「passes on this repository」在 HEAD 上必然通过（0181/0189 已分开）。测试拆分本身无自动检查（无数量基线）。review-delegate 身份修复的反向场景就是修复前的 CI 失败本身，我无法运行验证。gitleaks 白名单反向用例由 main 的 847a966 带入的 `test/tooling/gitleaks-config.test.mjs` 覆盖，未逐条核对其失败路径（未核实）。

**4. 每个产生/修改的值，两端都核对了吗？** 是：
- 新文件名 `opencode-review-merge-gate.test.mjs`：被 `ci/policy.json:194` 的 glob 命中（会执行）；
- `opencode-review.fixtures.mjs`：不匹配 `*.test.*`，不执行、不进覆盖率 include，与 CI 设计文档「测试夹具排除」（`docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:213`）一致；
- `git -c user.name=t -c user.email=t@t revert`（review-delegate.test.mjs:401）：`f.run` 直接 `execFileSync("git", args)`（:24-25），`git -c` 在子命令前合法，且与同文件既有模式一致——`commitAll` :357、改动前就存在的 merge 调用 :416-428 都用同一组身份参数，说明这确实是无全局身份 runner 上的遗漏补齐；
- ADR 0189：README:21,67 与 CI 设计文档 :57,119,201,213 共 6 处链接全部指向存在的 `docs/adr/0189-drop-node-floor-and-fold-test-into-coverage.md`（标题「ADR 0189」）；旧的「ADR 0181」引用（`docs/incidents-and-gates.md:124`）指向下载缓存 ADR，正确；全仓无残留的 `0181-drop-node-floor` 链接；
- 「164/164」：静态核对 test.mjs 76 个 it + merge-gate 88 个 it = 164，与基准文件用例集合一致、无丢失；但「0 失败 0 跳过」的运行结果未核实（本次会话不能执行测试）。
