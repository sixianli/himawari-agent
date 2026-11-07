## 结论

本轮增量（`a22e487e..02cf6f0c`）没有发现会出错的代码问题。合并把 #261/#264 的文件原样带进来，未发现与本 PR 的 ADR 编号、迁移 0078 相冲突。

## 会出错的代码问题

无。

## 说法与代码不一致（信息级，不影响运行）

**信息级｜提交说明（非文件）**
- 问题：作者说上一轮之后“只有” `d863fc6c`、`53d3d16e`、`72acf380`，实际本分支在 `53d3d16e` 之后还有 `ac3b2db0`、`4f08cbba` 两个第 8 轮复核记录提交。
- 证据：`git log --oneline a22e487e..HEAD` 显示 `4f08cbba` 的父提交是 `ac3b2db0`，`ac3b2db0` 的父提交是 `53d3d16e`；`git diff --name-only a22e487e HEAD -- . ':!.agents'` 不包含它们，说明只改 `.agents/reviews/pr-258/`。
- 建议：下轮说明里补上这两个提交，避免漏看增量。

**信息级｜提交说明（非文件）**
- 问题：作者说这段 main“只改了 Hermes runner 的 ADR、runbook、scripts/operations/hermes-runner、hermes-runner-scripts.test.mjs”，这只描述了 #261。#264 还改了 `ci/policy.json`、`ci/policy.schema.json`、`ci/quality-policy.json`、`ci/toolchain-lock.json`、`scripts/ci/{check-policy,install-tools,quality-policy}.mjs`、`docs/adr/0174-...`、`docs/architecture-v0.1.md`、`docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md`、`test/tooling/{ci-optimization,policy,toolchain}.test.mjs`。
- 证据：`git diff --name-status a22e487e HEAD -- . ':!.agents'` 列出了这些文件；对该集合执行 `git diff --stat 72acf380 HEAD -- ...` 输出为空，说明它们与 main 合并提交逐字相同。
- 建议：更正列举，避免误以为只合了 Hermes runner 文件。

## 读代码证实的合并结果

- `git show -s --format=%P 02cf6f0c`：`4f08cbba... 72acf380...`，即 `72acf380` 是本次合并进分支的 main 提交。
- `git diff --stat 72acf380 HEAD -- ci docs/adr/0170-... docs/adr/0173-... docs/adr/0174-... docs/architecture-v0.1.md docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md docs/runbooks/hermes-self-hosted-runner-runbook.md scripts/ci scripts/operations/hermes-runner test/tooling/...` 输出为空。
- `git diff --stat ba915c21 HEAD -- docs/adr/0170-... docs/adr/0173-... docs/runbooks/hermes-self-hosted-runner-runbook.md scripts/operations/hermes-runner test/tooling/hermes-runner-scripts.test.mjs` 输出为空。
- 除 `.agents` 外，`a22e487e..HEAD` 只改了 19 个来自 main 的文件，没有触碰本 PR 的 `apps/`、`packages/`、`test/integration/` 代码。
- ADR：仓库里只有一份 `0173-hermes-runs-only-ci.md` 和一份 `0174-no-github-cache-and-one-day-artifacts.md`，无重号；本 PR 没有新增 ADR 0173/0174。
- 迁移：工作树里只有一份 `0078_sensitive_interceptions.sql`，main 没有并进第二个 0078；`scripts/operations/workspace-lifecycle-audit.mjs:5` 的 `SUPPORTED_SCHEMA_MAX = 78` 与迁移目录最大编号一致，`packages/persistence-sqlite/test/migration-engine.contract.test.ts:21` 也已是 `78`。ADR 0078 与迁移 0078 属不同命名空间，不冲突。

## 侧重检查

- **认证/授权**：`sensitive.interceptions.read` 虽然在 control 里使用服务配置的 owner/agent，但网关注入前会先校验 `authentication.ownerId === message.scope.ownerId`、`subjectId === actor.actorId`（`packages/application/src/services/agent-gateway-v2-service.ts:95-104`），并由 `ProductionThreadGatewayAccessPolicy` 再校验 owner/agent（`apps/agent-service/src/production-http-composition.ts:409-416`）。clear 还额外检查 `actorType === "owner"` 和 scope（`apps/agent-service/src/production-sensitive-interceptions-control.ts:86-96`）。未发现越权读取/清除路径。
- **不合规范输入**：SQLite 侧校验 source/part/category/outcome 枚举、fingerprint 16–64 位十六进制、ISO 时间、分页 limit≤100、单次最多 500 条观察（`packages/persistence-sqlite/src/sqlite-sensitive-interception-operations.ts`）。非法值会使整批写入被拒，而不是写入半截。
- **资源耗尽**：recorder 队列上限 2000，超出丢弃最旧并上报（`packages/application/src/services/sensitive-interception-recorder.ts`）。关闭时先停 runs/model/memory，再 flush recorder，最后关 repository（`apps/agent-service/src/production-service-lifecycle.ts:40` 逆序关闭；`service-main.ts:566-570` 注册顺序），不会出现“库先关、记录后写”。
- **不可撤销操作**：clear 是 owner 会话 + 页面二次确认（`apps/control-center/src/components/sensitive-interceptions.tsx` 的确认区块）；服务端未要求近期重新认证，但本仓库其他 medium 风险命令也未要求，只有 `proactive.observation.start` 例外，因此按现有约定不算缺陷。
- **安全/渲染**：新页面只用 React 文本节点渲染分类、用途、时间，未看到 `innerHTML`/`dangerouslySetInnerHTML` 之类的原文注入点。
- **删除级联**：`threads` 在初始迁移里有 `UNIQUE (owner_id, agent_id, id)`（`0001_initial_product_schema.sql:85`），0078 的复合外键有效；integration 测试也覆盖了删对话级联删记录、保留 `thread_id IS NULL` 的记录。
- **推测/未核实**：proactive 的 `#reportMasked` 会对完整邮件正文多做一次遮盖扫描（`proactive-mail-check-service.ts:188-213`），超大邮件可能增加 CPU；未测量，不判为错误。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。本轮增量本身不碰任何组装模型请求的代码：`git diff --name-only a22e487e HEAD -- . ':!.agents'` 只有 CI/ADR/docs/scripts/tooling 文件。就本 PR 已存在的改动而言，`pi-model-transport.ts:313` 只是把上下文传给 `exchange`，`model-egress.ts:220-222` 是先完成 `redactor(parsed, text)`、再调用 `this.#report(sightings)`，报告结果不参与 `next`。测试明确断言带记录与不带记录发送的请求体相同：`expect(recorded.bodies).toEqual(plain.bodies)`（`prompt-prefix.compat.test.ts:460`）、`expect(recorded.raw).toBe(plain.raw)`（`model-egress.unit.test.ts:508`）。每轮变化的 threadId、指纹、时间只进入报告/数据库，没有进入系统提示、工具定义或历史。按 `.claude/rules/prompt-prefix.md` 第 4、11 条，模型可见内容仍只在末尾追加，本轮改动没有把变化值塞进请求开头。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   不会影响发出去的字节。指纹使用稳定密钥的 HMAC：`production-model-egress.ts:78-86` 用 payload-encryption 材料派生固定 key，`model-egress.ts:198-200` 对 `kind+value` 做 HMAC；不含时间、随机数或数据库顺序。时间只用于 recorder 的 `first_seen_at`/`last_seen_at`（`new Date().toISOString()`），不进入请求体。报告用的 `Map` 顺序不参与序列化请求。唯一会改变同一值指纹的情况是 payload 加密密钥轮换；那是既有占位符行为，变化也只在记录去重/占位符，不改变遮盖算法对同一请求的确定性。测试 `model-egress.unit.test.ts:500-509` 覆盖“记录器失败也不改变字节”。

3. **有没有对应自动检查，反向用例真的会失败吗？**
   合并本身没有自动检查，只能靠 `git diff` 证明与 main 逐字相同；本仓库没有“合并结果必须等于 main”的测试。本 PR 相关代码有检查：`prompt-prefix.compat.test.ts` 的 `[SI-2]` 断言带记录与不带记录请求体逐字节相同；`model-egress.unit.test.ts` 有“记录器抛错仍发送相同字节”；`redaction.unit.test.ts` 有“监听器抛错仍遮成相同字节”；`sensitive-interceptions.test.ts` 有非法枚举、非法指纹、非法时间、limit 101 等反向用例，均断言 `rejects.toThrow()`。`#261`/`#264` 也各自带 `hermes-runner-scripts.test.mjs`、`ci-optimization.test.mjs`、`policy.test.mjs`、`toolchain.test.mjs`。但受工具限制我只能运行 git，不能执行测试，因此“反向用例在删除修复后是否真的失败”**未核实**；作者称 `check:ci-policy` 已通过，也**未核实**。

4. **改动产生/修改的每个值，使用它的地方都能接受吗？**
   逐个核对未发现不匹配：
   - `not_saved` 在服务端被映射成网关的 `notSaved`（`production-sensitive-interceptions-control.ts:58-62`），前端 `sensitiveInterceptionTotal` 用 `counts.notSaved`，两端一致。
   - 记录的 `id` 是 64 位十六进制 `dedupe_key`（`0078_sensitive_interceptions.sql:4`），网关 cursor 的 `machineString` 可接受；`fingerprint` 是 32 位十六进制，落在数据库 `length BETWEEN 16 AND 64`（同文件 19 行）内。
   - `source`/`part`/`category`/`outcome` 在 application 端口枚举、0078 的 CHECK、gateway-contracts 的 enumeration、control-center 的 i18n message id 四处一致。
   - `purpose` 数据库限制 1–64，生产用途值都是短枚举（`chat`、`title`、`memory-capture` 等），不会超长。
   - 迁移编号 0078 与审计脚本上限 78、迁移测试期望 78 一致；未在 `scripts/`、`apps/` 下发现仍写死 77 的 schema 上限。
   - 新网关操作 `sensitive.interceptions.read/clear` 同时出现在 `PRODUCTION_SENSITIVE_INTERCEPTION_OPERATIONS`、gateway contract 的 `schemasByType`、control-center 的可用性判断里，没有“清单里有、后端校验不接受”的 I-73 类问题。

## 未核实

- 本地没有 `origin/main` ref；我以本次合并的第二父 `72acf380`（以及 #261 的合并提交 `ba915c21`）作为 main 的对应版本核对，无法证明远程 main 在 `72acf380` 之后还有别的提交。
- 无法运行测试或 `check:ci-policy`，因此测试实际通过与否、反向用例是否真的会失败，均未核实。
- 超大邮件正文多做一次全文遮盖扫描的实际 CPU 开销未测量。
