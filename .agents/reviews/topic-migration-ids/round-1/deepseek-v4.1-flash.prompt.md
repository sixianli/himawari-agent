你是独立的方案设计者。
你能用的工具：read、grep、glob、websearch、webfetch，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。
下面只给了问题、目标和约束，没有给出任何人的方案；材料里如果提到某种做法，只作参考。先读代码弄清现状，再独立提出你认为最好的方案，不要假设已经有人想好了答案。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
输出格式：先列方案依赖的前提，每个前提附来源（文件:行或网址）和原话；再写方案本身、考虑过但不选的做法及原因、风险和反例、需要人拍板的取舍。把「读代码或来源证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 61984fb18be8a3499b345f21e0d811c0ba045c0f。
问题、目标和约束：
# 问题：数据库迁移编号排队，成了全项目的开发瓶颈

请从问题本身出发，自己读代码、上网查业界做法，提出你认为最好的完整方案。不要局限于任何现成思路；下面只讲问题、目标、约束和已核对的事实，不含任何倾向。

## 问题

Himawari 用 SQLite（单机文件数据库），产品库的结构变化靠按序号排列的迁移文件。几十个线程（并行的开发代理）同时开发，凡是改表的 PR 都要由协调者分配“正式迁移号”；前一个合进 main 之后，下一个才能改号、重跑 CI、再合并。现在排队的有 10 个以上 PR。所有者要求根治，不要表面修补。

## 目标

1. 各 PR 不再需要别人分配编号，可以并行合并（任意先后）。
2. 两个迁移真正冲突时（例如都改同一张表），能在合并前自动发现，而不是靠人排队。
3. 已有的 0001–0095 和唯一一台生产库能平滑过渡，不丢数据，上线和回滚的安全检查不削弱。

## 约束

- 只有一个生产库（一台机器），上线一律从 main 打包；另有一台测试服务器可能跑分支版本。
- 原则优先级：用户主权 > 边界与可逆性 > 记忆（数据）可靠性 > 效率。不能为了快牺牲数据安全。
- 不写死能动态得到的值；不加代码注释；方案要写清业界怎么做、我们为什么这样做、放弃了什么。
- 不花钱买服务（例如不能依赖 GitHub 付费功能）。

## 已核对的事实（文件:行）

- `packages/persistence-sqlite/src/migration-engine.ts:79` 起是手写数组 `bundledMigrationFiles`，每条有 sequence、name、changeSet、phase、file；每个新迁移都要在数组末尾加一条。
- 同文件 `validateDefinitions`（约 764 行）要求 sequence 从 1 连续；`validateLedger`（约 852 行）要求库里的记录也从 1 连续且与定义按下标逐条对上（名字、阶段、摘要）。
- `applyMigrations`（约 1000 行）：只跑 `migrations.slice(currentSequence)`，即“库里最大号之后”的；已有库迁移前必须有同机快照。
- 记录表 `schema_migration_ledger(sequence INTEGER PRIMARY KEY, name, phase, digest, applied_at)`，另有 `schema_metadata` 的 `current_sequence`、`minimum_writer_sequence`；`assertWritableSchema` 用整数比较，老程序遇到新库拒绝写入（回滚保护）。
- 整数版本号还被这些地方使用：`scripts/delivery-mode/make-packet.py:119`（`target_schema` 要求文件号连续）、`:155`（`migration_ledger` 用正则解析 migration-engine.ts 的数组，并检查迁移有没有碰“受保护的表”）；`scripts/delivery-mode/packet-template/s0-db/read-s0-db.mjs:79`、`maintenance/S9-control-files.py:236`（要求 ledger 是 1..N）；`packages/persistence-sqlite/src/sqlite-recovery-point.ts:961`、`sqlite-authority-transfer.ts`（备份清单里的 schemaSequence 必须等于当前程序的）；`packages/persistence-sqlite/src/sqlite-worker.ts:144`；`scripts/operations/workspace-lifecycle-audit.mjs:5` 的 `SUPPORTED_SCHEMA_MAX = 95`，由 `scripts/check-audit-schema-range.mjs` 要求等于最新迁移号（事故 I-46）；若干测试写死 95。
- 正在排队的分支里，迁移文件互相碰撞：例如 0094_paired_devices、0095_perception_records、0096_web_push_gate、0096_mcp_connections、0097_device_actions、0095_owner_proposals、0095_apple_push 等（分支名 origin/claude/project-thread-*）。
- 实测哪些表被重建：`decision_ledger` 的 `kind` 列用 `CHECK (kind IN (...))` 枚举（见 `migrations/0095_correction_propagation.sql:23`）。SQLite 不能修改 CHECK，加一个新种类就要按 SQLite 官方“12 步”重建整张表，连带重建引用它的子表（一个迁移 600 多行）。已合并的迁移里 decision_ledger 被重建过 9 次；排队的 10 个迁移里有 4 个又在重建它（web_push_gate、perception_records、proactive_source_registry、device_actions）。

## 一手资料（可自己再查）

- Rails 迁移指南 https://guides.rubyonrails.org/active_record_migrations.html
- Django 迁移 https://docs.djangoproject.com/en/5.2/topics/migrations/
- GitLab 迁移规范 https://docs.gitlab.com/development/migration_style_guide/
- Flyway outOfOrder https://documentation.red-gate.com/fd/out-of-order-224919730.html
- Atlas 执行顺序 https://atlasgo.io/versioned/apply ，目录完整性 https://atlasgo.io/concepts/migration-directory-integrity
- goose 乱序迁移 https://pressly.github.io/goose/blog/2021/out-of-order-migrations
- SQLite ALTER TABLE https://www.sqlite.org/lang_altertable.html

## 要你给出

根因（不止一个的话都列）、完整方案（编号方式、库里怎么记录、怎么判断哪些要跑、回滚保护怎么保持、冲突怎么在合并前自动发现、上线打包脚本和备份怎么改、0001–0095 和生产库怎么过渡、排队中的 PR 怎么迁过来）、放弃了哪些做法和原因、风险。
