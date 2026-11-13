---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-13"
---

# ADR 0263：“导出全部数据”在一个任务里带上对话，给真实进度，可以取消（部分取代 ADR 0235 的“放弃的做法”第 1 条）

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

iPhone 设置页有一行“导出全部数据”，经网关 v2 的 `data.export.start` 开始生成（[ADR 0200](0200-portable-export-of-memories-and-decisions.md) 的记忆导出）。对话导出是 [ADR 0235](0235-chat-history-export.md) 定的另一个包，只有网页的 `GET /api/data-export/v1/chats` 一个入口。iOS 设计线程要求手机上这一行导出的就是全部数据，并且要有真实计数的进度和取消。网关（gateway，手机和网页调服务器的统一接口）这一侧怎么做由本线程定。

<a id="premises"></a>

## 前提和来源

1. 记忆导出不含对话。来源：ADR 0200 第 53 行：“不导出：……对话、事件段、检索索引。”
2. ADR 0235 当时放弃了“并进同一个包”，理由三条。来源：ADR 0235 第 77 行：“**并进记忆导出的同一个包。**会和正在改同一批文件的 PR 393 冲突，记忆包会变大，512 MB 的上限也会被聊天挤占。”
3. 对话导出在网页上限 128 MiB 荷载，是按内存实测定的。来源：ADR 0235 第 87 行：“据此网页上限定为 128 MiB 荷载（峰值内存约 0.8 GB），超过返回 413 而不是冒着把服务撑爆的风险生成”；代码 `apps/agent-service/src/production-chat-export.ts` 第 18 行 `CHAT_EXPORT_WEB_MAXIMUM_BYTES = 128 * 1024 * 1024`。
4. 打包后的压缩包上限 512 MiB。来源：`apps/agent-service/src/production-data-export.ts` 第 43 行 `MAXIMUM_ARCHIVE_BYTES = 512 * 1024 * 1024`。
5. 两种导出本来就可以同时跑、内存叠加。来源：ADR 0235 第 89 行：“网页聊天导出和记忆导出各有一个‘同时只一份’的标志，两者可以同时跑，内存会叠加”。
6. 愿景要求数据可以完整带走。来源：`docs/product-vision.md` 第 39 行：“数据不落在任何第三方平台的 SaaS 里，且我可完整迁移、备份与删除。”
7. 设计线程的选择（2026-11-13，iOS 设计线程回复本线程的原话）：“选 A。手机上那一行叫‘导出全部数据’，包里就应该是全部，对话不能另走一个口……结果给出对话个数和消息条数，进度里加一段‘对话’。包变大、耗时变长没关系，有进度和取消就行。”

<a id="decision"></a>

## 决定

1. **一个导出任务生成一个压缩包，里面两个并列的文件夹：**`himawari-export/` 是 ADR 0200 的记忆导出，原样不变；`himawari-chats/` 是 ADR 0235 的对话导出，原样不变。两个文件夹各有自己的清单，各自能用 `himawari-admin data inspect` 校验。不把对话塞进记忆导出的文件夹，因为记忆导出的校验会拒绝清单里没登记的文件。网页的“导出”（`GET /api/data-export/v1/archive`）和网关的 `data.export.start` 用的是同一个生成函数，所以网页这个包也带上对话。网页原来的 `GET /api/data-export/v1/chats` 保留，网页的记忆页还在用它。
2. **对话部分沿用 128 MiB 的荷载上限。**超过时整份导出失败，失败原因是 `CHAT_EXPORT_TOO_LARGE`，网页直接下载返回 413；不交出一份缺了对话的“全部数据”。整个压缩包仍不超过 512 MiB。
3. **结果多给两个数：**`conversations`（对话个数）和 `messages`（消息条数），等于包里对话清单的 `counts.threads` 和 `counts.messages`；网页下载的响应头同样多了 `x-himawari-export-conversations` 和 `x-himawari-export-messages`。“被扣留的处数”（`withheld`）把对话部分扣留的文字也算进去。
4. **进度是真实计数，不估算百分比。**`data.export.status.snapshot` 在生成中多一个 `progress`：`stage` 是 `memories`、`conversations` 或 `packing`（正在打包），`sections` 按记忆、对话的固定顺序各一项，给“已读出几段文字、一共几段”（`textsRead`、`textsTotal`）。一段文字是一个加密荷载，例如一条记忆的正文、一个对话标题或一条消息；读出、解密是导出里耗时的部分。还没开始的那一段 `textsTotal` 是 `null`、`textsRead` 是 0，因为在读到那一部分的数据之前不知道总数。生成结束（成功、失败或取消）后 `progress` 是 `null`。契约拒绝已读数大于总数、总数未知却已读、段的顺序不对、非生成中却带进度。
5. **取消命令 `data.export.cancel`，带导出编号。**生成中取消：状态立即变成 `cancelled`，读荷载的循环在下一段文字前停下，不再解密；之后生成即使结束也不会把状态改回 `ready`。已生成的取消：结果立即作废，下载口返回 404。重发取消返回 `replayed`；取消不认识或已过期的编号返回 404；取消已失败的返回冲突（409）。取消之后可以马上重新开始（前一次还在收尾的那几毫秒里开始会得到 `DATA_EXPORT_BUSY`，重试即可）。取消不要求最近验证身份，属于日常操作。

<a id="industry"></a>

## 业界怎么做

- Google Takeout（谷歌的“下载你的数据”）是异步生成：页面原话“this process could take from a few minutes to a few days”，生成好后“we'll email you a link to its location”（[Google Account Help: Download your Google data](https://support.google.com/accounts/answer/3024190)，2026-11-13 读取）。本决定同样是后台任务加下载链接；那一页没有写能不能取消，所以取消这一条不引用它。
- 进度用真实计数而不是估算百分比，是本项目的长期规则：界面上的数字要有可验证的定义（`.claude/rules/owner-standing-rules.md` 的“界面上的数字和验收”）。

<a id="options"></a>

## 放弃的做法

- **保持两个包，手机上分两行导出。**界面上的“导出全部数据”就会和实际内容不一致；设计线程明确不要（前提 7）。
- **把对话文件放进 `himawari-export/` 里。**记忆导出的校验（`verifyIntegrity`）会把清单里没登记的文件当成错误，整份拒绝；改校验又会动 ADR 0200 的格式。
- **对话太大时只导出记忆、照样给 ready。**用户看到“导出全部数据”成功却缺了对话，比失败更糟。
- **按估算给百分比。**没有真实来源，违反前提里的界面数字规则。

ADR 0235 放弃“并进”的三条理由，现在的情况：PR 393 早已合并，冲突不再存在；包变大由设计线程接受（前提 7）；512 MiB 的上限仍在，对话部分另有 128 MiB 荷载上限，挤占的上限是同一个数，所以对话多到挤爆时整份失败并说明原因，而不是悄悄少东西。

<a id="consequences"></a>

## 后果

- 网页记忆页的“导出”现在也带对话，耗时和内存是两者之和；这和两种导出同时跑的情况（前提 5）一样，没有变得更坏。对话荷载超过 128 MiB 的库，网页上的这个导出会失败（返回 413），只能用命令行分别导出。这是为了不交出缺对话的“全部数据”而接受的代价。
- 以后新增的数据种类（感知记录、镜像、设备设置等）按同样做法并进这一个导出任务，各自一个文件夹、各自的清单和一段进度，不再另开入口。
- 不加迁移，不碰发给模型的内容。
- 门槛：`test/integration/data-export-http.test.ts` 里带 `[iOS]` 的用例覆盖包里两个文件夹各自校验通过、对话和消息个数等于对话清单、进度先记忆后对话且已读数是真实计数、生成中取消后不再解密且不会变回 `ready`、打包快结束时取消、已生成的取消后下载 404、取消不认识的编号 404、取消已失败的冲突、对话超过上限整份失败且网页 413；`packages/gateway-contracts/test/data-export-gateway.contract.test.ts` 覆盖进度和取消的契约正反用例。
- ADR 0235 的“放弃的做法”第 1 条原文不改，在那里加了指向本文的说明。

<a id="references"></a>

## 关联文档

- [ADR 0200：记忆和决策记录可以导出](0200-portable-export-of-memories-and-decisions.md)
- [ADR 0235：聊天记录可以导出](0235-chat-history-export.md)
