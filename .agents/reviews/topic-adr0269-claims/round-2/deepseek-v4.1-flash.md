CLAIM|1|一致|CLAUDE.md:1|本仓库根目录的 `CLAUDE.md` 只有一行 `@AGENTS.md`（`CLAUDE.md:1`）。|@AGENTS.md
CLAIM|2|一致|.claude/rules/incident-gates.md:9（120fdd9）|改动前，事故规则要求每个线程开工时通读事故清单|读 [docs/incidents-and-gates.md](../../docs/incidents-and-gates.md)。如果这次工作涉及某个有未结条目（状态为 `缺门槛` 或 `等 Andy`）的领域，在计划里说明。
CLAIM|3|一致|.claude/rules/incident-gates.md:9（120fdd9）|`.claude/rules/incident-gates.md` 第 9 行（提交 `120fdd9`）原话“读 [docs/incidents-and-gates.md](../../docs/incidents-and-gates.md)。如果这次工作涉及某个有未结条目（状态为 `缺门槛` 或 `等 Andy`）的领域，在计划里说明。”|读 [docs/incidents-and-gates.md](../../docs/incidents-and-gates.md)。如果这次工作涉及某个有未结条目（状态为 `缺门槛` 或 `等 Andy`）的领域，在计划里说明。
CLAIM|4|一致|docs/adr/0107-every-incident-gets-an-automatic-gate.md:46|ADR 0107 决定 3 原话“每个线程开工时读，收尾时更新”|每个线程开工时读，收尾时更新。
CLAIM|5|一致|docs/incidents-and-gates.md:38|事故清单 `docs/incidents-and-gates.md` 的每一行写的是一个事故的完整经过（日期、现象、根因、次数、门槛、状态）|| 编号 | 日期 | 现象 | 根因 | 次数 | 门槛（文件或命令） | 状态 |
CLAIM|6|一致|docs/incidents-and-gates.md:42|绝大多数行的状态是“已落门槛”|| I-03 | 2026-10-25 | 生产一直在跑 10 月 7 日的旧前端，设置里的联网搜索开关点不动 | 配置里的前端目录没跟着新版本更新 | 1 | `scripts/delivery-mode/make-packet.py` 发现运行中的前端目录不是当前版本就拒绝出包；`scripts/delivery-mode/packet-template/systemd/verify-switch-config-fixtures.py` 核对切换时写入新前端目录 | 已落门槛 |
CLAIM|7|一致|.claude/rules/prompt-prefix.md:1（120fdd9）|改动前，只追加规则放在 `.claude/rules/prompt-prefix.md`|# 发给模型的内容：怎样最大化 KV 缓存命中
CLAIM|8|找不到|-|开局自动载入的仓库内容里，篇幅最大的几份是 `AGENTS.md`、Andy 的全局指令和只追加规则|-|
CLAIM|9|找不到|-|而清单是全部仓库指令里最长的一份|-|
CLAIM|10|一致|.claude/rules/prompt-prefix.md:4（120fdd9）|只追加规则只在改发给模型的内容时才用得上|这份规则约束所有会话，包括协调者和云端线程，快速模式和完整模式都适用。凡是组装或修改发给模型的内容，都要先读它。
CLAIM|11|一致|scripts/check-incident-gates.mjs:91|它只打印没有关闭的条目（“缺门槛”“等 Andy”和“仓库外”）的编号、状态、日期和一句话现象|`${incident.id} | ${incident.state} | ${incident.date} | ${firstSentence(incident.symptom ?? "")}`,
CLAIM|12|不一致|scripts/check-incident-gates.mjs:106|最后一行是 `INCIDENT_OPEN count=<条数> total=<总数>`|`INCIDENT_GATES ${errors.length === 0 ? "passed" : "failed"} incidents=${incidents.length} errors=${errors.length}\n`
CLAIM|13|一致|scripts/check-incident-gates.mjs:98|清单有任何一处通不过检查时，不列条目|if (process.argv.includes("--open") && errors.length > 0) {
CLAIM|14|不一致|scripts/check-incident-gates.mjs:106|只打印 `INCIDENT_OPEN unavailable errors=<错误数>`|`INCIDENT_GATES ${errors.length === 0 ? "passed" : "failed"} incidents=${incidents.length} errors=${errors.length}\n`
CLAIM|15|一致|scripts/check-incident-gates.mjs:65|“第三次必须有硬门槛”仍由 `npm run check:incident-gates` 拦|if (count >= 3 && !HARD_GATE_STATES.has(incident.state))
CLAIM|16|一致|package.json:30|这一步现在也跑 `test/tooling/incident-gates.test.mjs`|"check:incident-gates": "node scripts/check-incident-gates.mjs && vitest run --config vitest.workspace.ts --project tooling test/tooling/incident-gates.test.mjs",
CLAIM|17|一致|scripts/check-prompt-prefix.mjs:59|`npm run check:prompt-prefix` 照旧是阻断检查|process.exitCode = ok ? 0 : 1;
CLAIM|18|一致|docs/kv-cache-guide.md:12|`docs/` 下指向只追加规则的链接已同步改成新路径 `.agents/instructions/prompt-prefix.md`|开发时必须遵守的条目另写在 [.agents/instructions/prompt-prefix.md](../.agents/instructions/prompt-prefix.md)，两份的条目编号一致。
CLAIM|19|一致|.agents/instructions/model-review.md:80|合并前复核的必问题“这个改动会不会改变模型已经见过的请求开头”|1. 这个改动会不会改变模型已经见过的请求开头？

未核对的部分：前提 1、2 和业界做法引用的 Claude Code 文档属于外部资料，Andy 的三条原话和 PR 495 的说明也不在本仓库；背景里“大多数线程用不到只追加规则”这类使用频率判断没有可逐行核对的依据。篇幅和长度的相对排序（第 8、9 条）没有可直接引用的原文，也未做字节统计。
