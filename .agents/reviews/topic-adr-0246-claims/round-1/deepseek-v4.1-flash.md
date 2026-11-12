CLAIM|1|一致|docs/adr/0228-external-memory-proposals-wait-for-owner-confirmation.md:10|ADR 0228 定了后端：其他 agent（例如 Muse、Claude Code 这类能通过 MCP 连到 Himawari 的程序）提议的记忆先存进 external_memory_proposals 表，叫「待确认」，Andy 在 Himawari 里确认后才保存。|# ADR 0228：其他 agent 写进来的记忆先存「待确认」，主人在 Himawari 里确认后才保存（部分取代 ADR 0225 决定 2、3、6）
CLAIM|2|一致|docs/adr/0228-external-memory-proposals-wait-for-owner-confirmation.md:37|那个 PR 为了让改表队列先放行，把网页和数据导出留给了下一个 PR|本 ADR 定后端：新表、MCP 工具的行为、确认和撤销的网关操作。网页上「来自其他 agent」那一节界面和数据导出放在下一个 PR（见[后果](#consequences)），这样改表队列可以先放行。
CLAIM|3|一致|docs/adr/0228-external-memory-proposals-wait-for-owner-confirmation.md:124|那个 PR 为了让改表队列先放行，把每天打分里的提示留给了下一个 PR|  - 每日回顾在待确认条数大于 0 时加一行提示。
CLAIM|4|找不到|-|也就是本 ADR 对应的 PR（任务 P5-3 PR A2）|-
CLAIM|5|一致|docs/adr/0228-external-memory-proposals-wait-for-owner-confirmation.md:123|网页「设置 → 记忆」顶部的「来自其他 agent」一节：勾选后「保存所选」「不要所选」、全选、单条改了再保存、撤销一批；来源按「自称：Muse」显示；数字按第 4 条的定义。|  - 网页「设置 → 记忆」顶部的「来自其他 agent」一节：勾选后「保存所选」「不要所选」、全选、单条改了再保存、撤销一批；来源按「自称：Muse」显示；数字按第 4 条的定义。
CLAIM|6|一致|docs/adr/0228-external-memory-proposals-wait-for-owner-confirmation.md:124|每日回顾在待确认条数大于 0 时加一行提示。|  - 每日回顾在待确认条数大于 0 时加一行提示。
CLAIM|7|一致|docs/adr/0228-external-memory-proposals-wait-for-owner-confirmation.md:125|数据导出带上这张表。|  - 数据导出带上这张表。在那之前，导出清单的 `omitted` 里写明这张表还没导出、有几行。
CLAIM|8|一致|packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql:24|CHECK ((status = 'pending') = (decided_at IS NULL))|  CHECK ((status = 'pending') = (decided_at IS NULL)),
CLAIM|9|一致|packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql:26|CHECK (content_ref IS NOT NULL OR status IN ('rejected', 'superseded'))|  CHECK (content_ref IS NOT NULL OR status IN ('rejected', 'superseded')),
CLAIM|10|一致|packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql:25|只有已保存的能指向记忆|  CHECK (memory_id IS NULL OR status = 'committed'),
CLAIM|11|一致|packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql:27|只有被替换的能指向替换它的提议|  CHECK (superseded_by IS NULL OR status = 'superseded'),
CLAIM|12|一致|packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql:28|只有已保存或已拒绝的能属于一批|  CHECK (batch_id IS NULL OR status IN ('committed', 'rejected'))
CLAIM|13|一致|packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql:31-33|CREATE UNIQUE INDEX external_memory_proposals_text_index ON external_memory_proposals(owner_id, agent_id, text_sha256) WHERE status <> 'superseded'|CREATE UNIQUE INDEX external_memory_proposals_text_index ON external_memory_proposals(owner_id, agent_id, text_sha256) WHERE status <> 'superseded'
CLAIM|14|一致|packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql:58|external_memory_proposal_keys 的主键是“(owner_id, agent_id, client, source_key)”|  PRIMARY KEY (owner_id, agent_id, client, source_key)
CLAIM|15|一致|packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql:67|external_memory_proposal_unkeyed 的主键是“(proposal_id, client)”|  PRIMARY KEY (proposal_id, client)
CLAIM|16|一致|apps/agent-service/src/production-mcp-memory-writer.ts:578|拒绝的正文 30 天后删掉|        Date.parse(this.#options.clock.now()) - EXTERNAL_PROPOSAL_REJECTED_TEXT_DAYS * DAY_MS,
CLAIM|17|一致|packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:492|只留摘要|        "UPDATE external_memory_proposals SET content_ref = NULL WHERE id = ?",
CLAIM|18|不一致|apps/agent-service/src/production-mcp-memory-writer.ts:45|apps/agent-service/src/production-mcp-memory-writer.ts:40：“export const EXTERNAL_PROPOSAL_REJECTED_TEXT_DAYS = 30;”|export const EXTERNAL_PROPOSAL_REJECTED_TEXT_DAYS = 30;
CLAIM|19|一致|packages/persistence-sqlite/src/data-export/export.ts:505|所以导出里有的提议没有正文|      contentRef === null ? null : requiredText(contentRef, externalProposalTextKey(id));
CLAIM|20|一致|packages/application/src/ports/gateway.ts:56|网关命令只回一个结果编号|  readonly resultRef: string;
CLAIM|21|不一致|packages/gateway-contracts/src/contracts-v2.ts:2332|packages/gateway-contracts/src/contracts-v2.ts:2331：“resultRef: nullable(machineString)”|    resultRef: nullable(machineString),
CLAIM|22|一致|apps/agent-service/src/production-memory-control.ts:1067|memory.external.respond 的结果编号就是这一批的批次号（apps/agent-service/src/production-memory-control.ts 的 #externalRespond：“return { resultRef: batchId, replayed: false };”）|    return { resultRef: batchId, replayed: false };
CLAIM|23|一致|packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:391|概况里的 externalProposals.batches 按批次给出保存和不要各几条|            SUM(status = 'committed') AS committed, SUM(status = 'rejected') AS rejected
CLAIM|24|一致|docs/adr/0233-rule-book-joins-the-data-export.md:47|格式升到 himawari.data-export.v2。v1 的导出文件导入时整份拒绝|1. **格式升到 `himawari.data-export.v2`。**v1 的导出文件导入时整份拒绝（`DATA_IMPORT_FORMAT_UNSUPPORTED`）。依据“记忆可靠性”：v1 文件没有规则，导入后规则手册是空的，主人会以为规则还在。
CLAIM|25|一致|docs/adr/0200-portable-export-of-memories-and-decisions.md:54|机密原文只进口令加密的封存文件|3. **机密的处理：**一段文字只要 `findSensitiveValues` 认出值，或 `containsRestrictedIdentifier` 为真，明文层就放遮盖后的文字；遮盖后仍像机密则放占位符 `[内容含机密，已扣留]`，该条标 `withheld: true`。原文只进封存文件的 `originals`。话题类敏感（健康、财务等）但没有机密值的记忆，按 Andy 的决定放明文层。
CLAIM|26|一致|docs/adr/0200-portable-export-of-memories-and-decisions.md:59|导入只进空库|只导入到没有任何记忆、决定记录、人物、导入批次、整理记录、来源洞察、已处理邮件记录和 Muse 校准记录的空库
CLAIM|27|一致|packages/gateway-contracts/src/contracts-v2.ts:1532|最多 2000 字，和后端上限一致|export const EXTERNAL_PROPOSAL_TEXT_MAXIMUM = 2000;
CLAIM|28|一致|apps/control-center/src/i18n/resources/zh-CN.ts:841|放在原来的「需要你确认」上面|  "memory.page.confirmTitle": "需要你确认 · {count} 条",
CLAIM|29|不一致|packages/persistence-sqlite/src/data-export/export.ts:569|清单 counts 多一项 externalProposals；omitted 里原来那条“本版导出格式还不含这张表”删掉|  put(DATA_FILES.externalProposals, "data", jsonLines(proposalLines), proposalLines.length);
CLAIM|30|一致|packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql:19|收到和处理时间是库里存的格式（2026-11-12T00:00:00.000Z 这样，同表上的 GLOB 约束）|  received_at TEXT NOT NULL CHECK (received_at GLOB '????-??-??T??:??:??.???Z'),
CLAIM|31|不一致|scripts/check-data-export.mjs:17|通过条数下限从 82 提到 104|const REQUIRED = 104;
CLAIM|32|找不到|-|v2 文件没有这张表|-
CLAIM|33|找不到|-|待确认的提议不进任何发给模型的请求|-

未核实：v2 历史导出文件（仓库里只有 v3 的导出代码，读不到 v2 是否含这张表）、待确认提议是否确实不进入所有模型请求（只做了关键词检索，没有逐条追踪模型请求组装路径），以及“任务 P5-3 PR A2”这个编号没有在其他仓库文档里找到。
