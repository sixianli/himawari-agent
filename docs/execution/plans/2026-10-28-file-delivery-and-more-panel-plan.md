---
status: active
document_type: plan
supersedes: ""
superseded_by: ""
date: "2026-10-28"
---

# 文件交付和“更多”栏产物页实施计划

依据 [ADR 0100](../../adr/0100-conversation-more-panel-files-and-background-commands.md) [SOURCE: docs/adr/0100-conversation-more-panel-files-and-background-commands.md] 和 [控制中心 Spec 的 v8 增补](../specs/2026-09-15-control-center-v4-design.md#v8-more-panel) [SOURCE: docs/execution/specs/2026-09-15-control-center-v4-design.md#v8-more-panel]（Andy 2026-10-28 11:44 日本时间批准）。

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

- 预览子域名的名字，和在 Cloudflare 上加 DNS、隧道路由（不放进登录拦截）的批准。
- 上线照旧并入“完整版本”。

## 收尾

- [ ] 测试结果写进提交说明和 PR。
- [x] BL-20261026-013 已转入本计划（2026-10-28）。
- [ ] ADR 0091 的后续状态改好。
- [ ] 案例库[案例 36](../../engineering-casebook.md#case-more-panel)补上结果数据。
- [ ] 本计划完成后用 `archive_doc.py` 归档。
