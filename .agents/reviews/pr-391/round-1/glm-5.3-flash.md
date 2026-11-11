# 复核结论（PR 391，de952d3）

## 读代码证实的发现（按严重度从高到低）

**低｜test/tooling/ci-optimization.test.mjs:141-143｜反向用例只覆盖 actions 一项**
证据：反向用例只有 `text.replace("      actions: write\n", "      actions: read\n")` 这一种变体；`pull-requests`、`contents` 被降级、或 `full.permissions` 整个被删掉时，用例没有对应的反向断言（第一半的逐项比较会失败，但没有被"反向验证"这一步钉住）。
建议：可接受现状；若要更严，把反向用例改成参数化，逐项降级 granted 的每个 scope。

**低｜scripts/ci/main-workflow.mjs:32-36｜`full-permissions` 断言对键序敏感**
证据：`JSON.stringify(full.permissions)` 与字面量 `{ contents, actions, pull-requests }` 逐字节比较；把 main.yml:63-66 的三行换序（YAML 语义不变）会误报。这与同文件 12-16 行既有写法一致，且项目刻意逐字节钉死工作流，视为符合仓库风格，不算缺陷，仅记录。

**信息｜test/tooling/ci-optimization.test.mjs:127-138 不在本地 `npm run check` 里**
证据：package.json:27 的 `check:steps` 不含 tooling 项目；`[I-93]` 第一半（ci.yml 申请新增更高权限而 main.yml 未跟上）只在 CI policy 作业（ci/policy.json:19 `"projects": ["tooling"]`，包含 `test/tooling/**/*.test.mjs`，vitest.workspace.ts 亦确认）和 `npm test` 里跑。但 main.yml 侧的回归在本地必被拦：check-policy.mjs:1284 调 `validateMainWorkflow`，属于 `check:ci-policy` ⊂ `npm run check`，main-workflow.mjs:32-36 会抛 `full-permissions`。合并不等 CI（项目规则），所以"ci.yml 加权限、main.yml 没跟上"这类回归要等 PR 的 policy 作业才红，本地快速检查拦不住。

**未核实**：GitHub 对 workflow_call 权限继承的确切行为（"被调用方不得超过调用方"）无法在本仓库内验证，只能核对本仓库两端声明自洽（见下）；`scripts/ci/delete-run-reports.mjs` 实际删除产物的 API 用法是否有测试未核实（不在本次改动范围内）。

## 作者三条说法逐条核对

1. **最小性——证实**。ci.yml 请求的最高集恰好是 required 作业的 `contents: read, actions: write, pull-requests: read`（ci.yml:383-386），顶层只多申请 `pull-requests: read`（ci.yml:21-23）；main.yml full 授予的正是这三项（main.yml:63-66），没有多余。main.yml 工作流级仍是 `actions: read`（main.yml:7，且被 main-workflow.mjs:12-16 钉死），plan/confirm 无作业级权限（main-workflow.mjs:57 断言），拿不到写权限。
2. **能拦同类回归——证实，带上面两条低级保留**。ci.yml 任何作业或顶层新增 scope 而 granted 缺失时，`rank[granted[scope] ?? "none"] < rank[level]` 会失败（ci-optimization.test.mjs:131-138）；granted 取 `full.permissions ?? main.permissions` 与 GitHub 的"作业级权限替换工作流级"语义一致。
3. **不影响 PR 的 ci.yml——证实**。diff 只改了 main.yml、main-workflow.mjs、ci-optimization.test.mjs、docs/incidents-and-gates.md 四个文件；ci.yml 的 pull_request 路径一字未动。
4. 文档 I-93 行（docs/incidents-and-gates.md:127）描述与代码一致：旧断言确实是 `!full.permissions`（diff 可见），事故行引用的两个路径都存在，`check:incident-gates` 的 7 列格式满足。

## 侧重检查

走了一条最普通流程：合并进 main → push 触发 main.yml → plan 作业（工作流级只读，`validateMainWorkflow` 断言结构、步骤、锁定的 action SHA，main-workflow.mjs:47-102）→ plan 选 light 走 confirm（同样只读）；plan 失败或非 light 走 full → 以作业级权限调用 ci.yml → required 作业汇总后删报告产物。静态结构两端都有门槛（`check:ci-policy` 本地 + tooling 测试在 CI policy 作业）；唯独"GitHub 运行时是否接受这组权限"没有也不可能本地覆盖——这正是 I-93 事故的根因，本次改动把两端声明钉成一致并互相校验，属合理补救。测试覆盖了本次改动（新增用例 + 校验器断言，均有反向用例）；文档与代码一致。

## 必答问题

1. **不适用/无影响**。diff 只动 CI 工作流 YAML、其校验脚本、测试和文档，不触及发给模型的任何内容（系统提示、工具定义、历史、遮盖），无追加与否的问题。
2. **不会**。没有带时间的字段、无序列化或依赖前后文的遮盖；`JSON.stringify` 比较的是解析后的 YAML，键序来自仓库内固定文件，跨请求无变化。
3. **有，且反向用例会失败**。两层：`full-permissions` 断言（读代码推演：replace 后 full 的 permissions 为 `{contents: read, actions: read, pull-requests: read}`，与 32-36 行字面量不等，抛 `MAIN_WORKFLOW:full-permissions`，`toThrow` 匹配）；以及第一半的逐项比较（granted 降为 read 后 rank 1 < 2）。反向用例真的会失败。
4. **逐项核对均通过**。① full.permissions：产生于 main.yml:63-66，消费方 GitHub 运行时、validateMainWorkflow:32-36（精确相等）、[I-93] 测试（≥ 比较与 ci.yml:21-23、383-386 对齐）；② 错误码 `full-permissions`：产生于 main-workflow.mjs:35，消费于测试 ：143；③ I-93 文档行：产生于 docs/incidents-and-gates.md:127，消费于 `check:incident-gates`（路径存在、7 列齐）。没有发现任何一端校验不匹配。
