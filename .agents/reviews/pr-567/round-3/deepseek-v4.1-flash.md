## 查过的范围

本轮只复核 `c9c5dc25c9f93e13db224b04ceff3d4ee1e5e5c1..2d83c360faa4a7414e41fbb18b0b3bab17f33772` 的增量：两份 evidence 文档的完整 diff、`.agents/reviews/pr-567/` 的增删范围，以及证据指向的代码。读了 `ci-runs-2026-11-15.md`、`ci-speedup-lessons.md`、`ci-tests-split-2026-11-15.md`、`ci-test-timing-2026-11-13.md`、`ci-queue-2026-11-12.md`、`ci-gate-memory-2026-11-13.md`；ADR 0256、0266、0267、0275；事故 I-93、I-95、I-99、I-100、I-102；`ci.yml`、`main.yml`、`merge-queue.yml`、`quality.yml`、`pr-closed.yml`；runbook 第 17、67、180 行附近；以及 `platforms.mjs`、`run-share.mjs`、`run.mjs`、`check-policy.mjs`、`aggregate.mjs`、`main-confirm.mjs`、`ci/result.schema.json`、`ci/evidence.schema.json`、`ci/policy.json` 等相关校验。复核记录文件在稀疏检出中不可读，`git show` 也被包装层拒绝，因此没有核对记录正文；旧代码中增量没碰到、也没被增量改变行为的部分没有整份重读。

## 上一轮意见核对

| 上一轮意见 | 本轮结论 | 依据 |
| --- | --- | --- |
| 1 第 6 条“省掉 9 到 15 分钟”与 ARM 占用时间矛盾 | 已改好 | `ci-speedup-lessons.md:86` 已改成“收益比最初估的小”，run 1 最多提前约 4 分钟、run 2 ARM 空出比 integration-1 开始还晚；按 `ci-runs-2026-11-15.md` 表算，04:48:50−04:45:14≈3 分 36 秒，05:32:45 与 05:32:59 差 14 秒，算术成立 |
| 2 把 `ci/quality-policy.json` 定时开关当覆盖率证据 | 已改好 | `ci-speedup-lessons.md:57` 改为引用 ADR 0267 第 83 行原话，并说 `.github/workflows/` 下没有量覆盖率的定时工作流；`quality.yml` 只有 `workflow_dispatch`，没有任何 coverage 作业 |
| 3 takeaway 第 7 条说“这里靠定时检查发现”但仓库没有 | 已按“仓库外”改写，外部事实未核实 | `ci-speedup-lessons.md:101,118` 明确写“claude.ai 项目里每小时一次的定时任务（不在仓库里）”；仓库内确实没有这个定时任务 |
| 4 第 6 条漏了 `main/confirmation` | 已改好 | `main.yml:49-52` 的作业名是 `main/confirmation`，`runs-on: ci-vps`，只在 `mode == 'light'` 时跑，与 `ci-speedup-lessons.md:24` 一致 |
| 5 17/25/16 分钟写成可由 `ci-runs` 核对，但该文件只有作业起止时间 | 部分修正 | 新增了 `ci-runs-2026-11-15.md:27` 的步骤时间戳，但来源仍是作业日志，日志未归档；见下面意见 2 |
| 6 让 ARM 自己出产物缺“平台清单不接受 linux-arm64”前提 | 部分修正 | `ci-speedup-lessons.md:88` 已补 `platforms.mjs` 的产物平台清单，但仍漏了结果/证据 schema、策略校验、汇总和 main-confirm 的使用端；见下面意见 1 |
| 7 takeaway 第 1 条“每一项优化都先从 GitHub 接口读”不成立 | 已改好 | `ci-speedup-lessons.md:112` 已改成“优化大多先量了数据”，并列出 GitHub 接口、作业日志和本地计时，和前 6 条记录基本相符 |
| 8 作者说“只新增 ci-speedup-lessons.md”，实际还新增了 ci-runs 和复核记录 | 已改好 | 本次作者说法已列出两份 evidence 文档和复核记录；diff 也显示没有代码改动 |

## 意见

### 1（中低）新增的“ARM 自己出产物”前提仍不完整，按文档只改两处仍会被策略、schema 和汇总拒绝

文件:行：`.agents/evidence/ci-speedup-lessons.md:88`；另涉 `scripts/ci/platforms.mjs:15`、`ci/result.schema.json:233`、`ci/evidence.schema.json:116,123`、`scripts/ci/check-policy.mjs:424-450`、`scripts/ci/aggregate.mjs:219`、`scripts/ci/main-confirm.mjs:59`。

问题：文档说“产物平台清单只有 `macos-arm64`、`linux-x64`，要先加上 `linux-arm64` 和对应的 build 作业”。但 `linux-arm64` 这个值在其它直接使用端仍会被拒绝或写死：

- 结果和证据 schema 的 `platform` 枚举都只有两项，证据 schema 还限制 `maxItems: 2`；
- `check-policy.mjs` 要求 build 成员正好是 `linux-x64` 和 `macos-arm64`，并且 build/tests 这类非 macOS 成员必须是 `arch: x64`、`alternateArch` 未定义；
- `aggregate.mjs` 对 browser/tests 消费的产物直接写死 `linux-x64`；
- `main-confirm.mjs` 也只构建 `linux-x64`；
- `testsMembers` 也固定为三个成员、shard 数为 2，文档后面“integration 分三份、第三份放 ARM”同样需要改策略校验和 workflow matrix，不只是产物流。

因此，如果读者只按第 88 行加平台键和 build 作业，ARM 产物仍会在结果校验、policy 校验或汇总阶段失败。

证据（读代码证实）：

- `platforms.mjs:15`：`const ARTIFACT_PLATFORM_KEYS = Object.freeze(["macos-arm64", "linux-x64"]);`
- `ci/result.schema.json:232-233`：`"platform": { "enum": ["linux-x64", "macos-arm64"] }`
- `ci/evidence.schema.json:116,122-123`：`"maxItems": 2`，`"enum": ["linux-x64", "macos-arm64"]`
- `check-policy.mjs:424-426`：`const requiredKeys = check.id === "build" ? ["linux-x64", "macos-arm64"] : ...`
- `check-policy.mjs:445-447`：`member.arch === (mac ? "arm64" : "x64") && member.alternateArch === (arm ? "arm64" : undefined)`
- `check-policy.mjs:153-157`：`testsMembers` 固定为 `integration-1`、`integration-2`、`others`
- `aggregate.mjs:219`：`const platform = "linux-x64";`
- `main-confirm.mjs:59`：`["build", "linux-x64"],`

建议：把“要先解决”的清单补全到这些使用端，或者明确写“这条需要另开方案”，不要只列 `platforms.mjs` 和 build 作业。至少应同时说明：结果/证据 schema 的枚举与 `maxItems`、`check-policy` 的 build/tests 成员和架构校验、`aggregate` 的消费平台、`main-confirm`，以及 `ci/policy.json` 和 `ci.yml` 的 matrix。

### 2（低）新增的步骤用时和作业号没有可独立核对的归档日志，来源说明也只写了 jobs API

文件:行：`.agents/evidence/ci-runs-2026-11-15.md:3,27`；`.agents/evidence/ci-speedup-lessons.md:67`。

问题：新行给出 `04:51:59–05:08:33` 等“执行共享检查”步骤时间，并说“按作业日志里这一步和下一步（publish.mjs）开始的时间戳算”，但仓库里没有这些作业日志。文件开头仍写来源是 GitHub 的 `GET .../jobs` 的 `started_at`、`completed_at`、`runner_name`，没有说明新增数据还来自作业日志。这样 17/25/16 分钟和三个 job ID 只能相信同一段叙述，读者无法仅凭 `ci-runs` 的表格或仓库其它文件复核；上一轮第 5 条只被部分修正。

证据（读代码证实）：

- `ci-runs-2026-11-15.md:3`：`来源：GitHub 接口 ... 的 started_at、completed_at、runner_name，2026-11-15 07:10 UTC 读取。`
- `ci-runs-2026-11-15.md:27`：`... 按作业日志里这一步和下一步（publish.mjs）开始的时间戳算 ... 作业号分别是 132700101275、132700101226、132700101238。`
- `ci-speedup-lessons.md:67`：`integration-1 17 分钟、integration-2 25 分钟、others 16 分钟（只算跑测试那一步，按作业日志时间戳算）`

建议：在来源行明确写“作业起止和 runner 名来自 jobs API，步骤时间来自作业日志”，并把日志里三处步骤起止的原始行或 API 的 job id 对照归档；或者在 `ci-runs` 表格中直接加“执行共享检查开始/结束”两列，让 17/25/16 可以由表格算出。否则至少标成“未核实/来自未归档日志”。

## 侧重检查

- 错误路径和不规范输入：本次只改 Markdown 文档和复核记录，没有改解析、校验或执行代码，未发现新增错误分支；证据不足或来源不明的地方已按“未核实”处理。
- 安全：新增内容只有运行号、作业号、runner 名、时间戳和文字说明，没有密钥、令牌、私网地址或新权限；没有发现新的安全暴露。`claude.ai` 定时任务只是文档描述，仓库无配置，未核实。
- 资源耗尽：ARM 迁移计划仍只把 CPU 负载列为量测项。文档自己写“24 GB 内存基本没用上（未实测内存，按 runner 只有两个推断）”（`ci-speedup-lessons.md:85`），计划第 3 条只说“4 核……每核负载已到 1.45……要先量”（`:89`）；runbook 第 180 行说两个 ARM runner 合计最多用 18 GB，`scripts/ci/test-concurrency.mjs` 又允许 integration 最多 3 个 worker。没有实测数据证明会内存耗尽，这是推测；但把 integration 再加到 ARM 前，内存也应列入“要先量”的条件。
- 不可撤销操作：本次没有部署、删除、迁移或执行命令的改动，文档只描述计划，未发现不可逆操作。
- 规则、说明文档和代码一致性：`main/confirmation`、`main/evidence`、`merge-queue.yml`、runbook 第 17/67/180 行、ADR 0267 第 83 行、`quality.yml` 没有 coverage 定时任务，这些核对一致。`linux-arm64` 使用端不一致见意见 1；`ci-runs` 来源说明与新增日志数据不一致见意见 2。另外查了 `pr-closed.yml`：它写 `runs-on: ci-vps-gate`，但触发条件是 `closed`，作业条件却是 `github.event.action != 'closed'`，实际永不运行；不列进文档可以理解，但如果第 24 行的“另外”本意是列全所有其它工作流，则仍不完整。

## 未核实与推测

- `claude.ai` 项目里每小时一次的定时任务来自仓库外，无法用仓库代码核实；只能确认仓库内没有这个定时检查。
- `ci-runs-2026-11-15.md:27` 的三个 job ID、步骤起止时间，以及 `43680214152` 的 policy 时间、`43671620922` 的 `CI_HOST_LOAD 1.45` 都来自未归档的 GitHub 接口或作业日志，未核实。
- `ci-speedup-lessons.md:86` 说 run 43678751781“ARM 05:32:59 才空出”。按表，05:32:59 是 `ci-arm-1` 的 tooling 结束时间，`ci-arm-2` 的 static 到 05:40:33 才结束；若“ARM”指整台机器，这句话不精确；若指最早一台 ARM runner 空出，则成立，结论“比 integration-1 实际开始还晚”不受影响。这是表述风险，不是已证实的数值错误。
- 把 integration 挪到 ARM 后可能增加内存压力，这是基于 worker 数和 18 GB 上限的推测，没有实测证据；建议把内存列为量测项。
- 复核记录正文和 `usage.jsonl` 在稀疏检出中不可读，`git show` 被拒绝，未核对。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 本次增量只改 `.agents/evidence/*.md` 和复核记录，没有改 `packages/`、`apps/`、`scripts/` 里组装系统提示、工具定义、历史或遮盖的代码；grep 也没有发现代码引用 `ci-speedup-lessons.md` 或 `ci-runs-2026-11-15.md`。文档开头“开源工具线程重新开工时先读这份”只是给线程的阅读提示，不是自动请求注入；即使手动读取，也应作为新增内容，不会改写已发出的前缀。未发现违反“只追加”的地方。
2. **不会让同一段文字在不同请求里变成不同字节。** 新增的是静态 Markdown 里的固定时间戳、运行号、job ID 和说明文字，没有依赖前后文的遮盖、当前时间字段或无序集合的序列化；本次没有代码改动。
3. **没有对应的自动检查。** `test/`、`scripts/` 中没有引用这两个 evidence 文件；本次增量没有测试，也没有反向用例。这些数字只能靠人工复核。
4. **不是所有值的直接使用端都能接受。** `main/confirmation`、`main/evidence`、`ci-vps`、`merge-queue`、runbook 行号和 ADR 0267 第 83 行引文都能对上；`.github/workflows/` 确实没有 coverage 定时任务。不能全部接受的是 `linux-arm64`：`platforms.mjs` 的产物清单、`result.schema.json`/`evidence.schema.json` 的枚举和 `maxItems`、`check-policy.mjs` 的 build/tests 架构校验、`aggregate.mjs:219`、`main-confirm.mjs:59` 都还只接受或写死 `linux-x64`/`macos-arm64`，见意见 1。`claude.ai` 定时任务在仓库外，未核实；job ID、步骤时间和 43680214152/43671620922 的数字没有归档日志，也未核实。
