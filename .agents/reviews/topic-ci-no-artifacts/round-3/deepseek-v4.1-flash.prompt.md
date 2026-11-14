你是方案里“关于代码和文档现状的说法”的核对者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
下面是一份还没合并的方案或 ADR。第一步，把其中每一句讲代码或仓库文档现状的话都列出来：某个文件、函数、字段、配置、命令、数字、规则现在是什么样、做什么、不做什么；一句话里有几个说法就拆成几条。方案打算新增或修改什么，不算现状；讲外部网站、第三方产品的话也不算。第二步，逐条自己打开对应的文件核对，给出：一致、不一致、找不到（仓库里没有这个东西，或没读到能证明它的内容）。材料里的说法可能有错，写得再肯定也不能因此判一致；没有亲自读到对应代码，就判找不到。只核对事实，不评价方案好不好，不提建议。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
输出格式：每个说法单独一行，不换行，字段之间用竖线分隔，行首写 CLAIM：
CLAIM|<序号>|<一致 或 不一致 或 找不到>|<文件:行>|<方案原句>|<代码原文>
序号用 1、2、3……，不重复。文件:行 写你读到证据的那个文件和行号，例如 packages/x/src/y.ts:42；找不到时写 -。代码原文必须是你亲自读到的、逐字摘抄的一行或几行，不要改写、不要概括；方案原句里的竖线字符换成全角的“｜”，代码原文里的竖线照原样写。列完所有 CLAIM 行之后，另起一段，用一两句话写你没能核对的部分。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 ccbe4e01d48aedb3861ceefa85eeaa02130c065d。
待核对的方案：
方案文件：docs/adr/0243-ci-uses-no-github-artifacts.md（在提交 ccbe4e01d48aedb3861ceefa85eeaa02130c065d 里的内容）

---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: "docs/adr/0238-ci-job-files-stay-on-the-ci-vps.md, docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md, docs/adr/0174-no-github-cache-and-one-day-artifacts.md"
date: "2026-11-12"
---

# ADR 0243：CI 完全不用 GitHub 产物

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [Andy 的原话](#owner-decisions)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

GitHub 产物（artifact，工作流上传到 GitHub、之后可下载的文件）原先有三种用途：

- `ci/required` 上传汇总结论 `gate-`，main 合并后的轻量确认（`main.yml` 里的 `scripts/ci/main-evidence.mjs`）下载它，判断这次合并能不能只做轻量确认；
- 每个检查作业上传失败诊断 `diagnostic-`，保留 1 天；
- `main.yml` 的路径选择作业把证据交给确认作业，确认作业上传 `main-confirmation-` 报告；`quality.yml` 上传检测结果，`handoff` 作业下载 `report-` 和 `gate-` 产物。

2026-11-11 起所有运行都在上传步骤失败，`ci/required` 全红（[I-94](../incidents-and-gates.md#incidents)）。前提和来源：

1. 免费账号的产物和 Packages 共用 500 MB 额度，按小时累计到整个账单周期；没有付款方式时，额度用完就被拦。来源 <https://docs.github.com/en/billing/concepts/product-billing/github-actions>，原话：“Storage charges accrue every hour based on your actual usage throughout the month”，“usage is blocked once you use up your quota”。2026-11-12 07:13 JST 删掉旧产物 9 小时后仍被拒。
2. 日志算不算存储，两份官方材料说法相反。计费页说日志和作业摘要“do not count towards the repository owner's artifact storage allowance”；2026-08-27 的 GitHub Changelog 说“Artifacts and logs count toward your billable GitHub Actions storage”。本决定按较严的说法处理：日志尽量少写，保留期尽量短。
3. Andy 定的长期规则是绝不在 GitHub 上花钱，不开付费、不设预算（项目记忆，Andy 2026-11-11 原话见下一节）。
4. 轻量确认能信任汇总结论，靠的是逐项核对它的内容（运行号、尝试号、被测提交、源码树、策略和工具链摘要、每个检查都通过），而不是它存在哪里：`scripts/ci/main-evidence.mjs` 的 `verifyGate`。
5. [ADR 0238](0238-ci-job-files-stay-on-the-ci-vps.md) 已经把作业之间的报告和构建放在 CI 服务器的共享目录 `/srv/gh-runner-share`，汇总作业结束时整目录删除，每小时的清理删掉 6 小时前的残留；所以共享目录不适合放要在合并后才读的东西。
6. GitHub 提供下载单个作业日志的接口：`GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs`，返回一个短期有效的跳转地址（<https://docs.github.com/en/rest/actions/workflow-jobs#download-job-logs-for-a-workflow-run>），需要 `actions: read`，`main.yml` 本来就有这个权限。日志每行开头带 UTC 时间戳。

<a id="owner-decisions"></a>

## Andy 的原话

- 2026-11-11：“绝不在 GitHub 上花钱”。
- 2026-11-11 在决定卡片上选了“彻底不用 GitHub 产物”。
- 2026-11-12 回复“同意方案、8 条例外的卡片”，同意了本方案，包括截图和 trace 不再能从网页下载、仓库设置里的保留期从 90 天改成 3 天（他已在 Settings → Actions → General 改好并刷新确认）。

<a id="decision"></a>

## 决定

1. **汇总结论写进 `ci/required` 的步骤日志。**`scripts/ci/required.mjs` 照旧把 `context.json`、`needs.json`、`summary.json` 写进 `.ci-output/gate/`，再把 `{context, summary}` 里每个字符串先遮盖像密钥的内容（`scripts/ci/redact-text.mjs`），整份 JSON 按 base64 编码、每行 1000 个字符打印出来，前面一行是 `HIMAWARI_GATE_BEGIN v1 <SHA-256>`，后面一行是 `HIMAWARI_GATE_END`（`scripts/ci/gate-log.mjs`）。汇总结论只有几 KB，上限 256 KiB。它同时把每个检查的结果和失败原因（同样先遮盖）写成一张表，放进作业摘要（job summary，GitHub 运行页面上每个作业下方显示的一段 Markdown）。
2. **main 从日志取回汇总结论。**`main-evidence.mjs discover` 找到合并 PR 最新的成功运行后，列出那一次尝试的作业，要求名字是 `ci/required` 的作业恰好一个，再要求这个作业结论为成功、运行号和尝试号都对得上，下载它的日志，去掉每行的时间戳，要求恰好一段开始和结束标记、内容是合法 base64、SHA-256 相符、解出的 JSON 恰好有 `context` 和 `summary` 两个键，再写成 `.ci-output/main-evidence/gate/` 下的两个文件，由原来的 `verifyGate` 逐项核对。下载日志时只对 `api.github.com` 带令牌，跟随一次 HTTPS 跳转且不把令牌带到跳转地址。任何一步不符都退回完整 CI，不会把没验证的提交当成通过。
3. **确认作业自己重新取证据。**`main.yml` 的路径选择作业不再上传证据，确认作业在运行 `main-confirm.mjs` 之前自己再跑一次 `main-evidence.mjs discover`，`main-confirm.mjs` 照旧用同一套 `verifyGate` 核对确认作业自己取到的这一份，不和路径选择作业的结果比较；这一份核对不过（例如 PR 运行刚好超过 24 小时，或日志已被删除）时确认失败。重新取证据那一步本身不报错，失败在随后的确认步骤报出 `MAIN_EVIDENCE_NO_LONGER_VALID`。路径选择和确认报告都写进作业摘要。
4. **诊断只写进作业摘要。**每个检查作业在公开白名单核验通过后运行 `scripts/ci/ci-summary.mjs`，把 `.ci-output/public/diagnostics/` 写进作业摘要：文件按路径排序；文本文件先整体遮盖像密钥的内容（`scripts/ci/redact-text.mjs`），再只显示最后 40 行，每行最多 500 个字符；截图、trace 这类二进制文件只列名字和字节数；每段摘要总量不超过 64 KiB，放不下的文件只报数量。`quality.yml` 的检测结果和诊断同样写进作业摘要。文本文件只读末尾 256 KiB：读不出来、读到的字节数不对、读到的部分含 NUL 字节，或文件被截断后读到的部分找不到换行，都按二进制只列名字和大小；遮盖之后仍留有私钥的开始或结束标记（例如截断切开了一段私钥，或遮盖规则不认的 SSH2、PGP 私钥）时，整份文件也不显示；控制字符换成 `?`。`ci.yml` 的完整报告仍在 CI 服务器的共享目录里，汇总作业结束时删除（[ADR 0238](0238-ci-job-files-stay-on-the-ci-vps.md)）；`quality.yml` 不用共享目录，完整报告随作业结束丢弃。
5. **删掉 `quality.yml` 的 `handoff` 作业和它的 `ci_run_id` 输入。**它要下载的 `report-` 产物在 ADR 0238 之后已经不存在，这个作业不可能成功。`scripts/ci/export-evidence.mjs` 保留，仍可对手头的报告和汇总结论运行。
6. **硬规则。**`scripts/ci/check-policy.mjs` 拒绝 `ci.yml` 任何作业用 `actions/upload-artifact` 或 `actions/download-artifact`（这条检查排在“action 必须在工具链锁里”之前，所以即使有人把它们加回锁里也会被拦下），要求每个检查作业恰好一个写诊断摘要的步骤、汇总作业有打印汇总结论的那一步；`scripts/ci/main-workflow.mjs` 对 `main.yml` 同样拒绝，并要求确认作业先重新取证据再确认、两个作业最后一步写作业摘要；`scripts/ci/quality-policy.mjs` 逐字比对 `quality.yml`。两个 action 从 `ci/toolchain-lock.json` 和 `scripts/ci/install-tools.mjs` 的固定清单里删除。
7. **保留期。**仓库设置 “Artifact and log retention” 改为 3 天（Andy 已改），日志和运行记录 3 天后删除。轻量确认只认 24 小时内完成的 PR 运行，3 天足够。`ci/policy.json` 和 `ci/quality-policy.json` 里的 `retentionDays` 字段暂时保留：前者在旧 main 的策略迁移里还要用，后者是 `export-evidence.mjs` 判断证据是否过期的依据；以后另行清理。

这修改了 [ADR 0238](0238-ci-job-files-stay-on-the-ci-vps.md) 决定第 3、4 条（GitHub 上不再留 `gate-` 和 `diagnostic-`，`main.yml` 不再用 `actions/download-artifact`）、[ADR 0241](0241-draft-prs-skip-ci-and-merge-waits-for-green.md) 决定第 2、6 条里“上传汇总结论”的步骤（现在没有上传，入口检查失败时不打印汇总结论），以及 [ADR 0174](0174-no-github-cache-and-one-day-artifacts.md) 里“产物保存 1 天”的做法（现在不产生产物）。

<a id="options"></a>

## 比较过的方案

方案先由两个模型各自独立给出，再由 DeepSeek 审核整合方案（记录在 `.agents/reviews/topic-ci-no-artifacts/`，共 0.36 美元）。

- **汇总结论放在 CI 服务器上另建的目录，保留 7 天**（GLM 的方案，线程最初的整合版）：放弃。DeepSeek 审核时指出：两个 runner 共用这个目录，别的 PR 的运行能删改本轮的汇总结论；要先改安装脚本、Andy 重装 runner 之后才能切换，顺序错了所有 PR 都会变红；汇总作业结束会删目录，诊断也不能事后去服务器取。
- **汇总结论写进日志**（DeepSeek 的方案）：采用。汇总结论和那一次运行绑在一起，事后谁都改不了；不改 CI 服务器，不用重装 runner；读取用的是现有的 `actions: read` 权限。
- **用提交状态或检查运行的说明文字存汇总结论**：放弃。写入要 `statuses: write` 或 `checks: write`，而 ADR 0238 定了任何作业都不带写权限。
- **开 GitHub 付费存储或设预算**：放弃，违反 Andy 的长期规则。

<a id="consequences"></a>

## 后果

- 产物额度不再被 CI 占用；额度恢复与否都不影响 CI。本月已经算进额度的用量要到下个账单周期才清零，但 CI 已不再上传，所以不受影响。
- 截图、trace、完整日志这类大文件不能再从 GitHub 网页下载。要看完整材料，需要在 CI 服务器上重跑，或在本地按同样的命令运行。
- 日志的计费说法不明（前提 2），汇总结论只有几 KB，诊断摘要不超过 64 KiB，保留 3 天，量很小。
- 这个 PR 合进 main 的那一次推送改了 `.github/`、`ci/`、`scripts/ci/`，按规则走完整 CI；之后的合并都按新做法读日志。
- 旧的 PR 运行（本 PR 合并之前开始的）日志里没有汇总结论，main 会对它们退回完整 CI。

<a id="references"></a>

## 关联文档

- [ADR 0238：作业之间的文件放在 CI 服务器](0238-ci-job-files-stay-on-the-ci-vps.md)
- [ADR 0241：草稿 PR 不跑 CI，合并前等 CI 变绿](0241-draft-prs-skip-ci-and-merge-waits-for-green.md)
- [ADR 0174：不用 GitHub 缓存](0174-no-github-cache-and-one-day-artifacts.md)
- [GitHub CI 与质量门禁设计](../execution/specs/2026-09-03-github-ci-quality-gates-design.md)
- [事故与门槛清单](../incidents-and-gates.md#incidents)

[↑ 返回阅读导航](#contents)
