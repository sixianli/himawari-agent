---
status: active
document_type: plan
supersedes: ""
superseded_by: ""
date: "2026-09-10"
---

# 控制中心真实本机验收实施计划

**来源：** [SOURCE: docs/execution/specs/2026-09-10-control-center-local-acceptance-design.md]

## 任务

1. [x] 核查分支、现有测试失败、正式运行与凭据合同；取得本次独立运行目录及 1 美元费用授权。
2. [x] 以先失败后通过的回归测试修复共享总时限和超时错误报告，执行完整项目测试。
3. [ ] 准备正式本机安装、身份、钥匙串和实际合格工具配置，启动 Worker 与 Agent Service。
4. [ ] 用真实浏览器验收模型、工具、多轮、审批、停止、断线与重启恢复，记录费用。
5. [ ] 核查静态检查、文档与实际结果，本地提交并报告运行入口和剩余限制。

## 边界与证据

CI 改动限于测试运行器及其直接回归测试；真实运行使用独立本机目录，仓库中只提交运行帮助和脱敏证据。上轮归档文档保留其当时未验收的事实，本轮证据单独记录。

## 当前验证与待决项

共享时限与终止原因的回归测试已完成先失败后通过验证；3 个相关测试文件共 61 项通过。完整 policy/tooling 检查为 23 个文件、565 项通过；`npm run check`、文档严格校验及安装 Runbook 静态合同通过。当前安装产物的 8 项构建检查通过。

完整五项目最终检查通过：183 个文件、1,914 项测试，0 失败、0 跳过、0 重试，耗时 487667 毫秒。分项为 unit 787、contracts 266、integration 787、e2e 3、pi-compat 71。integration 本轮实际耗时 317348 毫秒，越过旧 300 秒限制后正常完成。完整报告为 `.ci-output/local-1789041051666/test-macos-arm64/result.json`，脱敏副本保存于验收证据目录。这是 macOS 本机自动化验证，不代表真实模型、审批和本机登录验收。

正式 HTTP 每次请求依赖 Cloudflare assertion，现有 bootstrap 不提供本机登录。已在来源 Spec 写明仅 loopback 的本机身份扩展方案，并按用户要求等待确认。当前未创建 `~/.himawari-local`、未新增钥匙串项、未调用收费模型。真实工具的安装资格仍须以当前主机实测建立，不能使用现有测试资格。

脱敏证据保存在 `test/qualification/evidence/local-acceptance-2026-09-10/`；公开模型目录已单独核对，不能用旧模型价格估算本次真实验收费用。完整 policy 初次执行发现治理快照中有 Finder `.DS_Store`，从校验目录移出该系统元数据后重跑通过，没有放宽快照白名单或修改上游副本。
