# PR 264 复核意见逐条判断

判断由线程做；“会出错”“可以更好”“不成立”按 `.agents/instructions/model-review.md` 代码复核第 2 步的定义。

## 第 1 轮（提交 6269e972）

- GLM、DeepSeek：CI 从基准提交读已接受的策略再用新 schema 校验，基准上的 30/7 会被拒绝。会出错，已核实：补丁未提交时 Hermes 上 `check:ci-policy` 读到 HEAD 的 30/7 被拒。efbcc6da 新增 `upgradeArtifactRetention` 和正反用例；只加测试时它在旧代码上失败，加修复后通过（Hermes）。
- `docs/architecture-v0.1.md:639` 仍写 30/7 天。会出错，efbcc6da 已改。
- GLM 3：ADR 0174 说 Actions 停着，与同日的 ADR 0173 说 Hermes runner 是 CI 主力矛盾。会出错，efbcc6da 已在 ADR 0174 后果里写明工作流停用只是等新 CI 服务器的临时状态，与 ADR 0173 不矛盾。
- 缓存检查只匹配 `actions/cache@`，漏掉 `actions/cache/restore@`、`actions/cache/save@`。会出错，dacfff49 改用 `usesGitHubCache` 并加正反用例。
- DeepSeek 中：1 天过期没有区分性测试。可以更好，见第 2 轮 GLM 3 的临时用例。
- DeepSeek 低：`export-evidence.mjs:106,110` 按 CI 运行创建时间而不是 artifact 上传时间算过期，可用时间少了一次运行的时长。不成立：这是改动前就有的、偏保守的行为，只会提早拒绝，不会接受已过期的证据；ADR 0174 后果写的就是按这个时间判 1 天过期，文档和代码一致。改成按上传时间会改变行为，需要另开 PR。
- GLM 4：main 确认的 24 小时窗口和 1 天 artifact 几乎重合，没有边界测试。不成立：`main-evidence.mjs:117` 过滤已过期 artifact，取不到时 `:228-233` 回退完整 CI，方向是多跑而不是误放行。

## 第 2 轮（提交 dacfff49）

- DeepSeek 低 3：ADR 0174 把“CI 在自己的服务器上跑”归给 ADR 0173。会出错，已核实：出处是 `docs/adr/0160-self-hosted-runner-on-hermes.md:10` 标题和决定 1；ADR 0173 讲资源上限。d8d6ba53 已改。
- GLM 1、DeepSeek 低 2：新用例没有断言 `policySha256`、没有“30/7 加多余键”反例。可以更好：临时用例（`TEMP 多余键和摘要`）在 4d3e2e18（文件内容同 d8d6ba53）上 Hermes 实跑通过，现有代码已按原始字节算摘要、多余键被拒。
- GLM 3：没有 1 天过期边界测试。可以更好：临时用例（`TEMP 一天边界`：2 天、正好 1 天拒绝，23 小时接受）在 Hermes 上实跑通过。
- GLM 2：ADR 说做法和 `upgradeHostedRunnerPolicy`“一样”，实现是浅拷贝。可以更好：两者做法相同（只升级恰好等于旧写法的策略，其余原样交给 schema 拒绝），差别只在复制方式，不改变行为；改成“仿照”只动措辞。
- DeepSeek 低 1：初始化路径（基准没有策略）也会升级工作区里的 30/7。不成立：`resolvePolicySource` 返回的 `retentionDays` 没有使用方（`grep retentionDays scripts/` 只有 `export-evidence.mjs`、`quality-policy.mjs`，它们读 `ci/quality-policy.json`）；`check-policy.mjs:1139` 另用严格 schema 校验工作区策略；`ci/policy.json` 自 f2ce494f（2026-09-03）起在 main 上，CI 的基准不会走初始化路径。临时用例（`TEMP 初始化路径`）实跑确认现行行为。
- GLM 4、5：只是信息，不要求修改。
- 第 2 轮 DeepSeek 第一次运行服务方过载（`overloaded`），用 `--round 2` 重跑成功。

## 第 3 轮（提交 d8d6ba53）

- DeepSeek 中 1：“ADR 0160 定的 CI 在自己的服务器上跑”概括过宽。不成立：这正是 ADR 0160 的标题（`docs/adr/0160-self-hosted-runner-on-hermes.md:10`“CI 改在 Hermes 上的自托管 runner 运行”）；ADR 0174 下一条也写明 `quality.yml` 仍在 GitHub 托管机器上跑，没有陈述错误。
- DeepSeek 中 2：“三个工作流停用、等新 CI 服务器”在仓库里没有出处。不成立：这是 2026-11 Andy 要求的实际状态（工作流 349410671、358475576、350006999 已手动停用），ADR 0174 就是这条记录；与 ADR 0168、0173 不矛盾，它们记的是停用前的运行情况。
- DeepSeek 推测 5：`Actions/Cache@` 大写写法可能绕过缓存检查。不成立：`check-policy.mjs:372-374` 要求每个 `uses` 与工具锁定清单逐字匹配，锁定清单里已没有任何缓存 Action，大写写法同样被拒。
- GLM 中：三个反例缺位，并称 `policySha256` 随升级改变。缺位部分同第 2 轮，可以更好；“摘要随升级改变”不成立：`check-policy.mjs:1026` 用基准原始字节计算，临时用例已确认。
- GLM 低：删了 `quality-policy.mjs` 一行注释。不成立：项目规则要求删除所编辑文件里的注释，6269e972 提交说明已写明。
- GLM 小瑕疵：关联文档里 ADR 标题比正文短。可以更好，只动措辞。

第 3 轮没有“会出错”的意见。
