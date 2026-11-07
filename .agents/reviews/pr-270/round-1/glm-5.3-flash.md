# 复核报告：CI 从 Hermes 搬到 OVH VPS（510a445d）

先说材料：我核对了 `git diff 5cedac65..510a445d` 全部 55 个文件，重点读了 `scripts/ci/check-policy.mjs`、`scripts/ci/contracts.mjs`、`scripts/operations/ci-runner/*`（与旧 `hermes-runner` 逐一对比）、`test/tooling/ci-runner-scripts.test.mjs`、`test/tooling/policy.test.mjs`、`.github/workflows/ci.yml/main.yml/quality.yml`、`.github/actionlint.yaml`、`ci/policy.json`、`ci/policy.schema.json`、`docs/adr/0176`、`docs/runbooks/ci-vps-runner-runbook.md`、旧 ADR 0160/0171/0173 的头部，以及 prompt 前缀规则文件。

## 发现（严重度从高到低）

**1（中）test/integration/production-http-composition-process.test.ts:1974-2011 — 「只为让 CI 在新机器上通过」的归因不对，真实原因是基准里早就断了。**
- 读代码证实：产品文字早在 `a701d91e`（2026-11-05，提示词措辞第 1 批，已在基准 `5cedac65` 内）改成了中文（`packages/prompt-catalog/src/runtime.ts:88`：「…不要说整个任务已经成功。」），而这个用例是 2026-11-04 的 `7bf3ebe4` 写的，断言还在找英文 `"Do not claim overall task success"`。所以在基准提交上这个用例在任何机器都会失败——只是 Hermes 的 CI 在 2026-11-06 已被手动停用（ADR 0176 决定第 1 条同学科）没暴露出来。本 PR 的改动方向正确（夹具对准产品真相、不改产品行为），但它说明 2026-11-05 那次改词漏同步了这个 prompt 前缀规则点名的端到端门禁（规则第 75 行）。
- 建议：PR 说明与 ADR 里把归因改准确；以后改提示词文字的清单里加「同步 `production-http-composition-process.test.ts` 的断言文字」。

**2（低）scripts/operations/ci-runner/prepare-vps.sh — 整个脚本没有自动检查。**
- 读代码证实：`test/tooling/ci-runner-scripts.test.mjs` 覆盖了所有改名脚本，但对 `prepare-vps.sh` 一个用例都没有（全文件 grep 无 `prepare-vps`）。needrestart 的 perl 自检（prepare-vps.sh:36-43）、AppArmor profile 文本精确比对、Node SHA-256 常量，全靠 2026-11-07 在 VPS 上人工运行一次的证据（ADR 0176 决定第 5 条、.agents/tasks/hermes-runner/evidence.jsonl 的 HR-10 note）。
- 核实不了的部分：`/usr/sbin/needrestart` 第 1092–1101 行的说法无法核对（代码不在仓库、不能上网）；perl 自检能生效依赖「`do needrestart.conf` 会连带加载 `conf.d/*.conf`」这一前提，仓库内无法证实。方向是安全侧：若前提不成立，自检会宁可误报失败（退出 73），不会放行——但那样 `prepare-vps.sh` 会永远跑不完，值得知道。
- 建议：作者把行号当依据写进说法时应标注「未核实」； perl 自检若未来失效会挡住准备流程，排错说明可提一句。

**3（低）检查-policy 与 runbook 的「升级函数」条件有一处与注释不完全一致的风险已排除，但「标签只在两处定义」措辞不精确。**
- 读代码证实：字面量 `ci-vps` 实际出现在 `.github/workflows/ci.yml`（8 处含矩阵）、`main.yml`、`ci/policy.json`（10 个成员）、`ci/policy.schema.json:64`、`.github/actionlint.yaml`。所谓「只在 contracts.mjs 和 runners.sh 两处定义」其实靠交叉闸门锁住：工作流↔策略逐 job 对比（`check-policy.mjs:358/377`，矩阵成员按 canonical JSON 等值对比 :372），`validateMainWorkflow`（`main-workflow.mjs:48`），以及测试把 `RUNNER_LABEL` 钉到 `linuxRunnerLabel`（`ci-runner-scripts.test.mjs:319`）。功能上没错，但 ADR/说法的表述会低估散布面。
- 建议：改成「标签值只有两处是产生源，其余是受校验的下游字面量」。

**4（低）scripts/operations/ci-runner/mac-runners.sh 的行为变化比作者列的清单多。**
- 读代码证实差异：上传前三步从 hermes 包装脚本改为 `ssh`/`scp -q`，新增 `vps "mkdir -p $REMOTE"`（新失败路径「could not create …」，mac-runners.sh:22-26）、SSH 选项数组、`CI_VPS_SSH` 可覆盖、每条远程命令先验主机名（:19）。这属于搬迁固有的改动，且测试覆盖（pause/resume 的 order 断言 :341-349、上传 3 个脚本 :345、主机名检查 :349），不算缺陷；但作者说「行为除主机名检查、内存上限、防火墙范围外不变」不完整。

**5（信息）「所有 workflow、policy、schema、actionlint 里不再有 hermes-home」— 属实（团员内核实）。**
- grep 证实 `.github/`、`ci/`、`scripts/ci` 目录均无 `hermes-home`；`check-policy.mjs:84` 保留的 `"hermes-home"` 是升级函数识别旧基准所必需的，测试 `policy.test.mjs:785-796` 同时锁住四个文件不含旧标签。`quality.yml` 未加调度且仍用 `ubuntu-24.04`，与「继续停用、另开 PR」一致。

**6（信息）Hermes 已停用注销、ADR 归属关系、旧手册归档 — 仓库内文档一致，实际机器状态未核实。**
- `docs/adr/0160/0171/0173` 头部均改为 `superseded/superseded_by 0176`（git diff 证实）；旧手册移到 `docs/archive/runbooks/2026-11-07-hermes-self-hosted-runner-runbook.md`，新 runbook `supersedes` 它（ci-vps-runner-runbook.md:6）。GitHub/Hermes 上的实际注销只有文档记录。

## 侧重检查（测试覆盖、文档一致性、普通使用流程）

走的流程：新 PR 推送 → `ci.yml` 在 `ci-vps` 上跑 → policy 作业：`scripts/ci/run.mjs` → `check-policy.mjs` `resolvePolicySource`（:1010 升级链：`upgradeArtifactRetention`→`upgradeRunnerLabel`→`upgradeHostedRunnerPolicy`→`validatePolicy`→`validateWorkflow`），若基准还是 `hermes-home` 就整份升级；升级后的策略同时校验当前 `ci.yml`（矩阵成员 canonical 对比 :372）和 `main.yml`；随后 static/test/node-floor/browser/coverage/security 各作业 `runs-on: ci-vps` 派给 VPS 的两个 runner（agent 暂停/恢复入口是 Mac 的 `pause-runners.sh`）。

覆盖结论：
- policy 升级链反向用例在 `policy.test.mjs:744-797`，混写/时限不对/工作流残留都会被拒（实测断言 :772、:780、:781-789 toThrow）；「macOS 未暂停」的反例只断言「不升级」（:776），直接的策略层校验没有这条（`check-policy.mjs` 全文无「mac 必须 paused」断言），实际靠 `validateWorkflow` 的矩阵对比（:372）兜住——成立，但依赖工作流那一层，值得知道。
- 改名脚本（install/register/uninstall/pause/resume、runners.sh 顶层函数、unit 模板、防火墙规则、bwrap 私有挂载空间里的真 install/rollback）覆盖相当充分（上述测试文件 1337 行）。
- 本次流程中**没有**自动覆盖的代码：`prepare-vps.sh` 全文；`mac-runners.sh` 的真实网络路径（测试全用假 `gh`/`ssh`）；`job-completed.sh` 与 `clean-old.sh` 的大部分分支（后者只有 1 个用例）；nft 规则的语义正确性（只有 `nft -c` 语法检查 + 人工验证记录）。

## 必答问题

1. **不会改变模型已见的请求开头。** 本 PR 没有改任何组装发给模型内容的代码（diff 中 `packages/`、遮盖、系统提示均未出现）；唯一产品侧改动是上面第 1 条那个测试的夹具字符串，它本身守住的仍是「只追加、每轮变化只在最后一条消息」（产物 `runtime.ts:88` 未动）。改动后该用例仍验证 `requestHead(...).prefix` 不含提示文字、历史只增长（测试 :1993-2011）。已达 append-only 规则要求。
2. **无。** 新值全是常量（标签、IP、版本、Node SHA）；策略升级是结构化纯函数，`policySha256` 仍按基准原始字节（`policy.test.mjs:760` 已断言）；遮盖、无序集合、时间字段均不涉及。
3. **有，且反向用例确实失败。** 详见上面第 3 段证据行。缺口：`prepare-vps.sh`（含 needrestart 自检、AppArmor、Node SHA）无自动检查。
4. **逐值两端核对通过。** `linuxRunnerLabel`(contracts.mjs:7)：写入基准策略后能过 `policy.schema.json:64` 的 enum，`validatePolicy:229` 与 `main-workflow.mjs:48` 接受，测试钉住一致性；`RUNNER_LABEL`(runners.sh:3) → `register-runner.sh --labels`、`mac-runners.sh LABEL`，测试 :319-328 钉到同一常量；IP(158.69.191.249, mac-runners.sh:6) 与 runbook:90、instructions:24 一致且每条远程命令先验主机名；1.62.1 与 `package.json` 锁一致；`policy.schema` enum 收紧无其他消费方。没发现两端校验不一致的值。

**未核实的说法**（列出即止）：VPS 实机状态（needrestart 配置生效、防火墙规则实际加载、runner 已注销）、`/usr/sbin/needrestart` 行号、Node SHA 常量值、runbook 的 `contract_sha256`。
