---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: ""
date: "2026-11-08"
---

# ADR 0189：去掉 node-floor 作业，把 test 作业并进 coverage 作业

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [Andy 的原话](#owner-decisions)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

按 [ADR 0176](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0176-ci-on-ovh-vps.md)，PR 的 CI（持续集成，每次推送后自动跑的检查）在 OVH 的 VPS（按月租用的云服务器）上的两个 runner（替 GitHub 执行 CI 任务的程序）里运行。2026-11-08 之前，每个 PR 要跑 9 个作业，其中三个作业把同一批测试跑了三遍：

- `node-floor`（用项目声明支持的最低 Node 版本 `22.19.0` 干净安装、构建，再跑 unit、contracts、integration、e2e、pi-compat 五个测试项目）。`22.19.0` 来自 Pi（项目用的 Agent 运行库）当时接受的最低版本，写在 `package.json` 的 `engines.node`（声明项目支持哪些 Node 版本的字段）里。
- `test`（Node `22.22.3`，用 Linux 构建包逐个跑上面五个项目，每个项目核对实际跑的测试文件和应有的文件一致）。
- `coverage`（Node `22.22.3`，一次 Vitest（项目的测试框架）调用跑 unit、contracts、tooling、integration 并统计代码覆盖率）。

VPS 上 2026-11-07 的运行 42362797124 里，这三个作业分别用了 39.9、33.0、32.6 分钟机器时间，整轮 152.3 分钟。两个 runner 同时只能跑两个作业，所以它们是整轮 CI 慢的主要原因。

生产和上线包只接受 Node `v22.22.3`：`scripts/delivery-mode/packet-template/acceptance/cloud/prepare-runtime-tools.py` 检查 `version != 'v22.22.3'` 就拒绝，Hermes 服务也固定这个版本。项目从来没有在 `22.19` 到 `22.22.2` 的 Node 上运行过服务。

[↑ 返回阅读导航](#contents)

<a id="owner-decisions"></a>

## Andy 的原话

2026-11-08，Andy 问 node-floor：“这个测试是否有必要？没有必要就去掉”；问 test 和 coverage：“这两个测试分别都跑了半小时，能合并成一个吗？”。线程给出下面的方案后，Andy 回答：“按方案做”。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **不再支持 Node `22.19` 到 `22.22.2`。**`package.json` 和 `package-lock.json` 的 `engines.node` 改成 `>=22.22.3`，等于生产实际用的版本。这是一项产品支持范围的决定：以后谁在更低的 Node 上运行，`npm` 会给出版本警告，项目不保证能用。
2. **去掉 `node-floor` 作业。**`ci/policy.json`、`ci.yml`、`ci/required` 的依赖、`scripts/ci/run.mjs` 和本地入口 `scripts/ci/local.mjs` 都不再有它；`ci/toolchain-lock.json` 删掉最低版本 Node 的下载项，`scripts/ci/install-dependencies.mjs` 只接受基线 Node。
3. **去掉 `test` 作业，由 `coverage` 作业接手全部测试项目。**`coverage` 的 `projects` 改成 unit、contracts、tooling、integration、e2e、pi-compat 六个：
   - 前四个照旧在一次带覆盖率的 Vitest 调用里跑。覆盖率范围由 `ci/coverage-policy.json` 定，不变，所以覆盖率基线和比较不受影响。
   - e2e 和 pi-compat 在覆盖率那次调用和覆盖率比较结束之后接着跑（覆盖率失败也照样跑，两边的失败一起报告），用原来 `test` 作业的做法（`scripts/ci/test.mjs` 的 `runTests`，只传这两个项目）逐个跑：核对测试文件集合、`--retry 0`、跑完核对构建包没变。
   - 覆盖率那次调用里的四个项目，不再单独核对测试文件集合：`scripts/ci/check-coverage.mjs` 已经核对这四个项目的测试文件清单是否完整。
4. **本地入口不变成两个命令。**`npm test` 改成 `local.mjs --check coverage`，仍然一条命令跑全部测试。
5. **改作业清单的 PR 自己能过闸门。**按 [ADR 0160](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0160-self-hosted-runner-on-hermes.md) 决定第 6 条的做法，`scripts/ci/check-policy.mjs` 新增 `upgradeRetiredTestChecks`：目标分支上的策略只有在 `test`、`node-floor` 两项和 `coverage`、`required` 的相关字段都和 2026-11-08 的 main 逐字段完全一样时，才升级成新写法；任何一个字段不同都原样返回，交给策略校验拒绝。
6. **macOS 的 test 成员一并去掉。**它从 ADR 0160 起一直暂停（`paused: true`），从没在 VPS 上跑过。以后恢复 macOS 检查时，要另加一个 macOS 的测试作业，并写新的 ADR。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- **把 e2e、pi-compat 也放进覆盖率那次 Vitest 调用。**写法最简单，但这两个项目不在覆盖率范围里，`check-coverage.mjs` 和 `coverage-model.mjs` 都要求覆盖率项目恰好是四个，改它们会动覆盖率基线。所以放在旁边单独跑。
- **保留 node-floor，只把它挪到 main 合并后或每周跑一次。**省 PR 时间，但最低版本仍然要有人维护和排查，而生产从不在那个版本上运行；Andy 的要求是“没有必要就去掉”。
- **保留 test，只去掉 coverage 里的重复项目。**覆盖率统计需要在跑测试的同一次调用里收集，拆开反而要跑两遍。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 每个 PR 少两个作业，从 9 个变成 7 个；`coverage` 的时限仍是 60 分钟。合并后第一次 VPS 完整运行的 `coverage` 耗时记在该 PR 里。
- 丢掉的东西：unit、contracts、integration 不再有单独的 JUnit 报告（一种测试结果的 XML 格式）。`aggregate.mjs` 只核对每个作业声明的输出，不受影响；看失败原因用 `coverage` 作业的 Vitest JSON 报告。
- 项目不再在最低 Node 版本上验证。要重新支持更低版本，先改 `engines.node`，再加回对应的 CI 作业。
- 策略文件的 JSON 结构（`ci/policy.schema.json`、`ci/evidence.schema.json`）的作业数上下限跟着改小，`test/tooling/evidence.test.mjs` 检查上下限和实际作业数一致。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [GitHub CI 与质量门禁设计](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md)
- [ADR 0160：CI 改在 Hermes 上的自托管 runner 运行，macOS 检查暂停](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0160-self-hosted-runner-on-hermes.md)
- [ADR 0176：CI 全部搬到 OVH 的 VPS 上](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0176-ci-on-ovh-vps.md)

[↑ 返回阅读导航](#contents)
