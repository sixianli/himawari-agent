CLAIM|1|一致|docs/product-vision.md:107@3633e576b582a2d5eb5b93cda61aa6fb195bfc6a|愿景 v2.3 的 3.3 节说追平线「以 Muse 为对照组量化」|追平与否不靠感觉，以 Muse 为对照组量化（见 3.7 的配套指标）。
CLAIM|2|一致|docs/product-vision.md:159@3633e576b582a2d5eb5b93cda61aa6fb195bfc6a|3.7 节的配套指标里有一项「与对照组的差距」|与对照组的差距（同一时期内 Himawari 与 Muse 的主动提醒命中率差、误扰率差、记忆回忆准确率差；追平线的定义是这三个差不为负）
CLAIM|3|一致|docs/product-vision.md:159@3633e576b582a2d5eb5b93cda61aa6fb195bfc6a|同一时期 Himawari 与 Muse 的主动提醒命中率差、误扰率差、记忆回忆准确率差，三个差不为负才算追平|与对照组的差距（同一时期内 Himawari 与 Muse 的主动提醒命中率差、误扰率差、记忆回忆准确率差；追平线的定义是这三个差不为负）
CLAIM|4|一致|docs/product-vision.md:159@3633e576b582a2d5eb5b93cda61aa6fb195bfc6a|并指出愿景 3.7 仍写着以 Muse 为对照组|与对照组的差距（同一时期内 Himawari 与 Muse 的主动提醒命中率差、误扰率差、记忆回忆准确率差；追平线的定义是这三个差不为负）
CLAIM|5|一致|docs/product-vision.md:12|愿景正文只有 Andy 能改|改正文只由 Andy 决定
CLAIM|6|一致|docs/adr/0134-adopt-product-vision-v2-2.md:47|愿景是最上层产品文档|它是最上层的产品文档。
CLAIM|7|一致|docs/adr/0134-adopt-product-vision-v2-2.md:48|正文只由 Andy 修改|正文只由 Andy 修改。
CLAIM|8|一致|docs/adr/0134-adopt-product-vision-v2-2.md:48|新版本整篇替换并由新 ADR 取代旧 ADR|出新版本时整篇替换，并在附录记录改动；采纳记录由新 ADR 取代旧 ADR，仓库注指向现行的采纳 ADR。
CLAIM|9|一致|docs/adr/0134-adopt-product-vision-v2-2.md:50|不再称“本地优先”|不再把 Himawari 描述为「本地优先」（local-first），说法是「自有优先、数据自持」。
CLAIM|10|一致|docs/adr/0134-adopt-product-vision-v2-2.md:89|0134「后果」里列出的下游冲突|每一条都在 2026-10-31 打开原文核对过，均与 v2.2 有冲突或缺口。本 ADR 只记录，不改这些文档；改法等 Andy 决定 Backlog 顺序后，由对应的 Spec 或 ADR 处理。
CLAIM|11|找不到|-|0134「后果」里列出的下游冲突仍是已知缺口，不随本 ADR 改变|（未读到能证明这些下游冲突在当前提交仍逐项存在的代码）
CLAIM|12|一致|docs/adr/0239-real-memory-eval-sets.md:28|用真实记忆出题、分数只和自己的历史比，已经写在 ADR 0239|从主人确认过的记忆和主人当时的原话自动出题
CLAIM|13|一致|docs/adr/0239-real-memory-eval-sets.md:70|用真实记忆出题、分数只和自己的历史比，已经写在 ADR 0239|所以分数只能和自己的历史比，不能和论文里的数字直接比。
CLAIM|14|一致|-|它在本 ADR 写成时还在起草，尚未进仓库|（glob 未找到 **/*prd*v0.3*；docs 下只有 docs/prd-v0.1.md、docs/prd-v0.2.md）
CLAIM|15|一致|docs/product-vision.md:12|愿景、AGENTS.md 指向 v2.4|v2.4 的采纳记录见 [ADR 0284](adr/0284-adopt-product-vision-v2-4.md)
CLAIM|16|一致|AGENTS.md:17|愿景、AGENTS.md 指向 v2.4|现行愿景 v2.4 的采纳记录是 [ADR 0284](docs/adr/0284-adopt-product-vision-v2-4.md)。
CLAIM|17|一致|package.json:111|ADR 0154、ADR 0187 定的周报对照线和 Muse 数据接收（ADR 0162）仍在代码里|"report:calibration": "node scripts/calibration-report/report.mjs",
CLAIM|18|一致|packages/calibration/src/index.ts:513|ADR 0154、ADR 0187 定的周报对照线和 Muse 数据接收（ADR 0162）仍在代码里|export function summarizeGap(
CLAIM|19|一致|apps/agent-service/src/production-muse-intake.ts:18|ADR 0154、ADR 0187 定的周报对照线和 Muse 数据接收（ADR 0162）仍在代码里|export const MUSE_INTAKE_PATH = "/api/muse-intake/v1/batch";
CLAIM|20|一致|docs/product-vision.md:107|3.3 的「追平线」只作为方向保留|第一层是追平线：平台有的记忆与主动能力，Himawari 也要做一遍，并且做到和它们一样好。这是入场券，也是这个项目作为我求职作品的硬指标；追平与否不靠感觉。
CLAIM|21|一致|docs/product-vision.md:159|愿景里不再有判断“追上平台没有”的指标|配套量化指标（长期跟踪，不追求单点数字）：主动提醒命中率、记忆纠正一次生效率、自造工具复用次数、任务完成验证率、单位任务成本与延迟、决策可解释率（任意一次开口或沉默能追溯到规则出处与记忆原话的比例）、每周需要我介入的分钟数。
CLAIM|22|一致|docs/product-vision.md:107|复核指出删掉与 Muse 的差距后，3.3 括号里“见 3.7 的配套指标”指向的东西已经不在|追平与否不靠感觉。
CLAIM|23|一致|docs/product-vision.md:95|3.3 对比表和对 Muse 使用体验的描述不变| | 维度 | 通用聊天产品（ChatGPT / 豆包等） | 平台型个人 Agent（Muse 为主，另有 dots、Duet 等） | Himawari |
CLAIM|24|一致|docs/product-vision.md:105|3.3 对比表和对 Muse 使用体验的描述不变|以我自己一周的真实使用看，Muse 的记忆与主动性是目前体验最好的：
CLAIM|25|一致|-|不涉及代码、数据库和接口|（git diff --name-only 3633e576… c0b7bf53… 只列出 AGENTS.md、docs/ 和 .agents/reviews/ 下的文件）

未核实：PRD v0.3 的具体内容（仓库中没有该文件）、Andy 与线程的评论原话，以及 0134 所列下游冲突是否逐项仍存在于当前代码。方案“决定”中纯属本次修改动作的描述（如文档头、用法行、附录、superseded 标记、正文仅两处不同）按题目要求未作为现状核对。
