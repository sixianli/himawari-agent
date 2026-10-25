# P4：SRT 工作副本入口与隔离证据

本批只证明已列出的行为。P4 尚未全部完成；原目录保存尚未接入原 Run/Worker 队列。以下结果不构成生产资格证书或部署结果。

- [Mac 实际结果](macos-result.json)：副本修改成功；原内容与管理清单不可读，尝试写入后宿主文件和清单不变。监督/清理为 `lost/unknown`，保留未知结论。
- [Linux 实际结果](linux-result.json)：同样的文件结果；本次监督/清理为 `released/confirmed`。Linux 可以写入隐藏路径的私有影子文件，宿主独立读回才是是否越界的判据。
- [Owner Gateway 回归](raw-logs.tar.gz)：实际创建、选择、准备服务和生产 Gateway 装配，验证身份拒绝、跨会话拒绝、状态修订、重放、撤权、恢复原目录路由及选择后的 Bash 路由；不包含浏览器登录或真实模型调用。
- [相关消费者回归](raw-logs.tar.gz)：10 文件、254 项通过，覆盖 Worker 生命周期、既有文件服务、Scope、工具及 HTTP 装配；随后新增 Gateway 装配断言见上一项。
- [产品输入摘要](source-freeze.json)：集中构建/测试前的 40 个改动产品与测试输入；后续文档和结果归档单独核对。

真实探针复用 `test/integration/production-workspace-copy.test.ts`，设置 `HIMAWARI_LIVE_SANDBOX_PROBE=1` 和 `HIMAWARI_QUALIFY_INSTALLED_RUNTIME` 后，通过实际 Agent Payload UDS、生产 Worker 执行驱动、SRT Job Host 和 Pi Bash runner 执行。安装资格、模型/Owner 身份由夹具控制；任务没有调用付费模型。Bash 工具链取自测试主机已有可执行文件，固定在任务测试安装目录并纳入 runtimeDigest；没有安装 Apple container，也没有给产品增加 PATH 回退。

实际调用：

```sh
HIMAWARI_LIVE_SANDBOX_PROBE=1 \
HIMAWARI_QUALIFY_INSTALLED_RUNTIME=<本次测试安装目录> \
HIMAWARI_P4_COPY_EVIDENCE=<不存在的结果文件路径> \
npx vitest run --config vitest.workspace.ts --project integration \
  test/integration/production-workspace-copy.test.ts -t 'keeps source'
```

Hermes 另设 `HIMAWARI_LIVE_HOST_PARENT=/data`，在挂载的数据盘中创建并清理短名称的测试专属目录。Unix socket 路径过长会在 Job Host 启动前快速失败。Mac 的宿主进程检查需在允许访问进程信息的执行环境运行同一测试。

失败日志按原次序保留：Mac 01～05 涉及执行环境/工具链和诊断，06 首次通过，07 为最终隔离断言；Linux 01 为任务目录权限错误，02 的影子文件判据错误，03～06 排查 bridge socket 长度，07 在 `/data` 再次确认影子文件与宿主文件不同，08 为修正判据后的最终通过。临时诊断只改测试 checkout，结束后与本地源码摘要一致。文件服务测试和实际 SRT 探针分别报告。

`prepare` 只生成逐文件计划，未写入原目录。完整保存链路仍需原队列的短时占用、授权重查、取消、部分结果和恢复验收；不能通过安装旧的直接 `host.file.execute` 来绕过这些要求。

[标准本地验证](standard-summary.json)及[完整测试结果](standard-test-result.json)：255 文件、4,111 项通过，零失败、零跳过。产物公开扫描通过；托管 CI 和部署未执行。完整运行前后 40 个产品/测试输入摘要一致。四份 Runbook 静态合同及严格文档检查通过；全目录格式检查仍有两份此前未跟踪原型文件的问题，详见[本批结果](result.json)。

各次 `.log` 文件保留在[原始日志归档](raw-logs.tar.gz)中，按本文给出的文件名查阅；归档由原 CI 工具生成，安全解包后逐字节读回一致。
