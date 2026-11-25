---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amended_by: "docs/adr/0261-external-proposals-follow-restricted-deletion-and-expiry.md, docs/adr/0289-data-export-v5-drops-owner-proposals.md"
date: "2026-11-12"
---

# ADR 0246：其他 agent 的提议进入网页和数据导出，格式升到 v3

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提](#premises)
- [决定](#decision)
- [业界怎么做](#industry)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

[ADR 0228](0228-external-memory-proposals-wait-for-owner-confirmation.md) 定了后端：其他 agent（例如 Muse、Claude Code 这类能通过 MCP 连到 Himawari 的程序）提议的记忆先存进 `external_memory_proposals` 表，叫「待确认」，Andy 在 Himawari 里确认后才保存。那个 PR 为了让改表队列先放行，把网页、每天打分里的提示和数据导出留给了下一个 PR，本 ADR 定的就是这几件事。这个 PR 不改表。

<a id="premises"></a>

## 前提

1. ADR 0228 把剩下的三件事写明了。`docs/adr/0228-external-memory-proposals-wait-for-owner-confirmation.md:123-125`：“网页「设置 → 记忆」顶部的「来自其他 agent」一节：勾选后「保存所选」「不要所选」、全选、单条改了再保存、撤销一批；来源按「自称：Muse」显示；数字按第 4 条的定义。”“每日回顾在待确认条数大于 0 时加一行提示。”“数据导出带上这张表。”
2. 表里每一行的状态和字段有固定的搭配。`packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql:24-28`：“`CHECK ((status = 'pending') = (decided_at IS NULL))`”“`CHECK (content_ref IS NOT NULL OR status IN ('rejected', 'superseded'))`”，另有只有已保存的能指向记忆、只有被替换的能指向替换它的提议、只有已保存或已拒绝的能属于一批。
3. 没被替换的提议，正文摘要不能重复。同文件 31-33 行：“`CREATE UNIQUE INDEX external_memory_proposals_text_index ON external_memory_proposals(owner_id, agent_id, text_sha256) WHERE status <> 'superseded'`”。
4. 客户端固定编号和「不带编号送过」各有一张表。同文件 52-68 行：`external_memory_proposal_keys` 的主键是“`(owner_id, agent_id, client, source_key)`”，`external_memory_proposal_unkeyed` 的主键是“`(proposal_id, client)`”。
5. 拒绝的正文 30 天后删掉，只留摘要。`apps/agent-service/src/production-mcp-memory-writer.ts:45`：“`export const EXTERNAL_PROPOSAL_REJECTED_TEXT_DAYS = 30;`”。所以导出里有的提议没有正文。
6. 网关命令只回一个结果编号：后端返回结果编号和是否重放，网页端的结果类型再多一个状态。`apps/control-center/src/gateway-client.ts:37-41`：“`export interface GatewayClientMutationResult { readonly resultRef: string; readonly replayed: boolean; readonly status: MutationStatus; }`”。`memory.external.respond` 的结果编号就是这一批的批次号（`apps/agent-service/src/production-memory-control.ts` 的 `#externalRespond`：“`return { resultRef: batchId, replayed: false };`”），概况里的 `externalProposals.batches` 按批次给出保存和不要各几条。
7. 数据导出遇到新数据时的先例：[ADR 0233 决定 1](0233-rule-book-joins-the-data-export.md#decision)：“格式升到 `himawari.data-export.v2`。v1 的导出文件导入时整份拒绝”；机密原文只进口令加密的封存文件，导入只进空库（[ADR 0200 决定 3、6](0200-portable-export-of-memories-and-decisions.md#decision)）。

<a id="decision"></a>

## 决定

1. **网页：记忆页最上面一节「来自其他 agent · N 条待确认」。**
   - 放在原来的「需要你确认」上面，两节分开，免得一次点掉两种（依据：用户主权，不让 Andy 误批）。
   - 每条显示正文、分类、「自称：客户端名 · 收到时间」，敏感的标「会按敏感记忆保存」。客户端名是对方自己报的，没有核实，所以写“自称”。
   - 勾选后「保存所选（k）」「不要所选（k）」，有「全选」；单条「改一下再保存」，最多 2000 字，和后端上限一致。
   - 数字定义：N 是表里 `status = 'pending'` 的行数；页面最多列 100 条，N 超过时写「共 N 条，显示前 100 条」。
   - 下面列最近 10 批（`externalProposals.batches`），每批写「时间 · 保存 X 条，不要 Y 条」，带「撤销这一批」。
   - 有待确认时边框用红色（需要 Andy 处理）；只剩可撤销的批次时用普通边框。
2. **逐条结果用这一批的实际条数算，不改网关协议。**点了保存或不要之后，网页记下命令返回的批次号和送出的条数 S。概况刷新后，按那一批的保存条数 X 和不要条数 Y 显示「这一批保存了 X 条，不要 Y 条」；S − X − Y 大于 0 时加「另有 S − X − Y 条没处理成，可能已经在别处处理过，或者还在下面的待确认里」。没处理成的那几条如果还没被处理，仍然列在下面，Andy 一眼能看到是哪几条。全部失败时命令报错，页面显示通用的错误提示。
3. **每天打分：**提醒页的「每天打分」上方，N 大于 0 时加一行「其他 agent 送来的 N 条记忆等你确认。」和「去确认」按钮，点了打开记忆页。只是网页，不改任何发给模型的内容。
4. **数据导出格式升到 `himawari.data-export.v3`。**v1、v2 的导出文件导入时整份拒绝（`DATA_IMPORT_FORMAT_UNSUPPORTED`）。依据“记忆可靠性”：v2 文件没有这张表，导入后待确认的提议和「拒绝过」的记录都没了，同样的话会被重新提议进来。
5. **新增两个文件：**
   - `data/external-memory-proposals.jsonl`：每行一条提议，全部状态都导出（待确认、已保存、已拒绝、被替换）。字段是表里的各列（`id`、`subjectRef`、`client`、`sourceKey`、`textSha256`、`normalization`、`category`、`classification`、`status`、`receivedAt`、`decidedAt`、`batchId`、`memoryId`、`supersededBy`）加上正文 `content`（没有正文时为 null）、`keys`（各客户端的固定编号现在指向这一条的）和 `unkeyedClients`（不带编号送过这段正文的客户端）。
   - `schema/external-memory-proposals.schema.json`：这一类数据的 JSON Schema。
   - 清单 `counts` 多一项 `externalProposals`。
6. **机密：**正文按 ADR 0200 的规则处理，像机密的正文在明文层只放遮盖后的样子，原文进封存文件 `originals["externalProposal/<编号>/content"]`。这种情况下正文摘要 `textSha256` 在明文层写 null，摘要放进 `originals["externalProposal/<编号>/textSha256"]`：一段短的机密正文，光凭摘要就可能被逐个试出来。客户端名、固定编号和 `subjectRef` 按 ADR 0200 的短文字规则处理；占位编号接着库里已有占位的最大编号往后排时，也算上提议、固定编号、不带编号的客户端和规则里已有的占位，免得导入过一次的库再导出时两个不同原文用了同一个占位、导不回去。没有正文的行（拒绝满 30 天、被替换）摘要照常写在明文层。
7. **链接：**正文和任何一条受限（restricted）记忆相同的提议（导出时读出受限记忆的当前文字和历史版本，按提议的规范化方式算摘要逐条比较），以及保存进受限记忆的提议和与它摘要相同的提议，整条不导出，明文和封存文件里都没有，清单 `omitted` 写条数；受限记忆里读不出文字的版本（密文缺失或解不开）没法比较，另在 `omitted` 写条数，不让整份导出失败：它的正文就是那条受限记忆的文字，和受限记忆一样不导出（[ADR 0200](0200-portable-export-of-memories-and-decisions.md#decision)）。其余已保存的提议，指向的记忆没导出（例如已删除）、导入时被跳过、或库里本来就没有记忆链接时，`memoryId` 和 `batchId` 一起置空，提议仍是已保存：没有记忆可撤销，这一条就不该再算在可以撤销的那一批里；`supersededBy` 指向的提议不在导出里时同样置空。
8. **校验：**导入前除已有各项外，还检查提议编号不重复；每行的状态和字段搭配符合前提 2；收到和处理时间是库里存的格式（`2026-11-12T00:00:00.000Z` 这样，同表上的 `GLOB` 约束）；正文被扣留和摘要不在明文里是同一件事；正文的分级和提议的分级一致；同一个客户端的同一个固定编号只指向一条；没被替换的提议摘要不重复（被扣留的摘要从封存文件取出后再查一次，试导入也查）；`memoryId` 在导出的记忆里，`supersededBy` 在导出的提议里；`counts.externalProposals` 和文件行数一致。任何一项不符整份拒绝，什么都不写。
9. **导入：**目标库的 `external_memory_proposals` 也必须为空。正文重新加密存进去，提议、固定编号和不带编号的客户端在同一个事务里写入。正文或摘要被扣留、又没给口令的提议整条跳过，导入报告写 `externalProposalsWithoutOriginal` 条数；跳过的提议被别的提议指着时，那个链接置空。
10. **门槛：**`npm run check:data-export` 加跑 `test/integration/data-export-external-proposals.test.ts`，通过条数下限提到 104（`scripts/check-data-export.mjs` 的 `REQUIRED`）。网页由 `test/integration/external-proposals-browser.test.ts`（真实浏览器）覆盖正向和反向，`npm run check:layout` 加一个「来自其他 agent」场景，检查电脑和手机宽度下不溢出。
11. 不加迁移。

<a id="industry"></a>

## 业界怎么做

- GDPR 第 20 条要求数据“in a structured, commonly used and machine-readable format”（[Art. 20](https://gdpr-info.eu/art-20-gdpr/)）。待确认的提议是 Andy 的数据：其他 agent 替他记下的东西，还没决定要不要。所以和记忆一样，用 JSONL 加 JSON Schema 导出。
- 先例沿用本项目的 [ADR 0233](0233-rule-book-joins-the-data-export.md)：新数据进导出时升格式版本，旧文件整份拒绝，不让 Andy 以为东西都带过来了。

<a id="options"></a>

## 放弃的做法

- **网关命令返回每条的结果。**要改所有命令共用的结果格式（前提 6），只为一个命令。批次条数已经能算出“几条没处理成”，没处理成的那几条也还在列表里，所以不改协议。
- **只导出待确认的。**已拒绝的那几行是挡住同样的话被再次提议的依据，丢了会让 Andy 重复拒绝；已保存的那几行是撤销一批的依据。
- **v2 文件照常导入、提议当空。**和 ADR 0233 放弃 v1 照常导入的理由一样：Andy 会以为都带过来了。
- **摘要一律明文。**短的机密正文可以被逐个试出来，见决定 6。

<a id="consequences"></a>

## 后果

- 旧的 v2 导出文件不能再导入，要用新版重新导出一次。网页导出不设口令，所以像机密的提议在网页导出里只能看，不能导入。
- ADR 0228 留给下一个 PR 的三件事都做完了；上线前 PR A 和本 PR 都要合并。[ADR 0242](0242-external-agents-join-the-memory-hub-through-one-entry.md) 的任务 C 会在这一节上按接入、项目分组，沿用这里的整批确认和撤销。
- 待确认的提议不进任何发给模型的请求，本 ADR 不改模型请求。
  - 2026-11-12 补：[ADR 0242](0242-external-agents-join-the-memory-hub-through-one-entry.md) 决定 9 的“先帮我筛一遍”是例外，见 [ADR 0228](0228-external-memory-proposals-wait-for-owner-confirmation.md) 决定 1 下面的补注。
- 事故清单不加行：这是新功能，不是事故修复。

<a id="references"></a>

## 关联文档

- [ADR 0228](0228-external-memory-proposals-wait-for-owner-confirmation.md)：待确认表和确认、撤销的后端。
- [ADR 0200](0200-portable-export-of-memories-and-decisions.md)、[ADR 0233](0233-rule-book-joins-the-data-export.md)：数据导出 v1、v2。
- [ADR 0242](0242-external-agents-join-the-memory-hub-through-one-entry.md)：记忆中心总方案。

[返回阅读导航](#contents)
