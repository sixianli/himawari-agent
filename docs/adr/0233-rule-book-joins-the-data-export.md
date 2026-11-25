---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-11"
covers: "packages/persistence-sqlite/src/data-export/rules.ts, packages/persistence-sqlite/src/migrations/0086_rule_book.sql, packages/persistence-sqlite/src/migrations/0087_rule_book_memory_link.sql, packages/persistence-sqlite/src/sqlite-proactive-operations.ts, test/integration/data-export-rules.test.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0233：规则手册进入数据导出，格式升到 v2

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

[ADR 0200](0200-portable-export-of-memories-and-decisions.md) 定的数据导出（把记忆和决策记录打包带走、还能再导入的功能）不含规则手册（Andy 定的、由程序必定执行的规则，[ADR 0209](0209-rule-book-with-cel-expressions-and-judge.md)）。愿景说规则手册是四样护城河资产之一，[ADR 0209](0209-rule-book-with-cel-expressions-and-judge.md#consequences)、[ADR 0211](0211-hard-rule-points-back-to-its-rule-memory.md#consequences)、[ADR 0213](0213-owner-sentence-becomes-a-standing-rule.md#consequences) 都把“规则手册一并导出”记成以后要做的事。

任务 P2-4 原本要把规则手册导出成 Agent Skills 标准的 `SKILL.md`。线程评估后认为：规则在别的 Agent 里只是文字，没有 Himawari 的程序就不会“必定执行”，所以 SKILL.md 的价值低；真正缺的是 Andy 的数据带不走规则。Andy 2026-11-11 在决定卡上选了“搁置，先补数据导出”，随后对改动清单 `/mnt/project-files/p2-4-rulebook-skill/change-list-data-export.md` 说“按照你的建议来”（同时同意跳过两模型方案讨论）。

<a id="premises"></a>

## 前提

1. 规则存两张表：`rule_book_rules`（当前版本）和 `rule_book_history`（全部版本，只增不改）。`packages/persistence-sqlite/src/migrations/0086_rule_book.sql:1-28`：“`parameters TEXT NOT NULL CHECK (json_valid(parameters) AND json_type(parameters) = 'object')`”，历史表有 `rule_book_history_no_update`、`rule_book_history_no_delete` 两个触发器。
2. 状态有三种，规则可以指回立它的那条记忆。`packages/persistence-sqlite/src/migrations/0087_rule_book_memory_link.sql:245`：“`status TEXT NOT NULL CHECK (status IN ('active', 'needs_review', 'retired'))`”；同文件 301 行起的 `memory_rule_needs_review` 触发器在来源记忆被改或删时把规则标成待重审并写一版历史。
3. 写规则的代码按原样比较参数字符串。`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:354`：“`if (current && current.parameters === parameters) return;`”。所以导入后参数字符串必须逐字节相同，否则下一次保存设置会凭空多出一个修订版本。
4. 每个写规则的地方都先写当前行、再把当前行复制进历史（同文件 365-373 行的 `INSERT INTO rule_book_history … SELECT … FROM rule_book_rules`），所以历史最后一版等于当前行。
5. ADR 0200 的导出已有机密处理：机密原文只进口令加密的封存文件 `originals`，明文层放遮盖或占位（[ADR 0200 决定 3](0200-portable-export-of-memories-and-decisions.md#decision)）；导入只进空库（决定 6）。
6. 内置的两条规则 `floor_public_domain`、`floor_money_words` 写在代码里，不在数据库：`packages/application` 导出的 `BUILT_IN_RULES`。

<a id="decision"></a>

## 决定

1. **格式升到 `himawari.data-export.v2`。**v1 的导出文件导入时整份拒绝（`DATA_IMPORT_FORMAT_UNSUPPORTED`）。依据“记忆可靠性”：v1 文件没有规则，导入后规则手册是空的，主人会以为规则还在。
2. **新增三个文件：**
   - `data/rules.jsonl`：一行一条规则，字段 `ruleId`、`revision`、`status`、`source`、`sourceMemoryId`、`updatedAt`、`parameters`，以及 `history`（全部修订版本，每版另有 `changeReason`、`changedAt`）。`parameters` 是数据库里存的原样 JSON 字符串，不重新排键（前提 3）；最长 262144 个字符（设置允许的最大重要发件人名单约 5 万个字符），超过时导出直接失败，不生成导不回去的包（长度按 Unicode 字符数算，和 JSON Schema 的算法一致）；一条规则连同历史超过单行上限时也一样。
   - `schema/rules.schema.json`：这一类数据的 JSON Schema。
   - `RULES.md`：给人读的规则手册，分“产品自带”“你在设置里定的”“你在对话里立的”三节，每条以〔r:编号〕开头，写类型、条件、第几版、状态和出处，有来源记忆的写〔m:编号〕。开头写“共 N 条存下来的规则，其中 M 条正在执行”。规则文字和出处里的〔〕换成［］，所以〔r:〕〔m:〕只会是生成的标记。内置规则只列出，不进 `rules.jsonl`，也不导入（前提 6）。
3. **机密：**一个版本的参数里只要有一处文字像机密，或者原样字符串不是写规则的代码自己会写出的形式（`JSON.stringify` 的结果，例如带重复的键，解析时会丢掉一部分内容而检查不到），这个版本就标 `withheld: true`，明文层放遮盖后的参数，原样字符串只进封存文件 `originals["rule/<编号>[/history/<版本>]/parameters"]`；出处和修改原因按 ADR 0200 的短文字规则处理。清单里 `withheld.texts`（以及网页响应头 `x-himawari-export-withheld`）因此也把每个被扣留的规则参数版本算作一处，`withheld.rules` 是有扣留版本的规则条数。导入时没有口令或缺原文的规则整条跳过，报告写 `rulesWithoutOriginal` 条数，不导入一条参数被遮过的规则。
4. **来源记忆没导出时**（例如来源记忆已删除或是 restricted），这个链接置空，清单 `omitted` 里写条数。
5. **校验：**导入前除 ADR 0200 的各项外，还检查规则编号不重复、历史修订号递增且最后一版等于当前版本、来源记忆在导出里、未扣留的每个版本都是能执行的规则（类型认识、参数合法）、未扣留的参数是写规则的程序会写出的形式、`RULES.md` 里每条规则那一行恰好一行且行内的〔m:编号〕和数据一致（只核对〔r:〕〔m:〕这两种标记，不核对文字：文字随版本改，核对文字会让新版本导不进旧导出）。用口令恢复扣留的原文之后，再检查一次长度上限和历史最后一版等于当前版本。任何一项不符整份拒绝。
6. **导入：**目标库的 `rule_book_rules` 和 `rule_book_history` 也必须为空；规则和全部历史在同一个事务里原样写入。
7. **网页：**记忆页按钮改叫“导出记忆和规则”（三语），新增响应头 `x-himawari-export-rules`，值是清单里正在执行（在用或待重审）的规则条数；完成提示写这个数。没有规则时是 0，压缩包照样带 `RULES.md`。
8. **门槛：**`npm run check:data-export` 加跑 `test/integration/data-export-rules.test.ts`，通过条数下限从 53 提到 82。
9. 不加迁移。

<a id="industry"></a>

## 业界怎么做

- Letta 的 Agent File 把 Agent 的工具规则（README 原话：“Tool rules | Definitions of how tools should be sequenced or constrained”）和记忆一起放进同一个导出文件（[letta-ai/agent-file](https://github.com/letta-ai/agent-file)），说明“行为规则是 Agent 数据的一部分”。本决定同样把规则和记忆放在一个包里。
- Agent Skills 标准（[agentskills.io 规范](https://agentskills.io/specification)）只要求 `name` 和 `description`，正文是给模型读的文字；它不能保证规则被执行，所以只借它“给人和模型都能读的 Markdown”这一点做 `RULES.md`，不做 SKILL.md。
- GDPR 第 20 条要求数据“in a structured, commonly used and machine-readable format”（[Art. 20](https://gdpr-info.eu/art-20-gdpr/)），`rules.jsonl` 加 JSON Schema 满足这一点。

<a id="options"></a>

## 放弃的做法

- **导出成 SKILL.md（原 P2-4）。**别的 Agent 没有 Himawari 的程序，规则只是建议，和“必定执行”矛盾；Andy 选了搁置。
- **参数按规范 JSON 重新排键。**导入后和写规则代码的原样比较对不上（前提 3），保存一次设置就多一版历史。
- **只导出当前版本。**决策记录引用规则的某一版，丢了历史这些引用就查不到。
- **v1 文件照常导入、规则当空。**主人会以为规则都带过来了；改成明确拒绝。

<a id="consequences"></a>

## 后果

- 旧的 v1 导出文件不能再导入，要用新版重新导出一次。
- 被扣留参数的规则在没有口令的导入里会丢；导入报告写条数。网页导出不设口令，所以网页导出的这类规则只能看，不能导入。
- `RULES.md` 是记录，不是指令；放进别的 Agent 也不会被执行，文件开头写明了。
- 决策记录里引用的规则版本在导出里都能查到。
- 事故清单不加行：这是新功能，不是事故修复。

<a id="references"></a>

## 关联文档

- [ADR 0200](0200-portable-export-of-memories-and-decisions.md)：数据导出 v1，本 ADR 在它的格式上加规则手册。
- [ADR 0209](0209-rule-book-with-cel-expressions-and-judge.md)：规则手册和裁判。
- [ADR 0211](0211-hard-rule-points-back-to-its-rule-memory.md)：规则记着来源记忆、待重审。
- [ADR 0213](0213-owner-sentence-becomes-a-standing-rule.md)：一句话变规则。
- 代码：`packages/persistence-sqlite/src/data-export/rules.ts`、`export.ts`、`verify.ts`、`import.ts`。
- [ADR 0246](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0246-external-proposals-join-the-data-export-and-web.md)：其他 agent 的提议进入导出，格式升到 v3（后续）。

[返回阅读导航](#contents)
