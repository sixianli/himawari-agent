CLAIM|1|一致|CLAUDE.md:1|本仓库根目录的 `CLAUDE.md` 只有一行 `@AGENTS.md`（`CLAUDE.md:1`）。|`@AGENTS.md`
CLAIM|2|一致|docs/adr/0107-every-incident-gets-an-automatic-gate.md:46|[ADR 0107](0107-every-incident-gets-an-automatic-gate.md) 决定 3 要求每个线程开工时读事故清单，原话“每个线程开工时读，收尾时更新”。|每个线程开工时读，收尾时更新。
CLAIM|3|一致|docs/incidents-and-gates.md:38|事故清单 `docs/incidents-and-gates.md` 的每一行写的是一个事故的完整经过（日期、现象、根因、次数、门槛、状态）。|| 编号 | 日期 | 现象 | 根因 | 次数 | 门槛（文件或命令） | 状态 |
CLAIM|4|一致|docs/incidents-and-gates.md:40-135|绝大多数行的状态是“已落门槛”。|| 已落门槛 |
CLAIM|5|一致|scripts/check-incident-gates.mjs:10,88-92|线程开工时运行 `node scripts/check-incident-gates.mjs --open`，它只打印没有关闭的条目（“缺门槛”“等 Andy”和“仓库外”）的编号、状态、日期和一句话现象。|const OPEN_STATES = new Set(INCIDENT_STATES.filter((state) => state !== "已落门槛")); `${incident.id} | ${incident.state} | ${incident.date} | ${firstSentence(incident.symptom ?? "")}`,
CLAIM|6|一致|scripts/check-incident-gates.mjs:103|再打印一行 `INCIDENT_OPEN count=<条数> total=<总数>`。|process.stdout.write(`INCIDENT_OPEN count=${lines.length} total=${incidents.length}\n`);
CLAIM|7|一致|scripts/check-incident-gates.mjs:105-107|之后照旧是检查结果行 `INCIDENT_GATES …`。|`INCIDENT_GATES ${errors.length === 0 ? "passed" : "failed"} incidents=${incidents.length} errors=${errors.length}\n`
CLAIM|8|一致|scripts/check-incident-gates.mjs:98-99|清单有任何一处通不过检查时，不列条目，用一行 `INCIDENT_OPEN unavailable errors=<错误数>` 代替，因为这时列出来的可能不全。|if (process.argv.includes("--open") && errors.length > 0) { process.stdout.write(`INCIDENT_OPEN unavailable errors=${errors.length}\n`); }
CLAIM|9|一致|scripts/check-incident-gates.mjs:65-66|“第三次必须有硬门槛”仍由 `npm run check:incident-gates` 拦。|if (count >= 3 && !HARD_GATE_STATES.has(incident.state)) errors.push(`INCIDENT_THIRD_REPEAT_WITHOUT_HARD_GATE ${where} count=${count}`);
CLAIM|10|一致|package.json:30|这一步现在也跑 `test/tooling/incident-gates.test.mjs`。|"check:incident-gates": "node scripts/check-incident-gates.mjs && vitest run --config vitest.workspace.ts --project tooling test/tooling/incident-gates.test.mjs",
CLAIM|11|一致|.agents/instructions/prompt-prefix.md:2|`.claude/rules/prompt-prefix.md` 移到 `.agents/instructions/prompt-prefix.md`。|# 发给模型的内容：怎样最大化 KV 缓存命中
CLAIM|12|一致|AGENTS.md:43|`AGENTS.md` 的“发给模型的内容只追加”一节保留三条核心原则。|已经发出去的内容不得改动、重排或删除，只能在末尾追加；每轮会变的内容只放在最后一条消息里；系统提示和工具按对话冻结。
CLAIM|13|一致|AGENTS.md:43|写明只要动到发给模型的上下文就必须先读这份规则。|那份规则不在开局自动载入，只要动到上面这些内容就必须先读它，不能靠自己判断“影响不大”而跳过。
CLAIM|14|一致|AGENTS.md:45-49|并列出 5 个用来判断“算不算动到”的问题。|- 这个改动会不会让模型已经见过的请求开头变化？ - 我加的值是不是每轮都一样？不一样的只能放在最后一条消息里。 - 我是不是在存历史之前处理了消息？ - 我加进去的列表或 JSON，顺序是不是固定的？ - 这个改动会不会让同一对话换模型、换服务方，或者增删工具？
CLAIM|15|一致|.agents/instructions/prompt-prefix.md:74|`npm run check:prompt-prefix` 照旧是阻断检查。|- **阻断检查：**`npm run check:prompt-prefix`（属于 `npm run check` 的一步）。
CLAIM|16|一致|AGENTS.md:57-63|“交付模式”“和 OpenCode 协作”“Pi 优先与工作区”三节只保留几条核心规则和“什么时候要读什么、读哪份文件”，细节以 `.agents/instructions/delivery-mode.md`、`model-review.md`、`model-review-card.md` 和 `docs/pi-development-guide.md` 为准。|方案讨论和合并前的代码复核，都要请 OpenCode（一个能让模型读代码、调用工具的命令行程序）上的模型看：默认只用 `opencode-go/deepseek-v4.1-flash`，只有 Andy 特别指明时才加上 `opencode-go/glm-5.3-flash`（[ADR 0259](docs/adr/0259-review-models-default-to-deepseek.md)）。一律用 `node scripts/model-review/opencode-review.mjs` 跑，不自己拼 `opencode run` 命令。
CLAIM|17|一致|docs/glossary.md:66|`docs/` 下指向只追加规则的链接已同步改成新路径 `.agents/instructions/prompt-prefix.md`。|- 发给模型的提示词和工具结果文字：已发出的内容只能往后追加（见 [prompt-prefix.md](../.agents/instructions/prompt-prefix.md)），不为改名而改动。
CLAIM|18|一致|AGENTS.md:63|合并前复核的必问题“这个改动会不会改变模型已经见过的请求开头”。|除 `plan-claims` 外，每次的提示里必须有[每次都要问的问题](.agents/instructions/model-review.md#checklist)，包括「这个改动会不会改变模型已经见过的请求开头」。

方案里纯属未来操作流程、不是对现有文件状态描述的句子（如清单一条不删、按关键词搜索、开工时去读清单某一行），以及外部 Claude Code 文档的原话和 token/篇幅估算，未纳入或无法只靠仓库文件核实。
