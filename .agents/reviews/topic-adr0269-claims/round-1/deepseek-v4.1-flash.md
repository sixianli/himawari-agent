CLAIM|1|一致|CLAUDE.md:1|本仓库根目录的 `CLAUDE.md` 只有一行 `@AGENTS.md`（`CLAUDE.md:1`）。|@AGENTS.md
CLAIM|2|一致|.claude/rules/incident-gates.md:9@120fdd9|改动前，事故规则要求每个线程开工时通读事故清单：`.claude/rules/incident-gates.md` 第 9 行（提交 `120fdd9`）原话“读 [docs/incidents-and-gates.md](../../docs/incidents-and-gates.md)。如果这次工作涉及某个有未结条目（状态为 `缺门槛` 或 `等 Andy`）的领域，在计划里说明。”|读 [docs/incidents-and-gates.md](../../docs/incidents-and-gates.md)。如果这次工作涉及某个有未结条目（状态为 `缺门槛` 或 `等 Andy`）的领域，在计划里说明。
CLAIM|3|一致|docs/adr/0107-every-incident-gets-an-automatic-gate.md:46|[ADR 0107](0107-every-incident-gets-an-automatic-gate.md) 决定 3 原话“每个线程开工时读，收尾时更新”。|3. **事故与门槛清单。** [docs/incidents-and-gates.md](../incidents-and-gates.md) 每条写日期、现象、根因、出现次数、门槛（文件或命令）和状态。每个线程开工时读，收尾时更新。`npm run check` 运行 `scripts/check-incident-gates.mjs` 核对这张表：“已落门槛”必须写出仓库里真实存在的门槛文件，次数达到 3 的条目不能是“缺门槛”。
CLAIM|4|找不到|-|改动前，事故清单 `docs/incidents-and-gates.md` 有 184413 字节。|-
CLAIM|5|一致|docs/incidents-and-gates.md:38-135|改动前，事故清单 `docs/incidents-and-gates.md` 有 96 条。|| 编号 | 日期 | 现象 | 根因 | 次数 | 门槛（文件或命令） | 状态 |
CLAIM|6|一致|docs/incidents-and-gates.md:40-135|其中 90 条“已落门槛”。|| I-01 | 2026-10-25 | 上线后只读回了首页 200 和服务端状态，没人在真浏览器里用一遍；长回答被截断、旧前端、搜索卡 5 分钟、重启后开关勾不上，都是 Andy 自己发现的 | 上线脚本对“在浏览器里按用户的用法走一遍”没有任何条件 | 4 | `scripts/delivery-mode/browser-acceptance-gate.py`：`deploy.sh` 先核对 `test/integration/product-path-browser.test.ts` 的发布走查记录，缺一项就以退出码 5 拒绝上线（[详细](lessons.md#release-without-browser-walkthrough)） | 已落门槛 |
CLAIM|7|一致|docs/incidents-and-gates.md:45,63,83,97,100|5 条“缺门槛”。|| I-06 | 2026-09-29 | 提交 `51fe7f6` 改了网页代码却没重新封存对应的操作手册，之后文档严格校验一直失败 | 改代码时没人核对受影响的文档 | 1 | 无。原门槛 `npm run check:docs` 已于 2026-10-31 按 Andy 的决定删除（[ADR 0133](adr/0133-docs-check-removed-from-npm-run-check.md)），只能通过 `document-governance` 技能手动校验，不再拦提交 | 缺门槛 |
CLAIM|8|一致|docs/incidents-and-gates.md:48|1 条“仓库外”。|| I-09 | 2026-10-25 | Mac 远程会话里，Andy 在项目聊天说过的授权（“合进 main”“上线第十次”“上”）和点过的选择卡不被认，又要他在线程里亲手再打一遍；只读诊断也被拦过 | Claude Code 远程会话的自动权限检查只认 Andy 在该线程亲手打的字，协调者转达和选择卡都不算 | 7 | 不在仓库里，没法加测试；第 7 次是 2026-10-29 01:37，第十八版包出好、预检全过后，Andy 睡前在项目聊天“提前同意”的上线仍被拦下 `deploy.sh`。替代做法：合并 PR 交给云端线程代合；在 Mac 远程会话里上线前，协调者先请 Andy 在该线程亲手打一句短授权，提前同意和转达都不算，不先发选择卡（项目记忆 no-repeat-authorization）。在 `deploy.sh` 里加不拦人的提示不算门槛，所以没加 | 仓库外 |
CLAIM|9|找不到|-|改动前，只追加规则 `.claude/rules/prompt-prefix.md` 有 14505 字节。|-
CLAIM|10|一致|-|`.claude/rules/` 下五个文件。|incident-gates.md
owner-global-instructions.md
owner-standing-rules.md
prompt-prefix.md
proposal-premises.md
CLAIM|11|找不到|-|`AGENTS.md` 约 4.5k。|-
CLAIM|12|找不到|-|`.claude/rules/` 下五个文件约 12.4k。|-
CLAIM|13|找不到|-|其中只追加规则 `prompt-prefix.md` 一份就约 4.7k。|-
CLAIM|14|找不到|-|开局自动载入的仓库内容约 1.69 万 token。|-
CLAIM|15|找不到|-|事故规则还要求开工通读整份事故清单，约 5.8 万 token。|-
CLAIM|16|一致|docs/incidents-and-gates.md:45,48|而开工时真正用得上的，只有还没关闭的 6 条。|| I-06 | 2026-09-29 | 提交 `51fe7f6` 改了网页代码却没重新封存对应的操作手册，之后文档严格校验一直失败 | 改代码时没人核对受影响的文档 | 1 | 无。原门槛 `npm run check:docs` 已于 2026-10-31 按 Andy 的决定删除（[ADR 0133](adr/0133-docs-check-removed-from-npm-run-check.md)），只能通过 `document-governance` 技能手动校验，不再拦提交 | 缺门槛 |
CLAIM|17|不一致|-|2026-11-01 以来 910 个提交里。|52d9eabed feat(memory): 往下游查推出的记忆，规则重检的比较逻辑
CLAIM|18|不一致|-|动到 `packages/prompt-catalog`、`packages/runtime-pi`、`packages/sensitive-capture` 的只有 72 个。|0829c5e7b Merge remote-tracking branch 'origin/main' into claude/project-thread-4r401y
CLAIM|19|不一致|-|（约 8%）。|a8e66cce8 feat: 密码、密钥标敏感而不是整条丢弃（去掉整段拦下 第 2 步）
49e9c16ff fix(decision-record): 第 3 轮复核的低严重度意见：规则行 key、控制字符用例锁住原编号计数、文案（P1-3）
CLAIM|20|一致|scripts/check-incident-gates.mjs:65-66|“第三次必须有硬门槛”仍由 `npm run check:incident-gates` 拦。|    if (count >= 3 && !HARD_GATE_STATES.has(incident.state))
      errors.push(`INCIDENT_THIRD_REPEAT_WITHOUT_HARD_GATE ${where} count=${count}`);
CLAIM|21|一致|package.json:30|这一步现在也跑 `test/tooling/incident-gates.test.mjs`。|    "check:incident-gates": "node scripts/check-incident-gates.mjs && vitest run --config vitest.workspace.ts --project tooling test/tooling/incident-gates.test.mjs",
CLAIM|22|一致|AGENTS.md:51|`npm run check:prompt-prefix` 照旧是阻断检查。|每条做法的理由、一手来源和本项目的现状见 [模型请求的 KV 缓存规范](docs/kv-cache-guide.md)。`npm run check:prompt-prefix` 是阻断检查。
CLAIM|23|一致|.agents/instructions/delivery-mode.md:2|细节以 `.agents/instructions/delivery-mode.md` 为准。|# 交付模式
CLAIM|24|一致|.agents/instructions/model-review.md:2|细节以 `.agents/instructions/model-review.md` 为准。|# 和 OpenCode 协作：方案讨论和代码复核
CLAIM|25|一致|.agents/instructions/model-review-card.md:2|细节以 `.agents/instructions/model-review-card.md` 为准。|# 代码复核流程卡
CLAIM|26|一致|docs/pi-development-guide.md:8|细节以 `docs/pi-development-guide.md` 为准。|# Pi 二次开发规范
CLAIM|27|一致|docs/adr/0164-move-changing-values-out-of-the-request-head.md:29|大约 30 份 ADR 和文档里指向旧路径 `.claude/rules/prompt-prefix.md` 的链接已同步改成新路径。|模型服务方会缓存请求开头完全相同的部分（KV 缓存，即服务方对重复出现的开头内容做的缓存，命中的部分不用重新计算，更快也更便宜）。[发给模型的内容只追加](../../.agents/instructions/prompt-prefix.md) 规定：已经发给模型的内容不得改动，每轮会变的内容只能放在最后一条用户消息里（第 1、2 条）。
CLAIM|28|找不到|-|`.agents/reviews/` 下的历史复核记录不改。|-
CLAIM|29|一致|docs/adr/0107-every-incident-gets-an-automatic-gate.md:11|[ADR 0107：每个事故落一道自动检查，同一错误第三次必须有硬门槛](0107-every-incident-gets-an-automatic-gate.md)|# ADR 0107：每个事故落一道自动检查，同一错误第三次必须有硬门槛
CLAIM|30|一致|docs/incidents-and-gates.md:8|[事故与门槛清单](../incidents-and-gates.md)|# 事故与门槛清单
CLAIM|31|一致|docs/adr/0149-append-only-model-requests.md:10|[ADR 0149：发给模型的请求只追加](0149-append-only-model-requests.md)|# ADR 0149：发给模型的内容只追加，历史存实际发出去的那条
CLAIM|32|一致|docs/kv-cache-guide.md:8|[模型请求的 KV 缓存规范](../kv-cache-guide.md)|# 模型请求的 KV 缓存规范

未核对的部分：184413、14505 两个精确字节数，以及 4.5k、12.4k、4.7k、1.69 万、5.8 万这几组 token 估算，受工具限制无法从仓库内容直接测出，均标为找不到。`.agents/reviews/` 的历史改动无法用 git 命令核对（该路径的 git 操作被环境拒绝），只从提交 e4cf37ea6 看到本轮新增了 PR 495 第 3 轮复核记录并修改了 usage.jsonl，无法确认旧复核记录是否被改动。
