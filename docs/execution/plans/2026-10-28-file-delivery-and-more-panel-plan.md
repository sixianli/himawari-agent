---
status: active
document_type: plan
supersedes: ""
superseded_by: ""
date: "2026-10-28"
---

# 文件交付和“更多”栏产物页实施计划

依据 [ADR 0100](../../adr/0100-conversation-more-panel-files-and-background-commands.md) [SOURCE: docs/adr/0100-conversation-more-panel-files-and-background-commands.md] 和 [控制中心 Spec 的 v8 增补](../specs/2026-09-15-control-center-v4-design.md#v8-more-panel) [SOURCE: docs/execution/specs/2026-09-15-control-center-v4-design.md#v8-more-panel]（Andy 2026-10-28 11:44 日本时间批准：“原型和方案都审核了，全部按照你的设计和推荐来做！”）。

**目标：** Himawari 在对话里做出的每个文件都登记、留副本、能在“更多”栏和侧栏“文件”页里预览和下载；网页文件在单独子域名里隔离运行。

**分工：** “更多”栏外壳（按钮、右侧栏和底部抽屉）、后台命令页、主界面三处提示和第一版产物页由 PR #63 实现。本计划只做文件交付后端和产物页、文件页；前端部分等 PR #63 合并后基于 main 做，避免两边改同一批文件。

## 阅读导航

- [现状](#现状)
- [第一步：产物登记表和副本](#第一步产物登记表和副本)
- [第二步：读文件和下载接口](#第二步读文件和下载接口)
- [第三步：网页文件隔离预览](#第三步网页文件隔离预览)
- [第四步：让模型只写文件名](#第四步让模型只写文件名)
- [第五步：产物页、文件预览和文件页](#第五步产物页文件预览和文件页)
- [测试](#测试)
- [需要 Andy 的事](#需要-andy-的事)
- [进度记录](#进度记录)
- [收尾](#收尾)

## 现状

以下由代码确认（2026-10-28，main 7b69059）：

- 文件卡片只从过程记录里 `write`、`edit` 工具的参数取文件名和全文（`apps/control-center/src/turn-files.ts`），参数最多 64 KiB，命令做的文件看不到。
- 命令的改动记录（ADR 0097）按“运行 + 工具调用”存成加密的 `run_payload_artifacts`（用途 `trace`），每条改动有路径、类型、新建/修改/删除、前后大小和 SHA-256；不存文件副本，也不发给浏览器。
- 加密存储可以复用：`PayloadProtectorPort` + `PayloadStorePort`（`EnvelopePayloadProtector`、`HybridPayloadStore`，小的放数据库、大的放加密文件）。
- 网关没有任何返回文件字节的接口；每个请求都要求 `Host` 等于唯一的 `publicOrigin`，安全策略是 `default-src 'none'`、`frame-ancestors 'none'`、`X-Frame-Options: DENY`，没有第二个域名的配置。
- 登录校验：Cloudflare Access 的 `cf-access-jwt-assertion` 加 `himawari_session` 会话，两者都要（`ProductSessionAuthenticationService`）。

## 第一步：产物登记表和副本

- 新迁移 `0060_thread_artifacts.sql`（0059 归 PR #63）：表 `thread_artifacts`，每行一个文件版本：编号、对话、运行、轮次、工具调用、来源（`write`、`edit`、`bash`、后台命令）、命令原文、相对路径、文件类型、大小、SHA-256、版本号、加密副本引用、时间。同一对话同一路径的版本号递增；内容指纹没变就不加新版本。
- 登记时机：`write`、`edit` 成功之后；命令（含后台命令）的改动记录写好之后，取其中新建和修改的文件。删除只记在命令详情里，不删已有副本。
- 跳过：`.git`、`node_modules`、受保护条目（ADR 0097 的清单）和常见缓存目录；单个文件超过 32 MiB 只登记不留副本，预览里写明“文件太大，没有留副本”。
- 读文件沿用 ADR 0097 的主机侧只读读取方式（逐级打开、不跟随符号链接、不跨设备）。改动记录现在是“扫描比较大小和修改时间、再单独读一次算 SHA-256”；登记时改为只读一次，同一份内容既算 SHA-256 又存副本，避免两次读之间文件又被别的命令改掉，造成指纹和副本对不上。
- 同一个文件被改多次：
  - 一条命令里改了好几次：命令前后各扫一次，只能看到命令结束时的样子，记一版；中间状态不保留（要保留就得在命令运行时监视文件，代价大，不做）。
  - 多条命令先后改同一个文件：每条命令结束时内容变了就记一版，版本号递增，每版写明是哪条命令；内容和上一版一样就不加新版，只在那条命令的详情里列出这个文件。
  - 两条后台命令同时运行、改同一个文件：两条命令的改动记录都会列出它，分不清是谁改的。登记时按结束先后记版本，并在这一版上标明“运行期间还有其他命令在改”，不猜是哪一条。
- `schema-catalog.ts` 登记新表；`migration-engine.ts` 追加迁移。

## 第二步：读文件和下载接口

- `POST /api/files/v1/list`：按对话列出产物（给产物页），或跨对话按类型、文件名列出（给文件页）。要登录、校验来源和 CSRF，和现有查询接口一样。
- `GET /api/files/v1/content/{artifactId}?version=N`：返回文件字节。要登录；只按登记表编号放行，不收路径；`X-Content-Type-Options: nosniff`；图片和 PDF 用 `inline`，其余用 `attachment`；网页文件在主站域名上只能下载，不能直接打开。
- 现有安全策略加 `img-src`、`object-src` 允许本站读文件接口，供图片和 PDF 预览。

## 第三步：网页文件隔离预览

- 新配置 `previewOrigin`（暂定 `https://himawari-files.siyi.win`，上线前由 Andy 定）。
- 主站先调 `POST /api/files/v1/preview-ticket` 换一个签名链接：只对这一个文件版本有效，5 分钟过期，用服务器上的密钥签名。
- 网关遇到预览域名的请求只认这一种路径，校验签名后返回网页内容；响应头用 `sandbox allow-scripts`（不给 `allow-same-origin`）、`frame-ancestors` 只允许主站、不带也不读任何登录信息。主站安全策略加 `frame-src` 允许预览域名。
- 预览域名不放进 Cloudflare Access 的登录拦截（内嵌框里没法登录），靠签名链接把关；这一点请正在做公网安全审查的线程复核。
- Cloudflare 上要加一条 DNS 和隧道路由：属于改 Cloudflare 设置，要 Andy 批准后由 Mac 远程会话做。

## 第四步：让模型只写文件名

- `apps/agent-service/src/production-run-policy.ts` 的能力说明加一句：做出文件后在回答里只写文件名，不写服务器路径，界面会自动显示文件卡片；系统提示的缓存键从 `run-system-instruction:v4` 升到 `v5`。

## 第五步：产物页、文件预览和文件页

PR #63 合并后，基于新 main：

- PR #63 已经做了栏外壳和一版产物页（用现有 `write`、`edit` 记录按轮列出，没内容不显示）。在它的产物页上改为读登记表、接上预览，不另做一套；回答下方的文件卡片也改为读登记表，命令做的文件也出卡片；同一轮超过 3 张卡片时折叠成“还有 N 个文件”。
- 文件预览在 ADR 0091 的基础上加图片、PDF、网页（隔离框）、版本切换、下载、“来自「对话名」第 N 轮 →”。
- 侧栏“记忆”下面加“文件”页。
- 命令详情里的“改动的文件”接上登记表。
- 中文、英文、日文三份文字。

## 测试

按 `DELIVERY_MODE`（当前 fast）和测试层规则，只跑相关测试、`npm run check`、`npm run build`。新增：

- 登记：`write`、`edit`、命令、后台命令各自产生正确的版本；内容没变不加版本；一条命令改多次只记一版；两条命令先后改同一文件记两版；两条后台命令同时改同一文件时那一版带“还有其他命令在改”标记；超过 32 MiB 不留副本；指纹不一致不登记；跳过目录生效。
- 接口：未登录 401；别的编号拿不到；路径参数不被接受；网页文件在主站只能下载；签名过期、改过、换了文件都被拒；预览域名上只有预览路径能用。
- 端到端：真浏览器里让 Himawari 写一个网页文件，产物页出现、隔离预览能运行、拿不到主站 Cookie；三种语言各看一遍。

## 需要 Andy 的事

- 预览子域名：Andy 2026-10-28 14:16（日本时间）定为 `himawari-files.siyi.win`（原话“子域名可以”）。
- 上线时的 Cloudflare 步骤（Mac 远程线程做，Andy 在那个线程里亲手打一句授权后才动手）：
  1. 在 `siyi.win` 区域给 `himawari-files` 加一条指向现有隧道的 DNS 记录（隧道的公共主机名），回源到生产机 `http://127.0.0.1:8400`，和主站同一个服务。
  2. 确认 Cloudflare Access 的应用只拦 `himawari.siyi.win`，没有覆盖 `himawari-files.siyi.win`（内嵌框里没法登录）；不要给它加 Access 应用。
  3. 生产 `/etc/himawari/config.json` 的 `http` 里加 `"previewOrigin": "https://himawari-files.siyi.win"`，改前先备份，改后重启服务。
  4. 验收：主站打开一个模型写的网页文件，预览框能运行；直接打开 `https://himawari-files.siyi.win/` 返回 404；在预览页里读不到主站 Cookie。
  5. 请做公网安全审查的线程复核这个子域名。
- 上线照旧并入“完整版本”。

## 进度记录

2026-10-28，后端第一步到第四步完成（分支 `claude/project-thread-3hdzxk`，基于 main 332a7ae）。和上面写的计划有这些不同：

- 每个版本有自己的编号，读文件接口是 `GET /api/files/v1/content/<编号>`，下载加 `?download=1`，不用 `?version=N`；`POST /api/files/v1/versions` 列出同一文件的各版本。
- 登记表没有存“命令原文”和“轮次”：每行有运行编号和工具调用编号，界面从已有的过程记录找到对应的命令和轮次，不重复存。
- 不和改动记录里的 SHA-256 比对：登记时自己读一次文件，用这一份字节算指纹并存副本。
- 副本存在加密过程记录（`run_payload_artifacts`）里，操作键 `runtime-file-read:<键>:artifact-copy:<指纹>`。
- 主站安全策略只加了 `frame-src 'self' <预览域名>`；读文件接口单独用 `frame-ancestors 'self'` 和 `X-Frame-Options: SAMEORIGIN`，让 PDF 能在本站内嵌框里显示。预览页的安全策略允许 `https:` 的脚本和样式（模型写的网页常用外部库），但 `connect-src 'none'`，页面不能向外发请求。
- 新配置 `http.previewOrigin` 可不填；不填时预览接口返回“未安装”，其他功能照常。必须是 https 来源，且不能和主站同一个主机名。上线包模板暂不改，等 Andy 定子域名后再加。
- 第四步的说明加在运行系统提示里，缓存键 `run-system-instruction:v5`。

2026-10-28，第五步网页部分完成，照 Andy 批准的 [v8 原型](../../assets/control-center/2026-10-28-v8/desktop.dc.html)做。和上面写的不同或补充的地方：

- 列表接口每条加了 `turn`（这次运行在对话里的第几轮，查询时按运行创建时间现算，不存进表）、`toolItemId`（对应过程记录里那一步工具调用，用来找到命令原文）和 `commandKey`（后台命令产生的文件，填那条后台命令的编号）。配置接口加 `filesAvailable`、`filePreviewAvailable` 两个开关，网页据此决定显示“文件”入口和网页预览。
- 后台命令做出的文件放在它汇报的那一轮下面（和原型的“第 4 轮 · 后台命令 npm test”一致），不放在启动命令的那一轮。
- 登记表里没有、过程记录里有的文件（例如登记功能上线前的旧对话）照旧从过程记录出卡片，能看全文和改动，但没有版本和下载。
- 网页文件和 SVG 只在配好预览域名时用隔离框打开；没配时写明“网页预览还没开通”，可以下载。文本文件超过 2 MiB 不在预览里读，只给下载。
- 侧栏“记忆”下面加“文件”入口；文件页每个文件只列最新一版，按今天、昨天、更早分组，可以按文件名搜索、按类型筛选；从文件页打开的预览，点“来自「对话名」第 N 轮 →”会进入那个对话并定位到那一轮。
- 读文件列表的数据结构单独放在 `apps/control-center/src/registered-files.ts`，因为接口客户端也被后端的类型检查引用，不能连带引入只在浏览器里能用的代码。

2026-10-28，公网安全审查线程复核预览子域名时发现：没配 `http.previewOrigin` 的服务收到 `himawari-files.siyi.win` 的 POST 请求（如 `POST /bootstrap`、`POST /api/identity/v1/sessions`），会走到登录凭证校验才被拒；这个子域名前面没有 Cloudflare Access，只剩应用这一道。修复：网关在收到请求时先看 Host，不是主站的一律 403，只放行 `/health/*` 和预览域名上的 `GET /preview/<签名链接>`，不分请求方法。

2026-10-29，预览栏补上 Word（`.docx`）和 Excel（`.xlsx`），PDF 改用 pdf.js 逐页渲染，不再用浏览器自带查看器的内嵌框（Andy 看过九个方案的实跑对比后同意，[ADR 0114](../../adr/0114-file-preview-pdf-word-excel-in-browser.md)）。网页通过新的 `bytes` 读法从同一个读文件接口拿字节；读文件接口为 PDF 内嵌框加的 `frame-ancestors 'self'` 和 `X-Frame-Options: SAMEORIGIN` 不再需要，但没有坏处，暂时保留。真浏览器检查用 `scripts/test-file-preview-browser.mjs`。

## 收尾

- [ ] 测试结果写进提交说明和 PR。
- [x] BL-20261026-013 已转入本计划（2026-10-28）。
- [ ] ADR 0091 的后续状态改好。
- [ ] 案例库[案例 36](../../engineering-casebook.md#case-more-panel)补上结果数据。
- [ ] 本计划完成后用 `git rm` 删除，不归档；旧版本在 git 历史里。
