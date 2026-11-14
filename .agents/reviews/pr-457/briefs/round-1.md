# PR 457 第 1 轮：作者说明

背景：ADR 0256（`docs/adr/0256-gate-job-gets-its-own-runner.md`，已在 main）决定在 CI 服务器上加第 3 个 runner，只跑汇总作业 `ci/required`；main 的确认只保留最新一次。这个 PR 是 ADR 里的“PR A”和“第 2 步”，不改 `ci.yml`（汇总作业切到新 runner 在下一个 PR）。

改动：

1. `scripts/operations/ci-runner/runners.sh`：`RUNNER_IDS="1 2 3"`；3 号 runner 名字和标签都是 `ci-vps-gate`，用户 `gh-runner-gate`，目录 `/srv/gh-runner-gate`；每个 runner 有自己的标签、内存池、内存和进程数限额；`render_runner_unit` 把这些填进服务模板。
2. `gh-runner.service.in`、`gh-runners.slice`（上限从 20 GB 降到 18 GB）、新文件 `ghgate.slice`（预留和上限各 2 GB）。分组名不带短横线，因为 systemd 把短横线当上下级，预留内存要每一级都设才生效。
3. `install-runner.sh`、`uninstall-runner.sh`、`register-runner.sh`、`prepare-vps.sh`、`gh-runner-nft.service`、`runner-pause.sh`：认 3 号。
4. `mac-runners.sh`、`pause-runners.sh`、`resume-runners.sh`：暂停去掉 runner 身上所有会接作业的标签（`ci-vps`、`ci-vps-gate`，包括应急时加在 1 号上的），恢复只给每个 runner 加回它自己的标签。
5. 新文件 `gate-fallback.sh on|off`：3 号坏了时在 Mac 上把 `ci-vps-gate` 临时加到 `ci-vps-1` 上。
6. `.github/workflows/main.yml` 并发组改成固定的 `main-confirmation`（`cancel-in-progress` 仍是 `false`）；`scripts/ci/main-workflow.mjs` 的硬规则同步。
7. `docs/runbooks/ci-vps-runner-runbook.md` 改成三个 runner。
8. `test/tooling/security-published.test.mjs`：原来一条用例连续扫 63 个文件，合计 2.8 到 3.7 秒，CI 上偶发超过 5 秒上限；拆成每个登记文件一条用例。

请重点看：

- 暂停、恢复、应急三个脚本在各种中间状态下会不会留下“服务停了但标签还在”或“给 3 号加了 `ci-vps`”的情况。
- 在已经有两个 runner 的机器上安装（先暂停、上传、`install-runner.sh`、`register-runner.sh 3`、恢复）会不会弄坏现有的两个 runner；安装中途失败的回滚有没有漏掉新加的文件（`ghgate.slice`、3 号的用户和目录）。
- 3 号 runner 的服务文件有没有藏住另外两个 runner 的目录，反过来也是。

本 PR 不改产品代码，不改发给模型的任何内容。

实际跑过的检查：`npm run check` 50 步通过；`test/tooling/ci-runner-scripts.test.mjs` 122 条通过。反向验证：3 号标签写成 `ci-vps`、恢复时给 3 号加 `ci-vps`、1 号看得到 3 号目录、暂停只去 `ci-vps`、`RUNNER_IDS` 漏掉 3、并发组改回带运行号、`cancel-in-progress` 改成 `true`，对应用例都失败。没有在真实的 CI 服务器上跑过。
