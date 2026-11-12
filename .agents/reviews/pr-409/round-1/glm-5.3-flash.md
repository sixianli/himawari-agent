现在我来读取策略脚本、contracts 和共享/证据脚本。
# 复核报告：PR 409 第 1 轮（草稿 PR 跳过 CI、合并等 CI 变绿）

## 侧重检查（先走的流程与结论）

我沿一条最普通的使用流程走了一遍，并核对了每一段代码：

**流程 A：往草稿 PR 推一个提交**
1. GitHub 触发 `ci.yml`（`opened`/`synchronize` 在保留的事件类型里，ci.yml:3-8）。
2. 6 个检查作业的 `if`（ci.yml:32/76/124/179/255/308）在草稿上求值为 false → 全部跳过。仓库内只能做文本级验证：`test/tooling/ci-optimization.test.mjs:239-240` 断言真实 ci.yml 里每个非 required 作业的 `if` 逐字等于草稿条件；运行时语义（GitHub 对跳过作业的 `needs.*.result` 取值）仓库内不可测——**未覆盖**。
3. `required` 带 `if: always()`（ci.yml:356）照常启动，第一步 `entry`（ci.yml:372-379）在检出、装工具之前，用 `CI_DRAFT`/`CI_CANCELLED` 两个环境变量判失败。这段 bash 被 `ci-optimization.test.mjs:230-253` 用 5 组取值（含空串/缺失）真实执行过，覆盖比预期好。
4. 入口失败 → gate 上传（ci.yml:400）和共享目录删除（ci.yml:408）被 `always() && steps.entry.outcome == 'success'` 跳过。真实 ci.yml 的这条规则由 `check-policy.mjs main()`（run.mjs:235-237 调起，check-policy.mjs:1352-1353 读真实文件校验）在本地 policy 检查和 CI `policy` 作业里强制。
5. 草稿运行**根本不会创建**共享目录（上游作业全跳过，`required` 自身从不 `put`，run-share.mjs 里只有 put/get/collect/remove），所以「入口失败不删目录」对草稿无残留后果；真正会留目录的是**非草稿但被取消**的运行——上游作业可能已经 put 过。
6. 残留靠每小时清理：`clean-old.sh:24-26` 删共享根下超过 `RUNNER_SHARE_KEEP_MINUTES` 的运行目录，`runners.sh:7` 定为 360 分钟，`gh-runner-clean.timer:5` `OnCalendar=hourly`。**读代码证实**：ADR 0241 里「6 小时后删掉」与代码一致。

**流程 B：main 合并后的轻量确认**（main.yml:31-51 → main-evidence.mjs）
- `discoverEvidence` 只接受 `status=success && conclusion==success` 的 PR 运行（main-evidence.mjs:96、103）并要求对应 `gate-` 产物存在（:116-122）；入口失败的运行没有 gate 产物、结论是 failure，永远不会被当成证据——ADR 0241 第 54 行这句「只认结论为成功的 PR 运行」**读代码证实**。入口失败只会让 main 走 full 路径（main.yml:63），不出问题。
- run 目录名是 `runId-attempt`（run-share.mjs:34-38），重跑整轮换 attempt，不会撞上未清理的残留目录。

---

## 发现的问题（按严重度从高到低）

### 1. 中低 · scripts/ci/check-policy.mjs:525-530
**问题**：「gate 只能在入口检查通过后上传」这条硬规则只约束 `actions/upload-artifact` 步骤；`required` 作业里其他带 `if: always()` 的新步骤（不涉及产物上传的）将来加进去，也能在入口失败后照跑，policy 不会拦。
**证据**：check-policy.mjs:526-528 `job.steps.filter((step) => /^actions\/upload-artifact@/u.test(step.uses ?? "")).every(...)`；ci-optimization.test.mjs:220-224 也只查 permissions 和 download-artifact。
**建议**：把规则改成「required 里凡带 `if` 的步骤必须正好是 `REQUIRED_AFTER_ENTRY`，且禁止裸 `always()` 步骤」。这是健壮性缺口，不是现行 bug。

### 2. 低 · docs/adr/0238-ci-job-files-stay-on-the-ci-vps.md:34
**问题**：背景一节用现在时写「草稿 PR 不跑 browser、coverage，汇总永远不通过」，本次改动后草稿是全部跳过（不再只跳 browser/coverage），这句不再描述现状。
**证据**：0238 第 34 行原文与 ci.yml:32/76/124/179/255/308（全部 6 个作业带条件）对照。
**建议**：改成过去时（「在 ADR 0191 下草稿不跑 browser、coverage」）或加一句指向 ADR 0241。

### 3. 低（推测/未核实，属 GitHub 运行时语义） · .github/workflows/ci.yml:356,376
**问题**：ADR 0241 和提交标题声称「被取消的运行几秒内判失败（CI_UPSTREAM_CANCELLED）」，前提是整轮被取消时带 `if: always()` 的 `required` 仍会被启动。`always()` 覆盖的是「上游失败/跳过导致的连锁跳过」；整轮取消时排队中的 `always()` 作业是否启动，GitHub 文档口径我无法在仓库内核实。
**证据**：ci.yml:356 `if: always()`、ci.yml:376 `contains(needs.*.result, 'cancelled')`；仓库内没有对该运行时行为的测试。
**建议**：不影响安全性——两种结果（failure 或 cancelled）都不是 success，`main-evidence.mjs:103` 只认 success，合并都会被挡；但建议在 ADR 里把「几秒内失败」改述为「要么快速失败要么整轮标记取消，都不是成功」，避免把不可证实的承诺写成决定。

### 4. 低（测试环境差异） · test/tooling/ci-optimization.test.mjs:230-234
**问题**：入口 bash 用 `bash -e -c` 执行，而 runner 默认 shell 是 `bash --noprofile --norc -e -o pipefail`。对本段脚本（无管道）无差异，但若日后入口脚本加了管道，`-o pipefail` 差异会漏测。
**建议**：测试改用 `["-e", "-o", "pipefail", "-c", ...]`，一行改动。

### 5. 信息（核对无误，非问题）
- 作者清单第 4 点：去掉 `edited` 后，全仓库已无 `github.event.action` 消费者（grep 无结果）；剩余 `edited` 命中只有无关的 `editedPayloadRef`（上线包探针）和已同步更新的两个测试。`main-evidence`、`aggregate` 均不依赖该事件。**读代码证实**。
- 新值逐个核对：`CI_DRAFT_UNVERIFIED`/`CI_UPSTREAM_CANCELLED`（产生于 ci.yml:378-379 与 check-policy.mjs:32-33，消费方只有测试 ci-optimization.test.mjs:243-246 和文档，无机器解析方）；`steps.entry` 引用（同一文件内两处 `if`，被 check-policy.mjs:517/528/542 锁定）；`DRAFT_SKIP_CONDITION`/`REQUIRED_*` 导出（仅测试导入）；并发组格式与 policy 的四段要求逐段一致（ci.yml:24 ↔ check-policy.mjs:393-403）。两端校验齐备。
- 合并规矩文字（delivery-mode.md:27、AGENTS.md:7、ADR 0241）相互一致，也和 `model-review.md:46`（规则集才是机械强制）不冲突；`github-ruleset.sh:28-31` 的 `ci/required` 状态检查在草稿上表现为失败（不是跳过显示成功），ruleset 开启时草稿本来也合不了，口径自洽。

---

## 必答问题逐条回答

**1. 会不会改变模型已经见过的请求开头？** 不会。改动只涉及 CI 工作流、CI 脚本、CI 测试和文档，未触碰提示组装、遮盖、工具定义或历史写入（对照 prompt-prefix.md 的约束范围）。改动文档（ADR、delivery-mode.md、AGENTS.md）是线程按需读取的文件，其读取结果作为工具结果**追加**到请求，且提示词文字改动按规则只对新对话生效，不违反「只追加」。每轮会变的值没有被放进任何固定位置。

**2. 会不会让同一段文字在不同请求里变成不同字节？** 不会。没有引入依赖前后文的遮盖、时间字段或无序集合；所有新值（条件表达式、入口脚本、错误码）都是字面常量并被 check-policy 和测试逐字锁定。并发组反而**删掉**了一个按 `event.action` 变化的段（ci.yml:24），确定性增强。

**3. 有没有对应的自动检查，反向用例是否真的会失败？** 有，且覆盖真实文件。`check-policy.mjs main()`（由 `npm run check` 的 policy 步和 CI `policy` 作业运行，run.mjs:235-237）直接校验真实 ci.yml 与 main.yml。反向用例逐条核对过失败路径：`policy.test.mjs:449-554` 的每个变异都会触发对应 assert（如「entry 排到 checkout 后」命中 check-policy.mjs:517-524，「忽略取消」命中 ：521 的 env 逐字比较，「失败后仍删目录」命中 ：542）；`ci-optimization.test.mjs:242-253` 对真实入口 bash 跑 5 组环境变量取值（含空串）。缺口在 GitHub 运行时语义（见问题 3、侧重检查第 2 步），仓库内不可测。

**4. 产生的/修改的每个值，两端校验都核对了吗？** 核对了（详见问题清单第 5 条「信息」）：草稿条件、入口步骤 id、两个错误码、导出常量、并发组、事件类型集合——每个值都找到了产生处和全部使用处，无孤儿、无校验缺口；唯一缺口是第 1 条问题里 policy 对 required 中非上传步骤的条件约束偏窄（将来才可能被踩到）。

**读代码证实 vs 推测**：凡引用了行号的结论均为亲自读到；第 3 条问题（整轮取消时 `always()` 作业是否启动）和流程 A 第 2 步的运行时语义标注为未核实/推测。
