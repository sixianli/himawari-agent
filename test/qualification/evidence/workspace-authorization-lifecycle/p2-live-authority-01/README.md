# 执行中的当前权限、披露与受控停止

复用 Agent 的持久调用回执、现有受认证 Payload UDS 通道和资源恢复调度。没有复制 Grant 到 Worker、增加第二次额度消费、创建新的授权入口或改变 Pi 循环。

- [生产装配失败前](composition-red.log)：有效委派在执行前因缺少授权存储而失败。生产 Worker 现通过 `payload.invocation.validate` 查询 Agent 当前权威，检查本身不读取正文，不签发可缓存的执行权。
- [解密期间撤销失败前](disclosure-red.log)：原实现返回了撤销后解密完成的字节；现在返回正文前重新核验。
- [真实 UDS 与 SQLite](integration-first.log)：Grant 撤销、Handle 撤销、期限到达均阻止继续使用；重复校验不再次消费额度，原结果仍可保存和独立读回。外部服务和模型未调用。
- [入口、运行时及通道消费者](consumers-final.log)：78 项通过。覆盖生产装配、远程外发前拒绝、官方 MCP SDK 调用前拒绝、不支持新校验的旧服务拒绝执行、伪造/过期响应身份及拒绝调用方添加 Grant 字段。
- [资源发现失败前](stop-red.log)：运行中撤销后没有停止任务；[修复后的完整恢复文件](stop-final.log)46 项通过，覆盖 direct/worker 两种 SQLite 执行模式、Grant/Handle/能力撤销、未绑定禁止启动、有限停止失败后暂停且保留占用。首次修复运行的六项失败来自新测试读取了未绑定预约不具备的投影字段，已改用独立 SQLite 占用查询，保留原日志 `stop-green.log`。
- [事件流挂起失败前](active-stop-red.log)：权限撤销后没有发出停止；[工具回归](active-stop-final.log)覆盖等待期间继续核验、一次停止、停止发送失败、未知效果、禁止重复执行及受保护诊断。校验沿用原 50 毫秒事件查询节奏，实际发现时间还取决于存储响应，不承诺瞬时跨进程撤销。停止等待上限沿用协调器 30 秒边界，通知并非真实停止证明。
- [相邻 SQLite/沙箱回归](integration-green.log)87 项通过；之后扩展的资源发现和通用停止由上述定向回归覆盖。

[原始正式报告](standard-first/local-summary.json)：构建通过，247 个文件共 3,956 项测试，3,955 通过、1 项安全矩阵测试因旧 MCP 名称引用失败。修正唯一 fixture 后，[矩阵复验](matrix-final.json)通过；[组合验证](verification-composition.json)检查全部 1,081 个输入仅该 fixture 变化，复用其余 3,955 项及构建，未重复全套运行。类型检查、任务范围内 `biome lint --error-on-warnings` 与 `biome format`、边界/安全/CI policy 和四份 Runbook 检查通过。额外 `biome check` 含项目标准命令未启用的 import 排序，报告保留为 `lint-complete.log`，不等同于标准 lint 失败；未扩大修改到既有 import 排序。完整计划、目录授权撤销全部路径、跨 boot 续排、只读网络重试、真实平台停止与联合 UI 验收仍待完成。所有宿主停止与远程调用端口采用受控输入；SQLite 和 UDS 为实际执行。
