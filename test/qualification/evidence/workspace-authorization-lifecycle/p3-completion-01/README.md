# P3 文件占用、保存与恢复验收

本批对应 [Plan 的 P3 七项](../../../../../docs/execution/plans/2026-09-16-workspace-authorization-lifecycle-plan.md#p3)；源码冻结后执行最终构建与测试。**P3 七项全部通过。** 最终状态、日志摘要和计数见 [verification.json](verification.json)，标准结果见 [standard-summary.json](standard-summary.json)。

## 行为与证据入口

| P3 要求 | 实现及可重复验证 |
| --- | --- |
| 具体资源集合 | 宿主解析路径槽位、inode 和兼容祖先；目录移动冻结源目录、源槽位和目标槽位三项。`sandbox-host-verifier.unit.test.ts` 检查实际目录身份、链接、目标替换和跨设备；`workspace-claims.unit.test.ts` 检查不同文件、别名与读写相交规则。 |
| 原队列原子准入与公平性 | `sandbox-execution-preparation.test.ts` 在真实 SQLite 中证明两子文件同时准入、目录移动等待、后来冲突请求不能插队、无关文件仍可推进；全部资源一起获取或不获取，取消与出队重验沿用原队列。 |
| 目录改名 | `move_directory` 通过原 Pi 自定义工具端口和 Worker 合同 4 执行。Mac 使用 `renameatx_np(RENAME_EXCL)`，Linux 使用 `renameat2(RENAME_NOREPLACE)`，不覆盖已有目标、不跨文件系统复制；实际目录 inode 与子文件读回、发布间隙恢复及外部替换拒绝均有测试。 |
| 短时提交与完整文件 | 候选仍由原 Pi Operations 在准入前生成，文件合同 3 只在提交阶段占用工作区。`constrained-file-system.unit.test.ts` 使用可控屏障证明不同文件同时在途，读取只能得到完整旧/新版本，旧版本写入不能悄悄覆盖；链接、权限、大小写别名及同文件系统暂存沿用回归。 |
| 持久阶段与部分成功 | `file-publication-recovery.test.ts` 验证第一文件成功、第二文件已发布但 SQLite 未确认、第三文件尚未执行；重启恢复分别保留结果，保留后续人工修改，不整批回滚。目录移动和固定文件结果经 `production-sandbox-lineage.test.ts` 从真实私有日志恢复到原 SQLite/受保护结果。 |
| 确定冲突与原 Pi 续跑 | 只有提交标记之前、没有创建父目录且身份/版本冲突可证实时，才写入确定未发布记录；候选保留，未知效果仍停止。`prepared-file-runner.test.ts` 覆盖固定程序与标记约束；生产工作流测试验证原请求关联、当前权限及次数边界；既有 `pi-runtime-adapter.compat.test.ts` 用真实 Pi 循环读取最新内容、关联重新生成请求并停止持续冲突。 |
| 读取合同与外部写者 | 原 Pi 工具批次保持 sequential，依赖读取等待前序工具；独立请求按具体文件并行。稳定读取与原地写入相斥，原子替换允许完整版本读取。手工写者不受产品锁约束，只承诺测试覆盖的身份/版本冲突检测，不承诺严格文件系统 CAS。 |

## 实际平台范围

Mac 本机 APFS 与 Hermes `/data` 的 ext4 使用各自构建的 `rename-native` 和 Node runtime。真实生产装配入口为 `production-queued-run-restart.test.ts`，分别设置保存、目录移动、保存冲突三种模式；覆盖原 Run 排队后重启、Owner 授权、SQLite、UDS、Worker、Job Host、受保护输出、文件独立读回、资源释放及原 Pi 续跑，并验证撤销后重放不再次写入。

模型、Owner 决定、安装资格和外层 Worker 消息传输使用受控夹具；文件系统、沙箱进程、Payload UDS 和持久库实际执行。固定文件正常结束资格 `fixed-file-terminal-no-writer.v1` 限于匹配安装字节、经过输出核验且原进程已经退出的固定程序。它没有授予生产安装资格，也不证明任意命令的后代进程可被完全终止；中断或未知清理仍保留占用。没有执行生产部署或补记 P1/P7 平台资格。

## 失败证据及修复

原始失败与最终成功日志一起保留，不能把失败夹具或环境前提当成产品失败：

- 队列测试最初 Handle 次数不足、读取了包含释放历史的占用总数；文件屏障调用遗漏原接口的旧内容参数。修正前提后保留相同并发与顺序断言。
- Linux 测试启动的 SRT 来自源码依赖，原 fixture 错误放行了安装包中的 seccomp 目录；修正实际依赖路径，并仅调整隔离测试依赖的可写权限。Mac 的真实 SRT 测试需要在 Codex 外层沙箱之外执行。
- 已验证 Worker 输出为 `application/octet-stream`，JSON 专用读取器误拒绝；改为复用已认证、解密并核验摘要的结果字节。受保护 scope 的 JSON 校验保持不变。
- 重复扫描安装目录使一秒释放证明在 SQLite 接受前过期。现在同一次宿主核验返回观察和证明，仍拒绝过期、身份或事实不符的证明；新增持久回归禁止重复核验。
- 旧排队夹具漏接正式入口已有的结果交付服务，导致真实文件已释放而 Run 仍是未知结果。补齐 `completeSandboxToolResult` 后原完成断言通过。
- Schema 46 暴露迁移序列预期和只读审计器上限仍停留在 45。新回归检查新 writer 边界、历史记录保留及只读工具不改数据库。

## 最终验证

- 标准构建通过；全套 253 文件、4,086 项通过，0 失败、0 跳过：unit 1,887、contracts 347、integration 1,719、e2e 3、Pi compatibility 130。详见 [standard-test-result.json](standard-test-result.json)。
- Linux 文件矩阵 6 文件、138 项通过；两个平台各三项最终安装路径通过。每项 live 命令只选择目标用例，另外 9 项是明确过滤，不计入执行数。
- 冻结输入 1,113 项前后未变；Linux 54 个本次改动输入与本机相同。Mac 标准安装包 SHA-256 为 `8cc8ae2f5415b521bc413909c20319594e8e9adb632e09389cf0bcf8422cdc06`。
- 类型、52 个改动代码/测试文件的格式、依赖边界、需求映射、不变量、敏感信息、CI 策略和严格文档校验通过。未运行远端 GitHub gate；本结果是本地及隔离 Linux 平台验收。
- [raw-logs.tar.gz](raw-logs.tar.gz) 保留 100 份原始日志，逐文件字节和摘要复核通过，重复归档拒绝覆盖原证据。原始标准测试细项位于本机 `.ci-output/p3-completion-01/test-macos-arm64/tests/`。

有一次 Linux 文件矩阵因我未经充分确认就将耗时归因于资格变量而提前停止；第二轮仍观察到 ext4 日志提交等待，故原归因不成立。第一轮记为中止；最终第二轮正常完成 138 项，不删除、跳过或放宽断言。该纠正同时记录于原决策日志。
