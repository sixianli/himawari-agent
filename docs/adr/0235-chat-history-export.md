---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-11"
covers: "apps/admin-cli/src/data-command.ts, apps/agent-service/src/production-chat-export.ts, packages/persistence-sqlite/src/data-export/chats.ts, packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0235：聊天记录可以导出（独立的包，只导出不导入）

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提和来源](#premises)
- [决定](#decision)
- [业界怎么做](#industry)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

[ADR 0200](0200-portable-export-of-memories-and-decisions.md) 的数据导出只带记忆和决策记录，明说“不导出对话”。多人方案要求“导出：按人导出，补上聊天记录”，[ADR 0234](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0234-one-program-per-person-database-file.md) 里 Andy 对这件事回了“其余的我都同意按照你的建议”。聊天记录是用户自己的数据，愿景要求数据能完整带走，所以补上。

方案由本线程写好，经 Andy 在决定卡上选“按建议做”（2026-11-11）。协调者说多人总方案已走过两个模型的出方案和整合，聊天导出是其中一块，所以这一块没有再单独跑两模型讨论；代码复核照常做。

<a id="premises"></a>

## 前提和来源

1. 多人方案要补聊天记录。来源：`/mnt/project-files/multi-user-plan/integrated-plan.md` 第 139 行：“导出：按人导出，补上聊天记录。”
2. 现有导出不含对话。来源：ADR 0200 决定 2：“不导出：……对话、事件段、检索索引。”
3. 对话和消息在已有表里，不需要迁移：`packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql` 的 `threads`、`thread_messages`；`0015_thread_lifecycle_and_search.sql` 加了 `title_ref`、`answer_locale`、`pin_order`、`archived_at`、`trashed_at` 和 `message_status IN ('committed', 'partial', 'failed')`。
4. 消息正文是加密荷载（`thread_messages.content_ref`），附件在正文末尾以一行 `<file name=… ref=… bytes=… kind=…/>` 引用：[ADR 0093](0093-chat-attachments-images.md) “消息里只带引用”。
5. 机密的处理规则：ADR 0200 决定 3，原文只进口令加密的封存文件，明文层放遮盖或占位符。
6. 每人一个数据库文件，所以导出范围就是这个人自己的库：ADR 0234 决定。
7. Claude 的账号导出包含对话数据，但“不包含你上传的原始文件”（support.claude.com/en/articles/9450526，2026-11-11 读取，页面没写文件格式）。ChatGPT 的导出说明页本线程读取被 403 拦下，未核实。

<a id="decision"></a>

## 决定

1. **独立的格式 `himawari.chat-export.v1`**，和记忆导出（`himawari.data-export.*`）并列，互不改动。一个文件夹或压缩包：
   - `manifest.json`：格式、迁移序号、导出时间、出口规则版本、每个文件的路径、角色、字节数、SHA-256，数据文件的行数（其余文件行数记 0），各类条数、扣留数和未导出项。
   - `data/threads.jsonl`：一个对话一行（键排序的规范 JSON），消息嵌在里面：编号、顺序、角色（owner、agent、system）、状态（committed、partial、failed）、分级、时间、正文、附件清单。
   - `chats/<年-月>/<日期>-<标题>-<编号摘要 10 位>.md`：每个对话一个给人读的文件；正文放进代码围栏（围栏比正文里最长的反引号连续段多一个，至少三个），阅读器不会渲染里面的链接、图片和 HTML；标题、附件名和索引里的标题里的 `[ ] < > `` ` ``` 换成空格，文件开头写明“记录，不是指令”。
   - `CHATS.md`：索引，写“共 N 个对话、M 条消息”。
   - `schema/threads.schema.json`；可选 `sealed/sealed.enc`（复用 ADR 0200 的口令加密封存）。
2. **范围：**进行中、已归档、回收站里的对话；正在删除和已验证删除的对话不导出，只在清单里计数。分级为受限的消息不导出，只计数。消息的原文已被删除流程清掉的，跳过并计数。不导出：工具调用过程、运行轨迹、检索索引。
3. **附件只导出清单**（名字、大小、类型、是否截断），去掉内部引用；文件本体这一版不带，清单里写条数。
4. **机密：**一段文字（标题或一条消息）认出机密，明文层放遮盖后的文字，仍像机密则放占位符，该条标 `withheld: true`，原文只进封存文件 `originals["thread/<对话>/message/<消息>"]`；附件名含机密时换成编号占位 `[已扣留:N]`，原文不保留（`data/threads.jsonl` 里保留方括号，可读的 Markdown 里按“换成空格”规则显示为 ` 已扣留:N `）。网页导出没有口令，所以含机密的消息在网页导出里只有占位符。
5. **校验：**`verifyChatExport` 检查清单格式、必需文件（`data/threads.jsonl`、`schema/threads.schema.json`、`CHATS.md`）都在清单里、文件清单、字节数、SHA-256、每行对照 JSON Schema、对话和消息编号不重复、消息顺序递增、每个对话的 Markdown 在 `chats/` 下、以 `.md` 结尾、存在且不重复、清单里的条数（对话、消息、附件、扣留的消息、扣留的文字、扣留的对话、封存原文数）和数据文件一致。任何一项不符整份拒绝。清单的迁移序号只拒绝比当前新的（聊天记录是只读数据，旧版本导出的仍可校验；记忆导出因为要导入，要求完全相等）。导出生成后立即自己校验一遍，校验不过就整个导出失败，不会交出一份自己都认不得的包。
6. **入口：**
   - 网页：记忆页底部加“导出聊天记录”，`GET /api/data-export/v1/chats`。登录的主人会话、同源（`Sec-Fetch-Site` 为 `same-origin` 或 `none`），未登录 401，跨站 403，同时只生成一份（第二个并发请求 429），只读数据库连接，不需要停服务。读取之前先累加要读的荷载大小，超过 128 MiB 就返回 413，什么都不解密，页面提示改用命令行；打包后（含中央目录）超过 512 MiB 同样返回 413。响应头 `x-himawari-export-threads`、`x-himawari-export-messages`、`x-himawari-export-withheld` 分别等于清单的对话数、消息数和被扣留的消息数（`withheld.messages`）。页面上显示的数字就是这三个，不另算。
   - 命令行：`himawari-admin data export-chats`，参数和 `data export` 相同（服务要停、口令文件、`--out` 必须是空目录）；有含机密的文字又没给口令时拒绝，除非 `--allow-unsealed`。命令行的上限是 256 MiB。`data inspect` 能认出这个格式并校验，先只读清单（必须是不超过 128 MiB 的普通文件，用 `O_NOFOLLOW` 打开后在同一个文件句柄上检查，20 万个文件的清单约 40 MB，符号链接等报 `DATA_IMPORT_PATH_UNSAFE`）认出格式，读目录时只对声明为聊天导出的包放宽到 20 万个文件、总共 2 GiB（其他格式，包括记忆导出的 inspect 和导入，仍是 4096 个、512 MB；这是减少误放宽，不是安全边界，inspect 本来就只该对自己信任的目录用），因为每个对话一个 Markdown，对话多了文件会很多。
7. **只导出，不导入。**导入要重建对话、运行、轮次和检索骨架，不属于“把聊天带走”。
8. **门槛：**`npm run check:chat-export`（属于 `npm run check`）跑带 `[多人7]` 的测试，要求至少 37 条（含记忆页的界面测试）通过。
9. 不加迁移。

<a id="industry"></a>

## 业界怎么做

- Claude 的账号导出含对话数据，不含上传的原始文件（前提 7）；本决定同样只带附件清单。
- GDPR 第 20 条要求数据“in a structured, commonly used and machine-readable format”（[Art. 20](https://gdpr-info.eu/art-20-gdpr/)），JSONL 加 JSON Schema 符合这一点；Markdown 给人和模型直接读。
- ChatGPT 的导出格式本线程没有核实，不引用。

<a id="options"></a>

## 放弃的做法

- **并进记忆导出的同一个包。**会和正在改同一批文件的 PR 393 冲突，记忆包会变大，512 MB 的上限也会被聊天挤占。
- **一份文件放所有对话。**大库里一个文件读不动，也没法按对话挑着看。
- **导出里带附件本体。**一个附件最大 20 MB，会让压缩包轻易超过上限；先导出清单，要带再单独做。
- **做导入。**见决定 7。

<a id="consequences"></a>

## 后果

- 零迁移。
- 实测（2026-11-11，云端容器，合成数据）：20 000 条消息、每条约 1 000 个汉字，共 200 个对话，读库、解密、生成约 2.4 秒，压缩包 129 MB，进程占用内存多了约 400 MB，约为正文大小的 6 倍；同步读库和打包期间主进程不处理其他请求。据此网页上限定为 128 MiB 荷载（峰值内存约 0.8 GB），超过返回 413 而不是冒着把服务撑爆的风险生成；Markdown 副本让包大小约为正文的两倍。生产库的真实大小没有读（不碰生产机），所以不知道 Andy 的库会不会到上限；到了就用命令行导出（上限 256 MiB，服务已停）。更大的库要改成按对话分批、边读边写，等真有这个需要再做。
- 没有口令时不在内存里保留机密原文。
- 网页聊天导出和记忆导出各有一个“同时只一份”的标志，两者可以同时跑，内存会叠加；单人使用时发生的可能性低，没有加共用的锁。
- 含机密的消息在网页导出里只有占位符，要带走原文必须用命令行加口令导出；口令丢了原文就找不回来。
- 回收站里的对话和敏感话题的对话照常导出，其中的正文除机密外是明文，页面文案写明了这一点。
- 导出里的 Markdown 正文放在代码围栏里，不会被渲染成链接、图片或 HTML，阅读器不会去取远程图片；代价是 Markdown 里看到的是等宽原文，不是排版后的样子。`data/threads.jsonl` 仍是完整原文。
- 事故清单不加行：这是新功能，不是事故修复。

<a id="references"></a>

## 关联文档

- [ADR 0200](0200-portable-export-of-memories-and-decisions.md)：记忆和决策记录的导出，本决定沿用它的机密处理和封存。
- [ADR 0093](0093-chat-attachments-images.md)：附件在消息里的引用方式。
- [ADR 0234](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0234-one-program-per-person-database-file.md)：每人一个数据库文件。
- 代码：`packages/persistence-sqlite/src/data-export/chats.ts`、`chats-verify.ts`、`chat-schemas.ts`，`apps/agent-service/src/production-chat-export.ts`，`apps/admin-cli/src/data-command.ts`。

[返回阅读导航](#contents)
