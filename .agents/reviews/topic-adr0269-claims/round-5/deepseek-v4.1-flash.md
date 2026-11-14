CLAIM|1|一致|CLAUDE.md:1|本仓库根目录的 `CLAUDE.md` 只有一行 `@AGENTS.md`（`CLAUDE.md:1`）。|@AGENTS.md
CLAIM|2|一致|docs/adr/0107-every-incident-gets-an-automatic-gate.md:46|ADR 0107 决定 3 要求每个线程开工时读事故清单，原话“每个线程开工时读，收尾时更新”。|每个线程开工时读，收尾时更新。
CLAIM|3|一致|docs/incidents-and-gates.md:38|事故清单 `docs/incidents-and-gates.md` 的每一行写的是一个事故的完整经过（日期、现象、根因、次数、门槛、状态）。|| 编号 | 日期 | 现象 | 根因 | 次数 | 门槛（文件或命令） | 状态 |
CLAIM|4|一致|docs/incidents-and-gates.md:40|绝大多数行的状态是“已落门槛”。|| 已落门槛 |
CLAIM|5|一致|.agents/instructions/prompt-prefix.md:4|只追加规则只在改发给模型的内容时才用得上|凡是组装或修改发给模型的内容，都要先读它。
CLAIM|6|一致|docs/adr/0107-every-incident-gets-an-automatic-gate.md:46|前提 4 要求每个线程开工时读整份事故清单|每个线程开工时读，收尾时更新。
CLAIM|7|一致|docs/incidents-and-gates.md:38|而清单的每一行都是一个事故的完整经过（前提 5）|| 编号 | 日期 | 现象 | 根因 | 次数 | 门槛（文件或命令） | 状态 |
CLAIM|8|找不到|-|按字数估算的 token 数和提交统计写在 PR 495 的说明里，没有用分词器实测。|-
CLAIM|9|一致|scripts/check-incident-gates.mjs:10|它只打印没有关闭的条目（“缺门槛”“等 Andy”和“仓库外”）|const OPEN_STATES = new Set(INCIDENT_STATES.filter((state) => state !== "已落门槛"));
CLAIM|10|一致|scripts/check-incident-gates.mjs:91|的编号、状态、日期和一句话现象|        `${incident.id} | ${incident.state} | ${incident.date} | ${firstSentence(incident.symptom ?? "")}`,
CLAIM|11|一致|scripts/check-incident-gates.mjs:103|再打印一行 `INCIDENT_OPEN count=<条数> total=<总数>`|    process.stdout.write(`INCIDENT_OPEN count=${lines.length} total=${incidents.length}\n`);
CLAIM|12|一致|scripts/check-incident-gates.mjs:106|之后照旧是检查结果行 `INCIDENT_GATES …`|    `INCIDENT_GATES ${errors.length === 0 ? "passed" : "failed"} incidents=${incidents.length} errors=${errors.length}\n`,
CLAIM|13|一致|scripts/check-incident-gates.mjs:98|清单有任何一处通不过检查时，不列条目|  if (process.argv.includes("--open") && errors.length > 0) {
CLAIM|14|一致|scripts/check-incident-gates.mjs:99|用一行 `INCIDENT_OPEN unavailable errors=<错误数>` 代替|    process.stdout.write(`INCIDENT_OPEN unavailable errors=${errors.length}\n`);
CLAIM|15|一致|scripts/check-incident-gates.mjs:65|“第三次必须有硬门槛”仍由 `npm run check:incident-gates` 拦|    if (count >= 3 && !HARD_GATE_STATES.has(incident.state))
CLAIM|16|一致|package.json:30|这一步现在也跑 `test/tooling/incident-gates.test.mjs`|"check:incident-gates": "node scripts/check-incident-gates.mjs && vitest run --config vitest.workspace.ts --project tooling test/tooling/incident-gates.test.mjs",
CLAIM|17|一致|AGENTS.md:43|`AGENTS.md` 的“发给模型的内容只追加”一节保留三条核心原则|已经发出去的内容不得改动、重排或删除，只能在末尾追加；每轮会变的内容只放在最后一条消息里；系统提示和工具按对话冻结。
CLAIM|18|一致|AGENTS.md:43|写明只要动到发给模型的上下文就必须先读这份规则|那份规则不在开局自动载入，只要动到上面这些内容就必须先读，不能靠自己判断“影响不大”而跳过。
CLAIM|19|一致|AGENTS.md:45-49|并列出 5 个用来判断“算不算动到”的问题|- 这个改动会不会让模型已经见过的请求开头变化？
CLAIM|20|一致|scripts/check-prompt-prefix.mjs:59|`npm run check:prompt-prefix` 照旧是阻断检查|process.exitCode = ok ? 0 : 1;
CLAIM|21|找不到|-|（PR 495 说明里按字数估算，每个线程开局约少 6 万 token）|-
CLAIM|22|一致|.agents/instructions/model-review.md:80|合并前复核的必问题“这个改动会不会改变模型已经见过的请求开头”|1. 这个改动会不会改变模型已经见过的请求开头？
CLAIM|23|一致|docs/glossary.md:66|`docs/` 下指向只追加规则的链接已同步改成新路径 `.agents/instructions/prompt-prefix.md`|- 发给模型的提示词和工具结果文字：已发出的内容只能往后追加（见 [prompt-prefix.md](../.agents/instructions/prompt-prefix.md)），不为改名而改动。

未核对的部分：PR 495 的说明不在仓库里，无法验证两处 token 数字；仓库是只覆盖 62% 跟踪文件的稀疏检出，无法保证 `docs/` 下所有未检出文件里的旧链接都已改完；外部 Claude Code 文档所述的开局载入行为也未核对。
