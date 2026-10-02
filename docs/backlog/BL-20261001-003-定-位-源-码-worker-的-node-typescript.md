---
status: "active"
document_type: "backlog"
record_id: "BL-20261001-003"
record_state: "open"
date: "2026-10-01"
updated: "2026-10-02"
priority: "normal"
item_type: "chore"
source_idea: ""
review_after: ""
promoted_to: ""
result: ""
reason: ""
supersedes: ""
superseded_by: ""
---
# 定位源码 Worker 的 Node TypeScript 解析器内部断言

## 目标

查明源码测试的 SQLite Worker 启动导入链为何在 Node 22.22.3 上出现 TypeScript 去类型解析器内部断言，再决定是否调整测试线程加载方式。当前保留原失败，不把一次同版本复跑通过当作根因已解决。

## 来源与证据

按第二轮 Claude 答复 40 的限时定位裁定登记（`.ci-output/handoff/2026-09-28-round2-claude-reply-40.md`，本机交接文件，不在仓库中）。测试入口和固定工具链约束见 [CI 验证设计](../execution/specs/2026-09-03-github-ci-quality-gates-design.md)，云服务器规则见 [ADR 0045](../adr/0045-short-test-temp-root.md)。[SOURCE: docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md]

- 原 unit 第一次 2152 项通过、1 项失败：`production HTTP startup rejection contracts rejects identity discovery escape jwksUrl=http://team.cloudflareaccess.com/cdn-cgi/access/certs`，耗时 1311.083ms，错误为 `Error [ERR_INTERNAL_ASSERTION]: memory access out of bounds`。原 JSON 报告和日志保留在本机证据目录 `.ci-output/tool-execution-audit/2026-09-28/round2/cloud-r36/r39-layer2-unit-vitest.json`（不在仓库中）。
- Node 为 `22.22.3`，可执行文件 SHA-256 为 `e6ec2c188d83d813f81f2de8aea084d74dce603ac1abedd0a30ad941b10087b2`。原运行内存压力累计值 `some` 2322→2323、`full` 2245→2245；运行前后可用内存约 7.3 GiB，没有明显内存不足停顿。
- 同一 HEAD `325ef034542bbd24046f713171156f4f14faa923`、同一三文件补丁 SHA-256 `4882ef1962c6ce1321c30aa76173d3c8ac2cf47f379a28efcf972f43dc287c96`、原并发和 `HIMAWARI_TEST_TIMEOUT_MS=30000` 下，HTTP 文件独立五次各 51/51，unit 整组复跑 2153/2153。逐秒内存和运行结果汇总保留在本机 `.ci-output/tool-execution-audit/2026-09-28/round2/cloud-r36/r40-diagnosis-memory-summary.json`（不在仓库中）：完整 unit 最低可用内存 6.346 GiB，`some` 只增 1 微秒，`full` 不变。
- 静态错误传播从 `SqliteProductStateRepository.open` 经 `SqliteExecutionContext.start`、Worker `error` 事件和 `failAll` 原样拒绝，确认来自 SQLite Worker 启动导入链；源码入口为 `packages/persistence-sqlite/src/sqlite-worker.ts`。这不证明崩溃发生在入口文件本身，导入链内的具体文件仍未知。
- 既有产品构建的两条 Worker 入口为 `sqlite-worker.js`、`sandbox-runtime-digest-worker.js`，项目自有 `@himawari-agent` 模块内非声明 `.ts` 数为 0。完整 `dist/node-runtime` 另含第三方包的 TS 源码和类型测试，不能声称整个目录没有 `.ts`，也未确认产品线程加载了这些源码。此既有构建不是本批最终构建，后者还需复核。

原堆栈的关键路径为：

```text
Function.fail (node:internal/assert:17:9)
parseTypeScript (node:internal/modules/typescript:74:16)
processTypeScriptCode (node:internal/modules/typescript:133:42)
stripTypeScriptModuleTypes (node:internal/modules/typescript:163:10)
ModuleLoader.<anonymous> (node:internal/modules/esm/translators:656:29)
#translate (node:internal/modules/esm/loader:559:20)
afterLoad (node:internal/modules/esm/loader:612:29)
ModuleLoader.loadAndTranslate (node:internal/modules/esm/loader:617:12)
#createModuleJob (node:internal/modules/esm/loader:640:36)
#getJobFromResolveResult (node:internal/modules/esm/loader:353:34)
```

## 未知事实与可选方向

amaro 的越界原因、出错的具体导入文件、是否属于 Node 缺陷均未确认；六次未复现不能排除间歇性问题。

可评审让源码测试使用预编译线程文件，以缩小 Node 去类型解析器参与的范围；这属于测试运行方式改动，须先设计再批准。也可评审其他 Node 版本，但新工具下载须先取得用户批准。当前没有升级、下载、放宽断言或时限。

## 排期

用户 2026-10-02 决定本项算进第二轮（工具执行排查第二轮，长任务条目 R2-D12）。按“已发现缺陷全部修完”处理：先限时复现，复现后再定修法；改测试运行方式要先设计，并提前跑第 3 层完整测试。
