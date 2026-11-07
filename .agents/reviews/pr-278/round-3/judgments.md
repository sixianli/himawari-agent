# PR 278 第 3 轮逐条判断

连续第三轮有中高意见，按 .agents/instructions/model-review.md 第 4 步：本轮意见先改，改完不再复核，停下报告 Andy。

已改（未复核）：
- d1 中高：cookie 按主机名不按端口隔离。改为连 Hermes 时用 localhost，不用 127.0.0.1。
- d2 中：一次性 ssh 不走 magpie-prod 配置块，端口被占时不退出而是留下 root 命令行。改为 ssh -N -o ExitOnForwardFailure=yes。
- d3 中：带密码的地址进浏览历史。改为登录后删掉那条历史；不用无痕窗口，否则 cookie 关窗即失效。
- d9 低：grep 输出带等号，改文字。
- d12 低：补网址编码提示。

不改：
- d4 可以更好：改生产配置的备份和回退属于授权后的操作步骤，不是连接方法；本节已指向授权规则。
- d5 不成立：Hermes 自 2026-11-01 有 magpie-test 容器，只绑 127.0.0.1:3425 和 3430（.agents/tasks/hermes-runner/artifacts/hr4-after.txt 有 magpie-test 和 127.0.0.1:3430 的记录）；ADR 0142 写于 10-31，早于安装。
- d6 低：文档已写重试现象和停用命令。
- d7、d8、d10 可以更好：Andy 的 Mac 上已按这些配置实际连通（curl 得到 401），补 IdentityFile 或完整 plist 不改变任何事实。
- d11 不成立：validate_docs 的报错是 “contract_sha256 does not match the current Runbook and contract sources”，正文也算进摘要。
