CLAIM|1|一致|scripts/ci/main-evidence.mjs:202|轻量确认能信任汇总结论，靠的是逐项核对它的内容（运行号、尝试号、被测提交、源码树、策略和工具链摘要、每个检查都通过）|assert(positive(candidate.runId) && positive(candidate.attempt), "MAIN_RUN_ID");
CLAIM|2|一致|scripts/ci/main-evidence.mjs:235|逐项核对被测提交|testedCommit.sha === context.testedSha &&
CLAIM|3|一致|scripts/ci/main-evidence.mjs:236|逐项核对源码树|testedCommit.tree?.sha === identity.tree &&
CLAIM|4|一致|scripts/ci/main-evidence.mjs:217|逐项核对策略和工具链摘要|assert(context.policySha256 === hash(policy.bytes), "MAIN_POLICY_MISMATCH");
CLAIM|5|一致|scripts/ci/main-evidence.mjs:218|逐项核对策略和工具链摘要|assert(context.toolchainSha256 === hash(toolchainBytes), "MAIN_TOOLCHAIN_MISMATCH");
CLAIM|6|一致|scripts/ci/main-evidence.mjs:231|逐项核对每个检查都通过|summary.checks.every((c) => c.status === "passed" && same(c.reasons, [])),
CLAIM|7|一致|docs/adr/0238-ci-job-files-stay-on-the-ci-vps.md:58|ADR 0238 已经把作业之间的报告和构建放在 CI 服务器的共享目录 `/srv/gh-runner-share`|1. **作业之间的文件放在 CI VPS 的共享目录 `/srv/gh-runner-share`。**
CLAIM|8|一致|docs/adr/0238-ci-job-files-stay-on-the-ci-vps.md:62|汇总作业结束时整目录删除|- `remove`：汇总作业最后一步，`if: always()`，不论成败都删掉本次运行的目录。
CLAIM|9|一致|scripts/operations/ci-runner/gh-runner-clean.timer:5|每小时的清理删掉 6 小时前的残留|OnCalendar=hourly
CLAIM|10|一致|scripts/operations/ci-runner/runners.sh:7|每小时的清理删掉 6 小时前的残留|RUNNER_SHARE_KEEP_MINUTES=360
CLAIM|11|一致|.github/workflows/main.yml:7|main.yml 本来就有这个权限（actions: read）|  actions: read
CLAIM|12|一致|scripts/ci/required.mjs:31|scripts/ci/required.mjs 照旧把 context.json、needs.json、summary.json 写进 .ci-output/gate/|for (const [name, value] of Object.entries({ context, needs, summary })) {
CLAIM|13|一致|scripts/ci/required.mjs:43|把 {context, summary} 里每个字符串先遮盖像密钥的内容（scripts/ci/redact-text.mjs）|JSON.stringify(gate, (_key, value) => (typeof value === "string" ? redactText(value) : value)),
CLAIM|14|一致|scripts/ci/gate-log.mjs:6|整份 JSON 按 base64 编码、每行 1000 个字符|const CHUNK = 1000;
CLAIM|15|一致|scripts/ci/gate-log.mjs:21|前面一行是 HIMAWARI_GATE_BEGIN v1 <SHA-256>，后面一行是 HIMAWARI_GATE_END|return [`${GATE_BEGIN} ${sha256(bytes)}`, ...lines, GATE_END, ""].join("\n");
CLAIM|16|一致|scripts/ci/gate-log.mjs:5|汇总结论只有几 KB，上限 256 KiB|export const GATE_LIMIT_BYTES = 256 * 1024;
CLAIM|17|一致|scripts/ci/required.mjs:46|它同时把每个检查的结果和失败原因（同样先遮盖）写成一张表，放进作业摘要|export function gateSummaryMarkdown(summary) {
CLAIM|18|一致|scripts/ci/main-evidence.mjs:143|main-evidence.mjs discover 找到合并 PR 最新的成功运行|`/repos/${repository}/actions/workflows/ci.yml/runs?event=pull_request&status=success&head_sha=${identity.head}&per_page=100`,
CLAIM|19|一致|scripts/ci/main-evidence.mjs:162|列出那一次尝试的作业，要求名字是 ci/required 的作业恰好一个|const gates = jobs.jobs.filter((job) => job.name === "ci/required");
CLAIM|20|一致|scripts/ci/main-evidence.mjs:166|要求这个作业结论为成功、运行号和尝试号都对得上|gates[0].run_id === run.id &&
CLAIM|21|一致|scripts/ci/gate-log.mjs:29|下载它的日志，去掉每行的时间戳|.map((line) => line.replace(TIMESTAMP, ""));
CLAIM|22|一致|scripts/ci/gate-log.mjs:32|要求恰好一段开始和结束标记|assert(begins.length === 1 && ends.length === 1 && ends[0] > begins[0], "MAIN_GATE_LOG_MISSING");
CLAIM|23|一致|scripts/ci/gate-log.mjs:37|内容是合法 base64|body.length > 0 && body.every((line) => /^[A-Za-z0-9+/]+={0,2}$/u.test(line)),
CLAIM|24|一致|scripts/ci/gate-log.mjs:45|SHA-256 相符|assert(sha256(bytes) === digest, "MAIN_GATE_LOG_DIGEST");
CLAIM|25|一致|scripts/ci/gate-log.mjs:56|解出的 JSON 恰好有 context 和 summary 两个键|Object.keys(value).sort().join(",") === "context,summary" &&
CLAIM|26|一致|scripts/ci/main-evidence.mjs:258|再写成 .ci-output/main-evidence/gate/ 下的两个文件|writeFileSync(path.join(directory, "gate/context.json"), JSON.stringify(gate.context));
CLAIM|27|一致|scripts/ci/main-evidence.mjs:270|由原来的 verifyGate 逐项核对|result = verifyGate({
CLAIM|28|一致|scripts/ci/main-evidence.mjs:57|下载日志时只对 api.github.com 带令牌|...(token ? { Authorization: `Bearer ${token}` } : {}),
CLAIM|29|一致|scripts/ci/main-evidence.mjs:74|跟随一次 HTTPS 跳转且不把令牌带到跳转地址|response = await fetcher(target.href, {
CLAIM|30|一致|scripts/ci/main-evidence.mjs:252|任何一步不符都退回完整 CI，不会把没验证的提交当成通过|let result = { mode: "full", reason: "evidence-unavailable" };
CLAIM|31|一致|.github/workflows/main.yml:71|确认作业在运行 main-confirm.mjs 之前自己再跑一次 main-evidence.mjs discover|run: node scripts/ci/main-evidence.mjs discover
CLAIM|32|一致|scripts/ci/main-confirm.mjs:33|main-confirm.mjs 照旧用同一套 verifyGate 核对确认作业自己取到的这一份|const decision = await verifyMainEvidence(["verify"], { root });
CLAIM|33|一致|scripts/ci/main-confirm.mjs:34|这一份核对不过时确认失败|if (decision.mode !== "light") throw new Error("MAIN_EVIDENCE_NO_LONGER_VALID");
CLAIM|34|一致|scripts/ci/main-evidence.mjs:279|重新取证据那一步本身不报错|} catch (error) {
CLAIM|35|一致|scripts/ci/main-confirm.mjs:34|失败在随后的确认步骤报出 MAIN_EVIDENCE_NO_LONGER_VALID|if (decision.mode !== "light") throw new Error("MAIN_EVIDENCE_NO_LONGER_VALID");
CLAIM|36|一致|.github/workflows/main.yml:43|路径选择和确认报告都写进作业摘要|run: node scripts/ci/ci-summary.mjs --title "main 路径选择" --from .ci-output/main-evidence
CLAIM|37|一致|.github/workflows/ci.yml:68|每个检查作业在公开白名单核验通过后运行 scripts/ci/ci-summary.mjs，把 .ci-output/public/diagnostics/ 写进作业摘要|run: .ci-output/tools/bin/node scripts/ci/ci-summary.mjs --title "policy/$CI_MATRIX 失败诊断" --from .ci-output/public/diagnostics
CLAIM|38|一致|scripts/ci/ci-summary.mjs:36|文件按路径排序|return files.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
CLAIM|39|一致|scripts/ci/ci-summary.mjs:15|文本文件先整体遮盖像密钥的内容，再只显示最后 40 行，每行最多 500 个字符|export const TAIL_LINES = 40;
CLAIM|40|一致|scripts/ci/ci-summary.mjs:16|文本文件先整体遮盖像密钥的内容，再只显示最后 40 行，每行最多 500 个字符|export const LINE_CHARACTERS = 500;
CLAIM|41|一致|scripts/ci/ci-summary.mjs:102|截图、trace 这类二进制文件只列名字和字节数|? `- \`${name}\`：二进制文件，${file.size} 字节，内容不显示\n\n`
CLAIM|42|一致|scripts/ci/ci-summary.mjs:14|每段摘要总量不超过 64 KiB|export const SUMMARY_LIMIT_BYTES = 64 * 1024;
CLAIM|43|一致|scripts/ci/ci-summary.mjs:105|放不下的文件只报数量|const footer = `其余 ${files.length - shown} 个文件超出 ${limit} 字节的摘要上限，没有显示。\n`;
CLAIM|44|一致|.github/workflows/quality.yml:46|quality.yml 的检测结果和诊断同样写进作业摘要|run: .ci-output/tools/bin/node scripts/ci/ci-summary.mjs --title "scale 检测结果" --from .ci-output/public/reports
CLAIM|45|一致|scripts/ci/ci-summary.mjs:17|文本文件只读末尾 256 KiB|export const READ_LIMIT_BYTES = 256 * 1024;
CLAIM|46|一致|scripts/ci/ci-summary.mjs:58|读不出来、读到的字节数不对、读到的部分含 NUL 字节，或文件被截断后读到的部分找不到换行，都按二进制只列名字和大小|if (bytes === null || bytes.includes(0)) return null;
CLAIM|47|一致|scripts/ci/ci-summary.mjs:61|文件被截断后读到的部分找不到换行，按二进制只列名字和大小|if (newline < 0) return null;
CLAIM|48|一致|scripts/ci/ci-summary.mjs:71|遮盖之后仍留有私钥的开始或结束标记时，整份文件也不显示|if (/-----(?:BEGIN|END) [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/u.test(redacted)) return null;
CLAIM|49|一致|scripts/ci/ci-summary.mjs:75|控制字符换成 ?|.replace(/[^\P{Cc}\n\t]/gu, "?")
CLAIM|50|一致|.github/workflows/ci.yml:370|ci.yml 的完整报告仍在 CI 服务器的共享目录里，汇总作业结束时删除|run: .ci-output/tools/bin/node scripts/ci/run-share.mjs remove
CLAIM|51|一致|.github/workflows/quality.yml:42|quality.yml 不用共享目录，完整报告随作业结束丢弃|run: .ci-output/tools/bin/node scripts/ci/publish.mjs --mode quality --input .ci-output/quality --output .ci-output/public --tools .ci-output/tools
CLAIM|52|一致|docs/adr/0238-ci-job-files-stay-on-the-ci-vps.md:64|它要下载的 report- 产物在 ADR 0238 之后已经不存在|3. **GitHub 上只留很小的东西：**汇总结论 `gate-`（几 KB，`main.yml` 的 `main-evidence.mjs` 要读）和失败时的诊断 `diagnostic-`（几 MB，保存 1 天）。不用 `actions/cache`、不用付费 runner、不开 GitHub 付费存储或预算。
CLAIM|53|一致|scripts/ci/export-evidence.mjs:93|scripts/ci/export-evidence.mjs 保留，仍可对手头的报告和汇总结论运行|export function exportEvidence({
CLAIM|54|一致|scripts/ci/check-policy.mjs:480|scripts/ci/check-policy.mjs 拒绝 ci.yml 任何作业用 actions/upload-artifact 或 actions/download-artifact|!/^actions\/(?:upload|download)-artifact@/u.test(step.uses ?? ""),
CLAIM|55|一致|scripts/ci/check-policy.mjs:492|这条检查排在“action 必须在工具链锁里”之前|if (step.uses) {
CLAIM|56|一致|scripts/ci/check-policy.mjs:560|要求每个检查作业恰好一个写诊断摘要的步骤|summaries.length === 1 &&
CLAIM|57|一致|scripts/ci/check-policy.mjs:543|汇总作业有打印汇总结论的那一步|step.run === REQUIRED_GATE_COMMAND &&
CLAIM|58|一致|scripts/ci/main-workflow.mjs:85|scripts/ci/main-workflow.mjs 对 main.yml 同样拒绝|assert(!/^actions\/(?:upload|download)-artifact@/u.test(step.uses ?? ""), "github-artifact");
CLAIM|59|一致|scripts/ci/main-workflow.mjs:120|要求确认作业先重新取证据再确认|assert(rediscover >= 0 && confirmation > rediscover, "confirmation");
CLAIM|60|一致|scripts/ci/main-workflow.mjs:131|两个作业最后一步写作业摘要|assert(job.steps.at(-1)?.run === command && job.steps.at(-1).if === "always()", "job-summary");
CLAIM|61|一致|scripts/ci/quality-policy.mjs:87|scripts/ci/quality-policy.mjs 逐字比对 quality.yml|if (!isDeepStrictEqual(actual, expected))
CLAIM|62|一致|scripts/ci/install-tools.mjs:123|两个 action 从 ci/toolchain-lock.json 和 scripts/ci/install-tools.mjs 的固定清单里删除|const expectedActions = ["actions/checkout", "actions/setup-node", "actions/setup-python"].sort();
CLAIM|63|一致|scripts/ci/main-evidence.mjs:155|轻量确认只认 24 小时内完成的 PR 运行|now - Date.parse(r.updated_at) < 24 * 3600_000,
CLAIM|64|一致|ci/policy.json:313|ci/policy.json 和 ci/quality-policy.json 里的 retentionDays 字段暂时保留|"retentionDays": {
CLAIM|65|一致|scripts/ci/check-policy.mjs:198|前者在旧 main 的策略迁移里还要用|return { ...policy, retentionDays: { reports: 1, diagnostics: 1 } };
CLAIM|66|一致|scripts/ci/export-evidence.mjs:110|后者是 export-evidence.mjs 判断证据是否过期的依据|now - created >= policy.retentionDays.reports * 86_400_000
CLAIM|67|一致|docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md:54|ADR 0241 决定第 2 条里有“上传汇总结论”的步骤|上传汇总结论和删除共享目录的步骤也不运行
CLAIM|68|一致|docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md:58|ADR 0241 决定第 6 条里有“上传汇总结论”的步骤|上传汇总结论和删除共享目录只能在入口检查通过后运行
CLAIM|69|一致|.github/workflows/ci.yml:366|现在没有上传汇总结论|run: .ci-output/tools/bin/node scripts/ci/required.mjs --reports .ci-output/reports --output .ci-output/gate --base "$CI_BASE"
CLAIM|70|一致|.github/workflows/ci.yml:348|入口检查失败时不打印汇总结论|if [ "$CI_DRAFT" != false ]; then echo "CI_DRAFT_UNVERIFIED 草稿 PR 不跑 CI，标成准备合并后才跑完整检查"; exit 1; fi
CLAIM|71|一致|docs/adr/0174-no-github-cache-and-one-day-artifacts.md:64|ADR 0174 里“产物保存 1 天”的做法|2. 所有 artifact 的 `retention-days` 都是 1，报告和失败诊断一样。
CLAIM|72|找不到|-|记录在 .agents/reviews/topic-ci-no-artifacts/|-
CLAIM|73|找不到|-|共 0.36 美元|-
CLAIM|74|一致|docs/adr/0238-ci-job-files-stay-on-the-ci-vps.md:91|两个 runner 共用这个目录，别的 PR 的运行能删改本轮的汇总结论|- 两个 runner 的任务都能读写整个共享目录，所以一个任务能读、改、删共享目录里任何一轮运行的文件，不只是本轮的。
CLAIM|75|一致|.github/workflows/main.yml:7|读取用的是现有的 actions: read 权限|  actions: read
CLAIM|76|一致|docs/adr/0238-ci-job-files-stay-on-the-ci-vps.md:65|ADR 0238 定了任何作业都不带写权限|4. **任何作业都不再有写权限，`ci.yml` 的作业只往 GitHub 传诊断和汇总结论。**
CLAIM|77|一致|scripts/ci/main-evidence.mjs:112|这个 PR 合进 main 的那一次推送改了 .github/、ci/、scripts/ci/，按规则走完整 CI|"MAIN_VALIDATION_CHANGED",
CLAIM|78|找不到|-|旧的 PR 运行（本 PR 合并之前开始的）日志里没有汇总结论，main 会对它们退回完整 CI|-

背景里“原先有三种用途”的几项（`gate-`、`diagnostic-`、`main-confirmation-`、quality 检测结果、`handoff` 下载 `report-`/`gate-`）描述的是本方案改动前的状态，我另用 `ccbe4e01d^2` 的旧工作流核对过，但未按当前文件列入上表。GitHub 计费额度、仓库设置保留期、API 时间戳格式等外部事实，以及旧 PR 运行日志的实际内容，我都没有核实。
