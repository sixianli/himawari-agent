# v4 Hermes 上线记录

## 结果

2026-09-16（日本时间）将已确认 v4 源码提交 `0600b2958432a4592a52e5c01cf92794a7af7121` 部署到 `https://himawari.siyi.win/` 对应的 Hermes `himawari.service`。安装根为 `/opt/himawari/releases/2026-09-16-v4-0600b29`，正式运行账号仍为 `himawari`。没有变更模型、身份设置或数据库 schema，没有重新导入历史。

## 可核验证据

- `build.json`：固定 Linux 工具链构建结果及源代码、安装和资源摘要；六个新版浏览器文件与此前本地验收产物逐字节一致，另保留旧版带哈希的资源。
- `platform-probes.json`、`qualification.json`、`protected-runtime-probe.json`：六组 Linux 实际安装验证、正式账号写入拒绝与签署结果。Pi 22 项、允许网络 10 项、拒绝网络 7 项、公开搜索 3 项；组合和 Worker 崩溃清理通过。公开搜索使用无密钥的合成查询，不调用付费模型。
- `backup-verify.json`、`cutover.json`：完整恢复点 `before-v4-0600b29-2026-09-16` 验证通过，随后 Agent、Worker 就绪；原安装保留。
- `postflight.json`：实际服务挂载对应新安装，19 个 HTTP 静态文件摘要相符，HTTP ready、schema 32、外键正常、无活动 Run 或未释放沙箱。配置唯一变化为本次签署的 `capabilityDeployment` 快照。
- `history-before.json` 与 `history-after.json` 完全一致：36 个会话、148 条消息、86 个 Run、14,681 个 Payload、14,185 个运行时历史 artifact、1 个 Fork 记录。数量一致与备份完整性是本次证据，不等同于逐条语义复核全部历史。
- `browser-observations.json`：通过现有真实 Chrome 登录会话观察生产 UI。新建、草稿恢复、设置、语言切换、实际模型滑块、会话菜单均已检查；未修改搜索授权或既有会话，未发送新消息。最后一次刷新复核遇到浏览器控制通道超时，如实保留限制。
- `deployment-helpers.zip` 与 `.sha256`：本次冻结执行脚本及验收辅助程序。归档中的安装脚本严格绑定本次输入，不能改日期后直接复用于其他发布。

## 执行中发现与处理

Cloudflare SSH 传输中断时，线上服务保持原状；改用既有 Tailscale 通道，重新核验完整归档后才构建。HTTP 回读脚本的初版遗漏 Host、并错误请求 `/index.html`，分别被既有网关以 403、404 拒绝；按实际 HTTP 合同改用正式 Host 和首页 `/` 后通过。未修改产品或削弱摘要断言；记录见 `postflight-initial-failures.json`。

用户已批准的临时 sudo 实际到期为 `2026-09-16T01:22:45Z`（日本时间 10:22:45），规则自身带到期限制并由既有定时清理任务删除，不自动延长。

## 验收范围

本次未新增付费模型预算，没有发起付费模型请求。真实模型的新一轮回答、审批后执行与新增时长记录仍需单独实际调用复测；不能用原型、已有历史或隔离浏览器测试替代该证据。此前本地 3,365 项安装包测试、浏览器验收与视觉核对仍见上一层 `verification.md`，本次没有把这些历史结果写成生产环境重新运行。
