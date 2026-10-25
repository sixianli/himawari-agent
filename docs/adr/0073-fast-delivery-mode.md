---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-25"
---

# ADR 0073：用 `DELIVERY_MODE` 开关切换快速交付和完整流程

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

2026-10-25 Andy 说：现在只有 Andy 一个用户，要尽快让完整的产品上线给投资人看，但每改一点都要跑大量测试和演练，时间都花在门槛上，而不是开发和需求沟通上。Andy 要一个开关：打开快速迭代时，只跑基础测试就上线；需要时再切回完整流程。Andy 同意了线程里的方案（“可以”，2026-10-25T10:07Z）。

盘点结果（`.ci-output/fast-mode/2026-10-25-gates-inventory.md`）：

- 第五次生产变更真正的上线步骤只用了 16 分钟，其余两个多小时花在出错后的修订上。
- 第六次生产变更修订了 7 次，服务停了约 57 小时。每次修订都要重新诊断、修代码、在 Hermes 上跑第 0、3、4 层测试、重新冻结操作包（上线用的一整套固定脚本和输入，按摘要批准）、演练、再批准。
- GitHub 上合并进 `main` 必须等 `ci/required`（CI 的总检查），每次 20–55 分钟；2026-10-25 的 19 次运行里 13 次失败或被取消。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **开关是仓库根目录的 `DELIVERY_MODE` 文件**，内容 `fast` 表示快速模式，`full`、其他内容或没有这个文件表示完整模式。只有 Andy 能决定切换。项目说明 `AGENTS.md` 开头就要求先读它；规则全文在 [`.agents/instructions/delivery-mode.md`](../../.agents/instructions/delivery-mode.md)。
2. **快速模式只保留基础检查**：和改动相关的测试、`npm run check`（格式、lint、类型检查、模块边界、密钥扫描）、`npm run build`。仍在云服务器的测试账号或 Hermes 上跑，不在 MacBook 上跑。
3. **快速模式暂停这些规则**：第 2、3、4 层测试和浏览器检查（[ADR 0057](0057-batch-layers-one-two-for-small-defects.md#batch-layers)）；提交说明逐行写 `Layer-0-tests:`（[ADR 0066](0066-layer0-related-tests-declared.md)），`commit-msg` 和 `pre-push` 钩子读到 `fast` 时打印 `DELIVERY_MODE_FAST_SKIP_LAYER0` 放行；提交前的文档严格校验和 Runbook 重新封存；合并前等 CI；生产上的 S0 只读读回、操作包冻结和演练、每次上线的单独授权。
4. **GitHub 合并规则由 Andy 切换**：`scripts/delivery-mode/github-ruleset.sh fast` 只保留“不能删 `main`、不能强推”两条，`full` 恢复“必须走 PR、必须等 `ci/required`”。
5. **上线和回滚各用一条命令**：第七次生产变更照 Andy 的 G177、G179 收尾；之后把操作包压成一条上线命令和一条回滚命令，由 Andy 自己执行，Andy 执行就是授权。
6. **不变的边界**：不在 MacBook 上跑测试；Claude 不登录生产机、不读生产密钥；Hermes 只走封装脚本；不写代码注释；直接依赖版本固定；每个提交都推送。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- **只在每个任务说明里写“这次少跑点”**：不采用。规则散在 `AGENTS.md`、`.agents/instructions/`、钩子和 CI 里，每个线程都要重新说服一遍，第六次就是这样反复卡住的。
- **改 CI 工作流，快速模式下只跑少数检查**：不采用。`scripts/ci/check-policy.mjs` 严格核对工作流和 `ci/policy.json`，改动本身就要走第 3 层；直接让合并不等 CI 更省事，CI 结果照样看得到。
- **环境变量做开关**：不采用。每个线程、每台机器、每个代理都要单独设置，容易漏；提交进仓库的文件所有人读到的都一样。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 上线前不再有完整测试和真机验证，安装、沙箱、进程管理方面的问题可能要到生产上才暴露；靠一条命令回滚兜底，代价是丢掉这次上线之后写入的数据。现在只有 Andy 一个用户，可以接受。
- 文档会暂时落后于代码。快速模式下留下的文档欠账，在提交说明里写 `Docs: deferred (fast mode)`，切回完整模式时一次补齐（规则见 `delivery-mode.md` 的 “Switching back to full mode” 一节）。
- 切回完整模式时，要在 Hermes 上对当时的版本补跑第 3 层和受影响的第 4 层场景，并由 Andy 执行 `github-ruleset.sh full`。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0057：小缺陷批量跑第 1、2 层](0057-batch-layers-one-two-for-small-defects.md#batch-layers)
- [ADR 0066：第 0 层的直接相关测试由脚本推导](0066-layer0-related-tests-declared.md)
- [经验教训：第 0 层漏跑直接相关测试](../lessons.md#layer0-related-tests)

[↑ 返回阅读导航](#contents)
