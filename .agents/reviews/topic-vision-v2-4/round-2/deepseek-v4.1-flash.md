CLAIM|1|一致|docs/product-vision.md:107@3633e576b582a2d5eb5b93cda61aa6fb195bfc6a|愿景 v2.3 的 3.3 节说追平线「以 Muse 为对照组量化」|追平与否不靠感觉，以 Muse 为对照组量化（见 3.7 的配套指标）
CLAIM|2|一致|docs/product-vision.md:159@3633e576b582a2d5eb5b93cda61aa6fb195bfc6a|3.7 节的配套指标里有一项「与对照组的差距」|与对照组的差距（同一时期内 Himawari 与 Muse 的主动提醒命中率差、误扰率差、记忆回忆准确率差；追平线的定义是这三个差不为负）
CLAIM|3|一致|docs/product-vision.md:159@3633e576b582a2d5eb5b93cda61aa6fb195bfc6a|同一时期 Himawari 与 Muse 的主动提醒命中率差、误扰率差、记忆回忆准确率差|同一时期内 Himawari 与 Muse 的主动提醒命中率差、误扰率差、记忆回忆准确率差
CLAIM|4|一致|docs/product-vision.md:159@3633e576b582a2d5eb5b93cda61aa6fb195bfc6a|三个差不为负才算追平|追平线的定义是这三个差不为负
CLAIM|5|一致|docs/product-vision.md:159@3633e576b582a2d5eb5b93cda61aa6fb195bfc6a|愿景 3.7 仍写着以 Muse 为对照组|与对照组的差距（同一时期内 Himawari 与 Muse 的主动提醒命中率差、误扰率差、记忆回忆准确率差；追平线的定义是这三个差不为负）
CLAIM|6|一致|docs/product-vision.md:12|愿景正文只有 Andy 能改|改正文只由 Andy 决定
CLAIM|7|一致|docs/product-vision.md:107|相对 v2.3，正文只有两处不同|追平与否不靠感觉。
CLAIM|8|一致|docs/product-vision.md:95|3.3 对比表和对 Muse 使用体验的描述不变| 维度 | 通用聊天产品（ChatGPT / 豆包等） | 平台型个人 Agent（Muse 为主，另有 dots、Duet 等） | Himawari |
CLAIM|9|一致|docs/product-vision.md:105|对 Muse 使用体验的描述不变|其中最近的对手是平台型个人 Agent，不是通用聊天产品。以我自己一周的真实使用看，Muse 的记忆与主动性是目前体验最好的：它会主动用上我没有强调过的偏好；同一件事来了新邮件，它会把这件事以前的邮件串起来看完整个历史，再决定要不要告诉我，而且它决定开口时提醒得很对。dots 补上了个人规则，Duet 补上了审批门。愿景中的大半——记忆、主动、多表面、边界内行动——平台不只在做，有的已经做得很好。
CLAIM|10|一致|docs/adr/0153-adopt-product-vision-v2-3.md:39|0153 及其沿用的 ADR 0134 里关于愿景地位的全部决定包含「愿景是最上层产品文档」|愿景是最上层产品文档
CLAIM|11|一致|docs/adr/0153-adopt-product-vision-v2-3.md:39|0153 及其沿用的 ADR 0134 里关于愿景地位的全部决定包含「正文只由 Andy 修改」|正文只由 Andy 修改
CLAIM|12|一致|docs/adr/0153-adopt-product-vision-v2-3.md:39|0153 及其沿用的 ADR 0134 里关于愿景地位的全部决定包含「新版本整篇替换并由新 ADR 取代旧 ADR」|新版本整篇替换并由新 ADR 取代旧 ADR
CLAIM|13|一致|docs/adr/0153-adopt-product-vision-v2-3.md:39|0153 及其沿用的 ADR 0134 里关于愿景地位的全部决定包含「不再称“本地优先”」|不再称“本地优先”
CLAIM|14|一致|docs/adr/0134-adopt-product-vision-v2-2.md:89|0134「后果」里列出的下游冲突|每一条都在 2026-10-31 打开原文核对过，均与 v2.2 有冲突或缺口。本 ADR 只记录，不改这些文档；改法等 Andy 决定 Backlog 顺序后，由对应的 Spec 或 ADR 处理。
CLAIM|15|一致|docs/adr/0159-gmail-check-reads-full-body-and-the-owners-own-mail.md:29|其中“邮件检查不读正文”一条已由 ADR 0159 改掉|模型读邮件的全部内容（正文）。这改变了他自己此前保留的决定：[ADR 0134](0134-adopt-product-vision-v2-2.md) 第 98 行“要不要让主动检查读正文，由 Andy 决定”
CLAIM|16|一致|docs/adr/0239-real-memory-eval-sets.md:10|用真实记忆出题已经写在 ADR 0239|# ADR 0239：用主人的真实记忆每周评测记忆回忆，合成评测集降为对照
CLAIM|17|一致|docs/adr/0239-real-memory-eval-sets.md:70|分数只和自己的历史比，已经写在 ADR 0239|所以分数只能和自己的历史比，不能和论文里的数字直接比。
CLAIM|18|找不到|-|它在本 ADR 写成时还在起草，尚未进仓库|-
CLAIM|19|一致|docs/product-vision.md:12|愿景、AGENTS.md 指向 v2.4|v2.4 的采纳记录见 [ADR 0284](adr/0284-adopt-product-vision-v2-4.md)
CLAIM|20|一致|AGENTS.md:17|愿景、AGENTS.md 指向 v2.4|现行愿景 v2.4 的采纳记录是 [ADR 0284](docs/adr/0284-adopt-product-vision-v2-4.md)
CLAIM|21|一致|package.json:111|ADR 0154、ADR 0187 定的周报对照线和 Muse 数据接收（ADR 0162）仍在代码里|"report:calibration": "node scripts/calibration-report/report.mjs",
CLAIM|22|一致|packages/calibration/src/index.ts:513|ADR 0154、ADR 0187 定的周报对照线和 Muse 数据接收（ADR 0162）仍在代码里|export function summarizeGap(
CLAIM|23|一致|apps/agent-service/src/production-muse-intake.ts:18|ADR 0154、ADR 0187 定的周报对照线和 Muse 数据接收（ADR 0162）仍在代码里|export const MUSE_INTAKE_PATH = "/api/muse-intake/v1/batch";
CLAIM|24|一致|docs/product-vision.md:107|3.3 的「追平线」只作为方向保留|**第一层是追平线**：平台有的记忆与主动能力，Himawari 也要做一遍，并且做到和它们一样好。
CLAIM|25|一致|docs/product-vision.md:159|愿景里不再有判断“追上平台没有”的指标|配套量化指标（长期跟踪，不追求单点数字）：主动提醒命中率、记忆纠正一次生效率、自造工具复用次数、任务完成验证率、单位任务成本与延迟、决策可解释率（任意一次开口或沉默能追溯到规则出处与记忆原话的比例）、每周需要我介入的分钟数。
CLAIM|26|一致|docs/product-vision.md:107|3.3 括号里“见 3.7 的配套指标”指向的东西已经不在|追平与否不靠感觉。

未核实/无法按行号核对的部分：PRD v0.3 在仓库中未找到（docs 下只有 prd-v0.1.md、prd-v0.2.md），因此该项标为「找不到」；方案中关于文档头日期、仓库注、用法行、附录第 19 条以及把 0153 标为 superseded 等本次修改动作，按要求未作为现状核对。
