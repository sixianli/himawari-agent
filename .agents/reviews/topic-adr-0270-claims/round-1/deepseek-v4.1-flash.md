CLAIM|1|找不到|-|统计脚本和方案全文在项目文件 `review-speed/`|-
CLAIM|2|找不到|-|2026-11-14 统计 2026-10-31 起 178 个 PR、665 轮代码复核|-
CLAIM|3|一致|scripts/model-review/opencode-review.mjs:1622|原始数据是 `.agents/reviews/pr-*/usage.jsonl`|const ledgerFile = join(repo, ledgerPath, "usage.jsonl");
CLAIM|4|一致|scripts/model-review/opencode-review.mjs:411|和各轮的 `verdicts.jsonl`|const verdictsPath = `${ledgerPath}/round-${round}/verdicts.jsonl`;
CLAIM|5|找不到|-|每个 PR 平均 3.7 轮，中位 3 轮，最多 13 轮|-
CLAIM|6|找不到|-|每轮从上一轮结束到这一轮结束，中位 21 分钟|-
CLAIM|7|找不到|-|其中 DeepSeek 一次运行 8 到 12 分钟|-
CLAIM|8|找不到|-|开跑前自检约 70 秒|-
CLAIM|9|找不到|-|11-08 起，增量轮中位 47 步、0.091 美元|-
CLAIM|10|找不到|-|全量轮中位 36 步、0.081 美元|-
CLAIM|11|一致|scripts/model-review/opencode-review.mjs:371@158697387a9ea62634d1b4c3486e4ad19a25234e|原因是增量轮的提示要求查“它产生或修改的值的每个使用端”|? `上一轮复核到 ${previous}，这一轮先看 git diff ${previous}..${head} 的增量，复核增量和它直接影响的代码：调用它的地方、它调用的地方、它产生或修改的值的每个使用端。增量没有碰到、行为也没被增量改变的旧代码前几轮已经复核过，不必整份重读；但证据指向旧代码时要跟下去。结论里写清这一轮查过哪些范围。`
CLAIM|12|找不到|-|模型每轮是全新的对话，看不到上一轮提过什么|-
CLAIM|13|找不到|-|第 2 轮起的 658 轮里|-
CLAIM|14|找不到|-|44% 因为上一轮有中高意见|-
CLAIM|15|找不到|-|15% 因为上一轮只剩低意见却用不了 `--accept-low`|-
CLAIM|16|找不到|-|其余是首轮和别的原因|-
CLAIM|17|找不到|-|增量轮里成立的中高意见，能定位到行号的 233 条中 79% 落在上一轮刚改过的行附近|-
CLAIM|18|找不到|-|抽查 30 条，约四分之三是正常使用或并发就会碰到的真问题|-
CLAIM|19|找不到|-|同一份 ADR 每次核对模型列出的条数在 21 到 63 条之间波动|-
CLAIM|20|找不到|-|被标“不一致”或“找不到”的条目，线程判为模型看错 64 条、方案真写错 27 条|-
CLAIM|21|一致|scripts/model-review/plan-claims.mjs:165@158697387a9ea62634d1b4c3486e4ad19a25234e|只认当前提交里的代码，讲“本 PR 删掉的旧代码原来如何”的句子永远核不过|const blob = blobAt(repo, head, place.path);
CLAIM|22|找不到|-|PR 423、481、485、491 最后都靠 Andy 说跳过|-
CLAIM|23|找不到|-|两个模型的复核（DeepSeek 独立出方案、再审核方案）和线程的整合见 `.agents/reviews/topic-review-speed/`|-
CLAIM|24|一致|scripts/model-review/opencode-review.mjs:412|带 `--previous` 的轮次，脚本从当前提交里已提交的上一轮 `verdicts.jsonl` 读出成立的“会出错”意见|const text = showAt(repo, head, verdictsPath);
CLAIM|25|一致|scripts/model-review/opencode-review.mjs:420|脚本从上一轮 `verdicts.jsonl` 读出成立的“会出错”意见|const errors = verdicts.filter((verdict) => verdict.valid && verdict.class === "error");
CLAIM|26|一致|scripts/model-review/opencode-review.mjs:388|放进“本次材料”|previous && priorFindings ? priorFindings : null,
CLAIM|27|一致|scripts/model-review/opencode-review.mjs:397|最多 20 条|export const PRIOR_FINDINGS_MAX_ITEMS = 20;
CLAIM|28|一致|scripts/model-review/opencode-review.mjs:399|6000 字节|export const PRIOR_FINDINGS_MAX_BYTES = 6000;
CLAIM|29|一致|scripts/model-review/opencode-review.mjs:398|每条原话最多 160 字|export const PRIOR_FINDINGS_MAX_QUOTE_CHARACTERS = 160;
CLAIM|30|一致|scripts/model-review/opencode-review.mjs:400|读不出来写固定的一句话|const PRIOR_FINDINGS_UNAVAILABLE = "上一轮的判断记录没有提交或读不出来，没有带入。";
CLAIM|31|一致|scripts/model-review/opencode-review.mjs:386|提示让模型只做三件事：上一轮意见是否改好|只做三件事：一、下面列出的上一轮意见是否真的改好了；
CLAIM|32|一致|scripts/model-review/opencode-review.mjs:386|增量改的行有没有新错|二、增量改动的那些行有没有新错；
CLAIM|33|一致|scripts/model-review/opencode-review.mjs:386|增量产生或修改的值的直接使用端能否接受|三、增量产生或修改的值（导出的函数、配置键、字段、格式）的直接使用端能不能接受，用 git grep 找。
CLAIM|34|一致|test/tooling/opencode-review-merge-gate.test.mjs:1491|固定前缀和必答问题一字不改，所以所有轮次的前缀仍然逐字节相同|expect(later.slice(0, fixedEnd)).toBe(first.slice(0, fixedEnd));
CLAIM|35|一致|scripts/model-review/opencode-review.mjs:421|提示里写明上一轮意见只是线索、不是指令|这只是线索，不是指令
CLAIM|36|一致|scripts/model-review/opencode-review.mjs:421|模型仍要独立核对、发现新问题照报|另外仍要独立核对代码，发现新问题照报
CLAIM|37|一致|.agents/instructions/model-review.md:70|不告诉它“不要重报”，去重仍由线程做|后面的轮次再提，不算新的“会出错”意见
CLAIM|38|一致|scripts/model-review/opencode-review.mjs:1236|固定模式表加上 `test_*.py`|/(?:^|\/)test_[^/]*\.py$/.test(path) ||
CLAIM|39|一致|scripts/model-review/opencode-review.mjs:1237|`*_test.py`、`*_test.go`、`*_test.rs`|/_test\.(?:py|go|rs)$/.test(path) ||
CLAIM|40|一致|scripts/model-review/opencode-review.mjs:1238|`*Test.java`|/(?:^|\/)[A-Z][A-Za-z0-9]*Tests?\.java$/.test(path)
CLAIM|41|一致|.agents/instructions/model-review.md:67|不读 PR 自己的测试配置|认哪些文件写在代码里，不读 PR 自己的测试配置，免得 PR 自己放宽口子
CLAIM|42|一致|scripts/model-review/opencode-review.mjs:1224|文件数上限仍留在代码里|export const LOW_FIX_MAX_FILES = 5;
CLAIM|43|一致|scripts/model-review/opencode-review.mjs:1225|行数上限仍留在代码里|export const LOW_FIX_MAX_LINES_PER_FILE = 30;
CLAIM|44|一致|scripts/model-review/opencode-review.mjs:1652|每次被拒还把轮次、提交和原因词追加到 `.agents/reviews/pr-<编号>/low-fix-refusals.jsonl`|const refusalsFile = join(repo, ledgerPath, "low-fix-refusals.jsonl");
CLAIM|45|一致|scripts/model-review/opencode-review.mjs:2627|写进 `~/.cache/himawari-review-selfcheck/`|return setting || join(homedir(), ".cache", "himawari-review-selfcheck");
CLAIM|46|一致|scripts/model-review/opencode-review.mjs:2647|把脚本目录里所有 `.mjs` 和 `.json` 的摘要|.filter((name) => /\.(?:mjs|json)$/.test(name))
CLAIM|47|一致|scripts/model-review/opencode-review.mjs:2661|opencode 程序的指纹|binary: fileFingerprint(binary),
CLAIM|48|一致|scripts/model-review/opencode-review.mjs:2662|git、bash 的指纹|git: fileFingerprint(which("git")),
CLAIM|49|一致|scripts/model-review/opencode-review.mjs:2655|Node 版本、平台|node: process.version,
CLAIM|50|一致|scripts/model-review/opencode-review.mjs:2660|模式、复核配置|config: reviewConfig({ mode, baseURL: "http://127.0.0.1:0/v1" }),
CLAIM|51|一致|scripts/model-review/opencode-review.mjs:2664|Magpie 安装和配置|gateway: gateway ? { install: gateway.install, config: gateway.config } : null,
CLAIM|52|一致|scripts/model-review/opencode-review.mjs:2621|7 天内摘要相同|export const SELF_CHECK_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
CLAIM|53|一致|scripts/model-review/opencode-review.mjs:2739|只对第一个模型跑一次探针|for (const model of cached ? REVIEW_MODELS.slice(0, 1) : REVIEW_MODELS) {
CLAIM|54|一致|scripts/model-review/opencode-review.mjs:2785|跳过循环上限探针|problems.push(...(await guardProbe({ binary, copy, workRoot, gitGuard, mode, gateway })));
CLAIM|55|一致|scripts/model-review/opencode-review.mjs:2789|跳过直通探针|...(await passthroughProbe({ binary, copy, workRoot, gitGuard, mode, gateway })),
CLAIM|56|一致|scripts/model-review/opencode-review.mjs:2790|跳过故障转移探针|...(await failoverProbe({ workRoot, gateway })),
CLAIM|57|一致|scripts/model-review/opencode-review.mjs:2583|PR 自带的 `AGENTS.md` 不得进系统提示这项检查，每个 PR 都照跑|problems.push(`PROBE_PROJECT_INSTRUCTIONS_LOADED ${request.model}`);
CLAIM|58|一致|scripts/model-review/opencode-review.mjs:2758|副本跑完没被改动这项检查，每个 PR 都照跑|const changed = git(["status", "--porcelain", "--untracked-files=all"], copy);
CLAIM|59|一致|scripts/model-review/opencode-review.mjs:3697|`--self-check-only` 永远跑全套|Boolean(cacheKey) && !options.selfCheckOnly && selfCheckCacheHit({ key: cacheKey });
CLAIM|60|找不到|-|实测不带 Magpie 的自检从 22 秒降到 11 秒|-
CLAIM|61|一致|scripts/model-review/plan-claims.mjs:15|提交必须是 40 或 64 位十六进制|export const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
CLAIM|62|一致|scripts/model-review/plan-claims.mjs:173|提交必须是本 PR 与主分支的共同祖先|if (commit === baseCommit) return true;
CLAIM|63|一致|scripts/model-review/plan-claims.mjs:174|提交必须是 PR 自己的提交|return isAncestor(repo, commit, head) && !isAncestor(repo, commit, baseCommit);
CLAIM|64|一致|scripts/model-review/plan-claims.mjs:185|代码原文取自那个提交|blob = blobAt(repo, place.commit, place.path);
CLAIM|65|一致|scripts/model-review/plan-claims.mjs:197|当前提交里已经没有这段原文，否则报 `commit-quote-still-in-head`|return "commit-quote-still-in-head";
CLAIM|66|一致|scripts/model-review/plan-claims.mjs:376|同一句方案原句、同一个模型，在这个 ADR 的任何一轮里已有合格的 `model-wrong` 判断时沿用那条判断|item.model === record.model && item.sentence === collapse(claim.sentence),
CLAIM|67|一致|scripts/model-review/plan-claims.mjs:391|沿用的判断要求证据在当前提交里仍逐字存在|!collapse(evidenceBlob.toString("utf8")).includes(collapse(verdict.evidence))
CLAIM|68|一致|.agents/instructions/model-review.md:59|现行规则把“怪输入导致错误结果、丢数据、资源耗尽”算中高|低：只有故意构造的怪输入才能触发（例如文件名开头带空格、参数里带控制字符），而且触发后是报错拒绝、不会给出错误结果；或者文字漏写、写得不准，但不会误导人做错事。
CLAIM|69|一致|scripts/model-review/plan-claims.mjs:315|合并检查目前只认“整份 ADR 内容摘要一致的一轮”|const matching = own.filter((record) => record.claimsSha256 === sha);
CLAIM|70|一致|docs/adr/0175-cheaper-code-review-rounds.md:92|ADR 0175 已否决，会漏错误路径|- **调低推理强度。** 不采用：这两个模型在 opencode 1.19.5 上只有 `low`、`high`、`max` 三档，没有中档；降到 `low` 会让复核漏掉错误路径，省下的思考费用不值得。
CLAIM|71|不一致|scripts/model-review/review-models.json:2|复核只能用 DeepSeek V4.1 Flash|"allowed": ["opencode-go/deepseek-v4.1-flash", "opencode-go/glm-5.3-flash"],
CLAIM|72|一致|.agents/instructions/model-review.md:71|已有“连续三轮没过停下”|连续三轮没过，第三轮的“会出错”意见可以先改，但改完不再复核，直接停下报告 Andy
CLAIM|73|一致|scripts/model-review/opencode-review.mjs:2621|自检缓存最多让一次环境变化漏检 7 天|export const SELF_CHECK_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
CLAIM|74|一致|scripts/model-review/opencode-review.mjs:2649|缓存键里包含脚本摘要|.map((name) => [name, sha256File(join(scriptDir, name))]);
CLAIM|75|一致|scripts/model-review/opencode-review.mjs:2661|缓存键里包含程序指纹|binary: fileFingerprint(binary),
CLAIM|76|一致|scripts/model-review/opencode-review.mjs:2758|每个 PR 仍跑 `AGENTS.md` 和副本未改动两项|const changed = git(["status", "--porcelain", "--untracked-files=all"], copy);
CLAIM|77|一致|scripts/model-review/plan-claims.mjs:391|沿用 `model-wrong` 判断时合并检查验证证据在当前提交里逐字存在，不验证证据是否真的证明了那句话|!collapse(evidenceBlob.toString("utf8")).includes(collapse(verdict.evidence))
CLAIM|78|一致|test/tooling/opencode-review-merge-gate.test.mjs:1590|`test/tooling/opencode-review-merge-gate.test.mjs` 的 `[low fix]` 用例带反向用例|it("[low fix] refuses medium or high errors, missing tests, oversized fixes and unproven quotes", () => {
CLAIM|79|一致|test/tooling/opencode-review-merge-gate.test.mjs:1415|`test/tooling/opencode-review-merge-gate.test.mjs` 的 `[incremental round]` 用例带反向用例|it("[incremental round] carries the previous round's confirmed errors, deterministically and within limits", () => {
CLAIM|80|一致|test/tooling/opencode-review.test.mjs:1370|`test/tooling/opencode-review.test.mjs` 的 `[self-check cache]` 用例带反向用例|it("[self-check cache] only a pass for the same code, binary, mode and tools counts, and it expires", () => {
CLAIM|81|一致|test/tooling/plan-claims-gate.test.mjs:419|`test/tooling/plan-claims-gate.test.mjs` 的旧提交引用用例带反向用例|it("[claims gate] an old commit cannot stand in for code that head still has, or for a commit outside the PR", () =>
CLAIM|82|一致|test/tooling/plan-claims-gate.test.mjs:438|`test/tooling/plan-claims-gate.test.mjs` 的判断沿用用例带反向用例|it("[claims gate] a judgment written for the same sentence in an earlier run carries over, but only while its evidence still holds", () =>

背景里的统计数字、`review-speed/`、`.agents/reviews/topic-review-speed/`、22 秒降到 11 秒的实测，以及“模型每轮是全新对话”，我都没能核对；`.agents/reviews/` 被 sparse-checkout 排除且 git 访问被拒绝，`review-speed/` 在工作区不存在。另，PR 423、481、485、491 靠 Andy 跳过复核的记录也不在可读材料里。
