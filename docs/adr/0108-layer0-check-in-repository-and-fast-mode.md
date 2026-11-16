---
status: active
document_type: adr
decision_status: accepted
supersedes: "docs/adr/0066-layer0-related-tests-declared.md"
superseded_by: ""
date: "2026-10-29"
---

# ADR 0108：第 0 层相关测试检查放进仓库，快速模式下也检查

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

第 0 层是改产品代码前后跑的定向测试。[ADR 0066](0066-layer0-related-tests-declared.md) 规定：直接相关的测试文件由脚本 `check-layer0-tests.py` 从代码推导，提交说明里逐行写 `Layer-0-tests: <路径>`，本机的 `commit-msg` 和 `pre-push` 钩子（git 在提交和推送时自动运行的脚本）拒绝缺漏。

这个检查后来等于没有：

- 脚本和钩子只装在 Andy 的 Mac 上，不在仓库里。云端线程每次从头克隆仓库，根本没有这个脚本；现在大部分代码是云端线程写的。
- 快速模式（[ADR 0073](0073-fast-delivery-mode.md)，后由 [ADR 0080](0080-document-governance-in-fast-mode.md) 取代）让两个钩子直接放行。

结果同一错误一共出了 6 次，后两次在快速模式下：加迁移的提交 `d849375` 和 `bfa6162` 都没跑写死迁移编号的测试，main 上 16 个用例一直失败（[事故清单 I-05](../incidents-and-gates.md)）。按 [ADR 0107](0107-every-incident-gets-an-automatic-gate.md)，次数到 3 必须有硬门槛。Andy 在 2026-10-29 10:01（日本时间）同意“把脚本放进仓库，作为 `npm run check` 的一步”。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

本 ADR 取代 ADR 0066，保留它的推导规则、声明格式、错误码和合并提交不查的规定，改变以下几点：

1. **脚本和钩子放进仓库。** 脚本原样（SHA-256 `0b66a9ec3683226a6e5776307163815338c7cbdb2bcfbc2c7786ac0de35680e1`）放在 `scripts/layer0-tests/check-layer0-tests.py`；钩子放在 `scripts/git-hooks/`：`commit-msg` 和 `pre-push` 调用仓库里的脚本，`pre-commit` 接着运行共享 git 目录里原有的 `pre-commit`（例如本机检查新注释的钩子），不让它失效。推导命令改为 `python3 scripts/layer0-tests/check-layer0-tests.py derive`。
2. **`npm run check` 负责装钩子。** 其中的 `check:layer0-hooks`（`scripts/check-layer0-hooks.mjs`）在 git 本地配置里把 `core.hooksPath`（git 找钩子的目录）设为 `scripts/git-hooks`；已经指向别的目录时报 `LAYER0_HOOKS_PATH_CONFLICT` 并失败，不覆盖。项目规定每次提交前都跑 `npm run check`，所以第一次提交之前钩子就装好了。
3. **快速模式下也检查。** 钩子不再看 `DELIVERY_MODE`。改了 `apps/*/src/`、`packages/*/src/` 的提交，在快速模式下也要写 `Layer-0-tests:` 行，同时照旧写 `Fast-mode-checks:` 行。这一条改变了 ADR 0080 里“快速模式不需要 `Layer-0-tests:` 行”的规定，ADR 0080 的其他规则不变。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

### 方案 A：维持现状，只在规则里要求跑推导出的测试

- 好处：不多花时间。
- 代价：没有任何东西核对，云端线程连推导命令都跑不了；已经出了 6 次。

### 方案 B：脚本进仓库，作为 `npm run check` 里核对已提交历史的一步

- 好处：不碰 git 配置。
- 代价：`npm run check` 在提交之前跑，那时还没有提交说明可查；等下一次再查时，缺漏的提交已经推送，项目规定不改写已推送的历史，只能一直失败。

### 方案 C：钩子进仓库，由 `npm run check` 把 git 指向它们（采用）

- 好处：提交时当场拦下，云端和 Mac 都一样；`pre-push` 还会拦住用 `--no-verify` 跳过 `commit-msg` 的提交。
- 代价：`npm run check` 会改本地 git 配置一次；改公共模块时一次提交可能要写十几二十行声明。

### 方案 D：在 `npm install` 的 `prepare` 脚本里装钩子

- 好处：更早装上。
- 代价：Hermes 和出包时会在不是 git 仓库的目录里装依赖，那里改 git 配置会失败，需要另加判断；`npm run check` 已经在每次提交前跑，不需要再加一处。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 时间：检查只在提交和推送时跑，不在出包或上线时跑，对发布时间没有直接影响。对快速模式下漏跑的提交 `bfa6162` 运行一次检查用时约 1.2 秒（本线程云端实测）。要跑的测试本来就是快速模式规则要求的，多出来的只是漏跑时补跑的时间。
- 复现：对 `bfa6162` 运行 `check-commit`，以 `L0_RELATED_TESTS_UNDECLARED` 拒绝，并点名当时漏掉的 `test/integration/sqlite-sandbox-execution-v2.test.ts`。`test/tooling/layer0-hooks.test.mjs` 用旧的“快速模式放行”钩子会失败，换成新钩子后 4 个用例通过。
- 限制：ADR 0066 写的限制仍然有效，只证明声明里包含推导出的文件，不证明它们真的跑过并通过。还没跑过 `npm run check` 的新克隆在第一次提交时没有钩子；Mac 上不跑 `npm run check` 就提交的远程线程同样没有，这时由 Mac 原有的钩子兜底，但那些钩子在快速模式下仍会放行。
- 后续：`.agents/instructions/delivery-mode.md`、`.agents/instructions/test-trigger-timing.md`、[代理工具 Runbook](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/runbooks/agent-tooling-runbook.md)、[lessons](../lessons.md#layer0-related-tests) 和[事故清单](../incidents-and-gates.md)已同步更新。Mac 上 `.ci-output/handoff/l0-guard/` 里的副本不再是来源，以后只改仓库里的文件。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- 被取代的决定：[ADR 0066](0066-layer0-related-tests-declared.md)。
- 被改变一条规定的决定：[ADR 0080](0080-document-governance-in-fast-mode.md)。
- 事故门槛规则：[ADR 0107](0107-every-incident-gets-an-automatic-gate.md)，[事故与门槛清单](../incidents-and-gates.md)。
- 面试案例：[工程案例库案例 47 的后续](../engineering-casebook.md#case-incident-gates)。
