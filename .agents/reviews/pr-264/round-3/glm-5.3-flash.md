上一次提交仅涉及 ADR 0174 文档。现在我来看一下整个 PR 的 diff 内容，以排查一致性问题。
本次增量仅涉及文档，但它引用了代码事实。我来核对一下 ADR 0174 引用的事实与代码是否一致，并查看 PR 中更改值的调用方。
ADR 引用的内容与 shore 代码一致。现在我来核对剩余引用的事实：`quality.yml` 的 runner、CI 计划编号、其他残留的 30/7 文档，以及 PR 检查所依据的两条规则文件。
ADR 0174 后果第 1 条引用 CI 计划里的实测数字 120.6 / 77.9 秒，刚才在那份计划文件里没搜到。再核对一下这个文件和数字写法，并确认 docs 里是否还有别的「做法一样」类声明要核对。
剩下的几个小核对：仓库里还有没有 `actions/cache` 残留、export-evidence 读的是哪份政策、CI 是否真的会跑这些检查。
最后核对 `quality-policy.mjs` 里对 `toolchain` 参数的使用，确认没有引用被删除的 actions/cache 条目。
# 复核结论

本轮增量（dacfff49..d8d6ba53）只有一个提交 d8d6ba53，只改 `docs/adr/0174-no-github-cache-and-one-day-artifacts.md` 两处：后果一节的出处从 ADR 0173 改为 ADR 0160，关联文档加一行 ADR 0160。作者的说法与 git log 一致（d8d6ba53 确是 dacfff49 之后唯一提交，且只动了这份文档）。

## 侧重检查（先查的部分）

我走的最普通使用流程：**一个普通 PR 过 CI**——推送 → `ci.yml` 跑策略检查（`ci/policy.json:19` 该检查的项目是 tooling）→ `resolvePolicySource` 用 `git show` 读基准提交上的 `ci/policy.json`（本 PR 基准上是 30/7）→ `upgradeArtifactRetention` 升成 1/1（scripts/ci/check-policy.mjs:989-993）→ 按当前 schema（`const: 1`）校验通过；同时 quality-policy 合同比对工作流（全部 `retention-days: 1`，ci.yml 17 处、main.yml 2 处、quality.yml 13 处，grep 整数一致）。

沿途覆盖情况：
- 新增/修改的 3 个 tooling 测试都在 `ci/policy.json:243` 的 tooling 项目 include（`test/tooling/**/*.test.mjs`）之内，CI 会跑。
- `check-policy.mjs` 里 `upgradeArtifactRetention` 有正向（30/7→1）和反向（14/7 被拒）用例（test/tooling/policy.test.mjs:697-710）。
- `quality.yml` 里由 `check:ci-policy` 命令实际驱动这个流程的具体步骤命令，我没有在读到的工作流内容里逐一确认，标**未核实**（测试文件本体被 tooling 项目覆盖是证实的）。

## 发现的问题（按严重度从高到低）

**中（本 PR 无法自证、留给后续的风险面，作者已披露但值得记录）
- 文件：test/tooling/policy.test.mjs:697-710、scripts/ci/export-evidence.mjs:110
- 问题：三个反向用例缺位——①「30/7 加多余键」的反例（`upgradeArtifactRetention` 里 `Object.keys(retention).length === 2` 会拒绝它，逻辑成立但没有测试钉住）；②`export-evidence.mjs:110` 现在 `now - created >= 1 × 86400000` 就报 `CI_HANDOFF_EVIDENCE_EXPIRED`，1 天的边界行为（恰满一天、artifact 尚在但证据已过期）没有测试；③`policySha256` 随升级改变这一点没有断言（升级后的 policy 字节和基准不同，`policySha256` 的正确值未被任何测试覆盖）。
- 证据：读到的两个测试/脚本段落；`upgradeArtifactRetention` 用 `Object.keys(...).length === 2`。
- 建议：这是作者明确说「等 Andy 决定」的项，判断一致——补上更好，尤其 policySha256，因为 export-evidence 用它核对交接上下文。

**低（记录属实、无碍合入）
- 文件：scripts/ci/quality-policy.mjs:224
- 问题：这个提交（efbcc6da 之前？在本 PR diff 内）顺带删了一行注释 `// Names and descriptions are presentation; all execution-bearing fields remain exact.`，之外 PR 里没有解释。
- 证据：git diff 显示该行被删，PR 无说明。
- 建议：恢复或忽略，一行无关紧要。

**小瑕疵（风格，非新引入）
- 文件：docs/adr/0174-no-github-cache-and-one-day-artifacts.md:98-99
- 问题：关联文档里两条 ADR 的标题比正文标题短（0160 实际标题是「CI 改在 Hermes 上的自托管 runner 运行，macOS 检查暂停」；0173 实际是「…两个 runner 不再限 CPU 和优先级，内存放宽到 14 GB」）。0173 那条是原有写法，新加的 0160 沿用了同一风格。
- 建议：可不改；要改就与 ADR 正文标题一致。

## 读代码证实的作者说法

- 出处改对的：ADR 0160 的标题和决定第 1 条（「Linux 检查全部改在 Hermes 上跑」，`runs-on` 改 `hermes-home`）就是「CI 在自己的服务器上跑」的出处；ADR 0173 的内容（CPU/优先级/内存上限）与这句话无关。0160→0173 的顺序（0170/0171/0173 只调资源）也与改后的表述一致。
- ADR 0174 里其余引用代码的事实逐条核对均一致：
  - 后果 1 引用的 CI 计划数字：docs/execution/plans/2026-09-03-github-ci-quality-gates-plan.md:400「冷缓存 120.588 秒、热缓存 77.893 秒」，与 ADR 里 120.6/77.9 相符。
  - 后果 1 的「锁文件重装 40 多秒」：120.588 − 77.893 ≈ 42.7，相符（这是我的算术，非逐字引用）。
  - 后果 2 的 `export-evidence.mjs` 按 1 天判过期并报 `CI_HANDOFF_EVIDENCE_EXPIRED`：scripts/ci/export-evidence.mjs:104-112，读 `ci/quality-policy.json` 的 `retentionDays.reports`（已改 1），证实。
  - 后果 3 的出处（新改动）：如上，证实。
  - 后果 4「quality.yml 的任务仍在 GitHub 托管机器」：quality.yml 全部 `runs-on: ubuntu-24.04`（行 27-271），证实；且与 ADR 0160 决定 7 一致。
  - 决定 3/4/5 与代码一一对应：toolchain-lock 删 `actions/cache` 条目、install-tools.mjs `expectedActions` 同步删、ci-optimization 测试改为断言无缓存步骤/全部 1 天、`upgradeArtifactRetention` 存在且先于 schema 校验调用，证实。
  - 「做法和已有的 `upgradeHostedRunnerPolicy` 一样」：该函数确实存在（check-policy.mjs:71 一带），且 ADR 0160 决定 6 记录过同款迁移升级，出处属实。
- 没发现其他把决定归错出处的地方。

**未核实（代码外的事实）**：GitHub 计费数字、801 个 artifact 删除、另一个代理直接改 main 的过程、「本 PR 自己的 CI 和合并后第一次 main 确认就是这样」。这些无法凭仓库内容核对。

## 本次改动是否引入新的文档-代码不一致

没有。架构文档改的 30/7→1 的表述（architecture-v0.1.md:639）和设计 spec 改的两处缓存/保留期表述（2026-09-03 spec:124-126、317-320）都与代码一致；docs 里再无 30/7 的残留 CI 表述（grep 到的其余「30 天/7 天」都是别的业务域：Trash、恢复点、安全例外等，与 CI 无关）。

## 必答问题

1. **不会改变模型见过的请求开头。**本 PR 改的是 CI 政策文件（ci/policy.json、quality-policy.json、schema）、工作流脚本（check-policy/install-tools/quality-policy）、tooling 测试和文档。没有任何文件参与组装发给模型的内容（系统提示、工具定义、历史、遮盖结果），也就不涉及「是否只在末尾追加」「每轮会变的值是否在最后一条消息」。改动语义上对这些存放的内容是零接触，追加性不变。
2. **不会。**所有新增/修改的值都是静态字面量（retentionDays 1/1、action 清单少一项、测试断言、文档文字），没有依赖前后文的遮盖、没有带时间的字段、没有依赖遍历顺序的集合；JSON 文件都是固定顺序的整文件写入。
3. **有自动检查，反向用例真的会失败。**`policy.test.mjs` 的新用例：基准 30/7 升成 1（正向 karşıla）、基准 14/7 不升级 → 用新 schema 拒绝（反向，会 throw `retentionDays`）；`ci-optimization.test.mjs` 的 regex 覆盖 `actions/cache`、`/restore`、`/save` 三种写法且带反例（checkout/cachet 不误报），并逐工作流断言 0 缓存步骤、所有 upload `retention-days: 1`；`toolchain.test.mjs` 断言 actions 清单 6→5。这些都是 CI 里的 tooling 项目会跑的。作者自己列入待定的三个反例（多余键、1 天边界、policySha256）确实没有，与作者说明一致。
4. **每个值的双端都核对过，均能接受。**
   - retentionDays 1：产生在 ci/policy.json:363、ci/policy.schema.json:189/192（`const: 1`）、ci/quality-policy.json:15、scripts/ci/quality-policy.mjs:44（`constant`）、check-policy.mjs:82（升级目标）、全部 workflow 的 `retention-days: 1`、三个测试。使用方：check-policy（schema 校验）、quality-policy（合同比对工作流）、export-evidence（读 reports×1 天算过期，语义正确变严）、ci-optimization/workflow 对照。两端校验一致。
   - toolchain-lock 删 `actions/cache` 条目：产生在 lock 文件；使用方 install-tools.mjs `expectedActions` 同步删、toolchain.test.mjs 6→5、check-policy.mjs:374 是单向校验（「工作流用到的 action 必须在 lock 内」），workflow 也不再引用 cache，两端一致；不存在「lock 中每个 action 必须被使用」的反向约束，删除安全。
