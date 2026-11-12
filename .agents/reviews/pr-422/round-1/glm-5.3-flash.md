矩阵证据文件是一个历史记录。现在我需要检查是否有测试强制要求 `package.json` 与其匹配，并确认已删除的依赖是否真的未被引用。
已删除的插件和 @octokit/app 确实没有代码引用（@fastify/cookie 保留并被 built-in-identity-routes.ts:1 使用）。现在核对锁文件变化。
发现可疑点：installable-node-services.test.ts:469 硬编码了 client 2.0.0。去看上下文。
# 复核报告（基准 5e06602…，目标 8b60792…）

## 发现（按严重度从高到低）

### 1.（高）vitest/@vitest/coverage-v8 升级到 4.1.12 后，`npm test` 的覆盖率门禁必失败
- 文件：`scripts/ci/check-coverage.mjs:102-115`、`ci/coverage-policy.json:5`
- 证据（读代码证实）：`check-coverage.mjs:104` 要求 `policy.provider.version === "4.1.9"`，`:108-115` 硬编码 `vitest: "4.1.9"`、`"@vitest/coverage-v8": "4.1.9"` 并断言 `lock.packages?.[relative]?.version === version`（"locked coverage tool differs"）。新锁文件里 `node_modules/vitest` 是 4.1.12、`node_modules/@vitest/coverage-v8` 是 4.1.12（package-lock diff 已核对），必然断言失败。另外 `createSnapshot`（check-coverage.mjs:158-168）把 `package.json`/`package-lock.json` 的 sha256 记入 `inputs`，已接受的 baseline（coverage-policy.json:22-27）对不上也会触发 "measurement snapshot changed"。`npm test` = `local.mjs --check coverage`（package.json:79），`local.mjs:80` 会执行 coverage 检查。
- 后果：标准验收流程在 coverage 这一步直接断，作者"unit/node-services/contracts/admin-cli 项目都跑过"只能是对着子项目直接跑 vitest，不等于 `npm test` 通过。
- 建议：要么不升 vitest（回到 4.1.9），要么按仓库流程重做 coverage baseline 并同步 `check-coverage.mjs` 与 `coverage-policy.json`——这不是只改依赖声明能完成的改动。

### 2.（高）installable-node-services 集成测试断言 client 2.0.0，重打包后必失败
- 文件：`test/integration/installable-node-services.test.ts:466-471`
- 证据（读代码证实）：测试断言 `runtime-manifest.json` 的 `externalDependencies` 含 `"@modelcontextprotocol/client": "2.0.0"`。清单版本不是硬编码，而是 `scripts/package-node-runtime.mjs:287-303` 从安装后的 node_modules 实际版本生成；platform-node 升到 2.3.1 后清单就是 2.3.1。该测试属于 integration 项目（`ci/policy.json:158-159` 未排除它），`npm test` 运行时由 `scripts/ci/test.mjs:89` 注入 `HIMAWARI_TEST_ARTIFACT`（先 build 工件），会跑到并失败。
- 后果：与作者"mcp-read/mcp-write 集成测试都跑过"不冲突，但完整 integration 没跑；`npm test` 会在这里再失败一次。
- 建议：把断言改成 2.3.1（以及留意 undici/fastify 版本变化是否被其他断言引用）。

### 3.（高）ci/security-exceptions.json 里的 zod 4.4.3 已发布夹具例外与升级后锁文件冲突，发布/工件审查流程会爆
- 文件：`ci/security-exceptions.json:348-397`、`scripts/ci/security-exceptions.mjs:54-62`、`scripts/ci/security-published-fixtures.mjs:32-36`
- 证据（读代码证实）：两条 `published-synthetic-fixture` 例外的 `packageLockPath` 是 `node_modules/@modelcontextprotocol/client|core/node_modules/zod`，锁定 `version: "4.4.3"`、旧 integrity、旧 sourceUrl。新锁文件里这两处嵌套 zod 都是 4.6.7、新 integrity（package-lock.json:1640-1668）。`validatePublishedEntry`（security-exceptions.mjs:54-62）要求锁内同路径同名同版本，否则 `SECURITY_EXCEPTION_DEPENDENCY_UNKNOWN`；`createPublishedFixtureReview`（security-published-fixtures.mjs:33-36）要求 integrity/resolved 完全一致，否则 `PUBLIC_FIXTURE_PACKAGE_SOURCE_CHANGED`。
- 关键点：`npm run check` 的 `check:security-review`（test/tooling/security-review.test.mjs）全部用合成夹具，**不会**拦住这个问题；它在 `assertPublicArtifacts`（security-redaction.mjs:151-157）审查 build 工件时才触发，也就是发布/交付阶段。修复需走 owner 审阅流程重新登记例外（新版本、新文件摘要、新 finding digest），不是本次 diff 能顺手完成的。
- 建议：升级前先评估这条链路；本改动至少要在说明里列出这个待办，否则带病合入会在发布时炸。

### 4.（中）Hermes 运维资格脚本断言 zod==4.4.3，升级后拒绝工作区
- 文件：`scripts/operations/hermes-search-time-qualify.py:146`、`scripts/operations/hermes-source-links-qualify.py:146`、`docs/runbooks/hermes-control-center-upgrade-runbook.md:431`
- 证据（读代码证实）：两个脚本都 `assert ...['version']=='4.4.3','WORKSPACE_DEPENDENCY_LAYOUT_INCOMPLETE'`，runbook 也写"核对 `packages/platform-node/node_modules/zod` 为 4.4.3"。升级后这些资格/切换流程会拒绝新工作区。
- 建议：同步改脚本与 runbook，或在升级说明中声明需要重新资格化。

### 5.（中）文档与规则同代码不一致
- `docs/adr/0021-platform-capability-runtime-isolation.md:27`：决策"固定 `@modelcontextprotocol/client` `2.0.0`"。这次把 client 升到 2.3.1 直接推翻了 ADR 的决定，却没有新 ADR 或对 0021 的修订（读代码证实 ADR 原文；升级是 diff 证实）。
- `README.md:24`、`docs/architecture-v0.1.md:158`：写"Vitest 4.1.9"，现为 4.1.12（读代码证实）。
- `docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:215`："与 Vitest 4.1.9 精确匹配的 coverage provider"，同发现 1 相关。
- 建议：补 ADR/修订；文档统一。

### 6.（低）锁文件里目标之外的包被一起动了，多数可解释，一处存疑
- 证据（读代码/锁 diff 证实）：`node_modules/@opentelemetry/api`（旧锁标记 `dev:true, optional:true, peer:true`）整条消失；vite 8.3.8 带来嵌套 `rolldown 1.2.19`、`postcss 8.5.32`、`nanoid 3.3.20` 升级；`@earendil-works/pi-coding-agent/node_modules/undici`（8.12.3）因根 undici 升到同版本而去重。@noble/hashes 同版本移位，无变化。
- 推测：`@opentelemetry/api` 是 vitest 的可选 peer，旧条目的 `peer:true` 记法更像旧版 npm 写出的；新锁用 npm 11.8.0 重新生成后不再收录。旧锁是否也是 npm 11.8.0 生成无法从仓库内核实（toolchain-lock.json:33 只证明现在要求 11.8.0）。若属实说明旧锁本就不是 11.8.0 生成的，本次重生成带来的格式抖动超出"只改声明"的表述，但方向无害。
- 另一条锁内观察（读锁证实）：vitest 4.1.12 的 peer 元数据把 `@vitest/browser-webdriverio` 写成 `^4.1.11` 而其余 peer 精确 4.1.12——本仓库不安装该包，无影响。

### 7.（备注）上游行为变化无法核实
- fastify 5.12.1→5.12.7（s1-task2 矩阵称 5.12.1 是 trustProxy 修复所需，5.12.7 仍在 v5 线）、undici 8.10.2→8.12.3、MCP SDK 2.0.0→2.3.1（含嵌套 zod 4.4.3→4.6.7）、vite 8.2.2→8.3.8：这些版本间的行为变化我不能上网核实，标「未核实」。仓库侧相关用法：client 的协议版本显式 pin（`node-capability-runtime.ts:361-366`，`versionNegotiation: { pin: "2026-07-28" }`，clientInfo 用固定 "himawari-agent"/"0.2.0"，不来自 SDK 包版本），出口字节不随 SDK 升级漂移（就仓库内证据而言）。

## 侧重检查
我走的最普通流程：拉取改动 → `npm ci`（packageManager 11.8.0，toolchain-lock.json 一致）→ `npm run check`（50 步，数量我逐个数过，与作者说法一致；其中 prompt-prefix、security-review 等检查全部用合成夹具或不含依赖版本断言，能通过）→ `npm test`。结论：**流程在 `npm test` 的 coverage 门禁断裂（发现 1），继续往下 integration 的 installable-node-services 也断（发现 2）**。没有自动化覆盖的路径：security-exceptions 对真实锁文件的校验只在发布/工件审查时执行（发现 3）、Hermes 资格脚本（发现 4）、README/ADR/架构文档的一致性（发现 5）。作者说"唯一失败的 service-orchestration 测试 main 上同样失败"——未核实（我无法运行测试）。

## 必答问题

1. **请求开头**：读代码证实，diff 只动 `package.json`/`package-lock.json`，未触碰任何组装系统提示、工具定义、历史、遮盖的代码；发给模型的内容仍只在末尾追加，每轮变化的值（时间、记忆等）也不受影响。规则要求的 `check:prompt-prefix` 属于 `npm run check`，作者声称已过。结论：不改变模型已见过的请求开头。MCP client 对**MCP 服务器**的握手字节不含 SDK 包版本（`node-capability-runtime.ts:362`、`exa-public-search.ts:343` 均为固定字面量）。
2. **同段文字不同字节**：不会。本次没有任何值进入模型请求；会变的值（如 MCP 握手里的版本）要么是固定字面量，要么根本不发往模型。无时间字段、无顺序敏感的集合被引入。
3. **自动检查与反向用例**：本次改动**没有**对应的自动检查——恰恰相反，仓库里三个既有自动断言（check-coverage、installable-node-services、security-exceptions 校验）会在新版本下失败，而且作者运行的测试子集恰好绕开了它们。`check:security-review` 存在但对真实锁文件的版本匹配没有覆盖（只用合成夹具），反向用例（把例外对应的锁条目改版本）在本 diff 场景下不会在 `npm run check` 中失败——这是检查盲区。
4. **每个值的产生端与使用端**：
   - 删除的 4 个 `@fastify/*` 与 `@octokit/app`：全仓 grep（含 ts/tsx/js/mjs/json/md/yml 等，动态 import、字符串引用）证实零导入；唯一保留的 `@fastify/cookie` 在 `built-in-identity-routes.ts:1` 有 import。**读代码证实：删除安全**（注意 `test/integration/qualification/evidence/s1-task2-dependency-matrix.json` 是历史证据文件，仍记载这些包为资格候选，属历史记录，非活校验）。
   - 升级的 vitest/@vitest/coverage-v8：产生端 package.json，使用端 check-coverage.mjs（**不接受**，发现 1）。
   - 升级的 `@modelcontextprotocol/client`：产生端 package.json，使用端 package-node-runtime.mjs→runtime-manifest→installable-node-services.test.ts（**不接受**，发现 2）、security-exceptions.json 嵌套 zod（**不接受**，发现 3）、hermes 资格脚本 zod 断言（**不接受**，发现 4）。
   - undici/fastify/zod 直接使用端（platform-node 源码）类型与运行时兼容性：未核实上游，仓库内无版本断言指向 5.12.1/8.10.2（hermes 脚本只断言 zod 4.4.3）。
   - `@modelcontextprotocol/server` 2.3.1（apps/agent-service）：使用端 `production-mcp-read.ts:77`，同主版本，作者称 typecheck 与 mcp-read/write 测试通过，仓库内无版本断言；上游 API 差异未核实。
   - 结论：**作者"逐个核对使用端"的说法不成立**——至少四处使用端不接受本次升级。

**总评**：删除无用依赖的判断正确且干净；升级方向合理，但这是一次被仓库自身的版本锁定门禁（coverage 工具版本、runtime 清单断言、安全例外、Hermes 资格脚本、ADR 0021）明确约束的变更，作者只跑了绕开这些门禁的测试子集就宣称通过，"不改任何源码"的目标与仓库现状矛盾。合入前必须先处理发现 1-5，否则 `npm test` 与发布流程都会失败。
