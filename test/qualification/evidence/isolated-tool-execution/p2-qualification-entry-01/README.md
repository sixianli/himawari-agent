# P2：真实容器资格验证的固定入口

日期：2026-09-26 UTC。对应[隔离执行实施计划的 P2](../../../../../docs/execution/plans/2026-09-24-isolated-tool-execution-plan.md#p2)最后一项“按 P0 确定的放置方式登记真实容器的资格验证入口”。放置方式来自 [P0 的决定](../p0-baseline-01/README.md#placement)：沿用 `qualify:scale` 的做法，默认不是必需检查。

本批只增加运行入口，不改变容器后端或产品行为。

## 用词

| 用词 | 意思 |
| --- | --- |
| 资格验证 | 在真实运行时（Docker）上跑的测试，平时不随 `npm test` 运行，要显式打开 |
| opt-in 开关 | 显式打开才运行的开关，这里是环境变量 `HIMAWARI_CONTAINER_QUALIFICATION=1` |
| `quality.mjs` | 仓库里运行这类独立质量检查的脚本，负责隔离环境、记录报告 `quality.json` |
| `quality.yml` | GitHub 上只能手动触发的质量检查工作流 |

## 增加了什么

- **检查项 `container`**：写进 [`ci/quality-policy.json`](../../../../../ci/quality-policy.json)，时限 30 分钟。同一文件列出资格验证要用的两个镜像，必须带 SHA-256 摘要，校验规则在 [`quality-policy.mjs`](../../../../../scripts/ci/quality-policy.mjs)。
- **本地命令**：

  ```bash
  HIMAWARI_CONTAINER_DOCKER_CLI=<docker 路径> HIMAWARI_CONTAINER_DOCKER_HOST=<unix:// 地址> npm run qualify:container -- --output .ci-output/<本次输出目录>
  ```

  运行时，[`quality.mjs`](../../../../../scripts/ci/quality.mjs) 打开 opt-in 开关，运行 Vitest 项目 `qualification-container`，证据写到输出目录的 `measurement.json`。可以另设 `HIMAWARI_CONTAINER_WORK_ROOT`，指定测试目录放在哪里（Hermes 上用 `/data` 里的任务目录）。
  - 两个运行时变量缺任何一个，都会直接失败，报 `CI_QUALITY_CONTAINER_RUNTIME_REQUIRED`，不执行测试。
  - 调用方环境里的 `DOCKER_HOST` 不会被带进去。
  - 测试里只要有一项被跳过，整个检查就算失败。
  - 本地运行不会下载镜像；镜像不在本机时，测试会失败。
- **GitHub 的 Linux 任务**：[`quality.yml`](../../../../../.github/workflows/quality.yml) 新增 `container` 任务，在 `ubuntu-24.04` 上运行。先按摘要拉取策略里列出的两个镜像，再用 `/usr/bin/docker` 和 `unix:///var/run/docker.sock` 运行上面的检查，之后照常核验并上传报告。它和其他质量检查一样只能手动触发，也只在默认分支上运行，不是必需检查。

## 测试

先写测试再实现。新增测试最初有 6 项失败，实现后通过：

- [`quality-local.test.mjs`](../../../../../test/tooling/quality-local.test.mjs)：没有运行时时失败，而且没有执行任何命令；打开的开关、传入的变量和证据路径都正确，`DOCKER_HOST` 没有被带入；有跳过时失败。
- [`quality-policy.test.mjs`](../../../../../test/tooling/quality-policy.test.mjs)：
  - 镜像不带摘要，或者镜像列表为空时，策略无效。
  - 工作流去掉拉取镜像的步骤，或者把运行时换成别的地址时，校验报错。
  - 策略里的镜像与资格测试里写死的镜像完全一致。

[`gate-lifecycle.test.mjs`](../../../../../test/tooling/gate-lifecycle.test.mjs) 写死了 `quality.yml` 中发布报告的任务数量，从 5 改为 6。这是本批有意增加的任务。

## 实际运行

| 运行 | 结果 |
| --- | --- |
| Mac，OrbStack 的 Docker | `container: passed`，13 项执行、13 项通过、0 项跳过（`qualify-container-mac-01/`） |
| 不设运行时变量 | 失败，`CI_QUALITY_CONTAINER_RUNTIME_REQUIRED`，没有执行测试（`qualify-container-mac-noruntime/`） |
| 运行时地址指向不存在的 socket | 失败，12 项失败、0 项跳过（`qualify-container-mac-missing/`） |
| tooling 项目全部测试 | 1038 项通过，10 项失败（`tooling-final.log`），失败原因见下 |
| `npm run check:ci-policy`，改动文件的 lint | 通过 |

tooling 项目里的 10 项失败都与本批改动无关：

- 9 项（`artifact.test.mjs` 7 项、`gate-installation.test.mjs`、`main-confirmation.test.mjs`）在去掉本批改动的代码上同样失败。原因是本机没有锁定版本的 Python，以及 Mac 临时目录的 `/private/var` 与 `/var` 路径写法不一致。
- 1 项（`toolchain.test.mjs` 的“治理原始来源闭包”）是因为 `tools/document-governance/.DS_Store`（2026-09-24 的 Finder 文件）不在登记清单里。把这个目录复制一份、去掉 `.DS_Store` 后再校验，就通过了。原文件没有动。

改数量之前那次 tooling 运行的输出是 `tooling-before-count-fix.log`。原始输出打包在 [`raw-logs.tar.gz`](raw-logs.tar.gz)。

## 没有覆盖的部分

- **GitHub 上的真实运行**：这次没有推送代码，所以 `quality.yml` 的 `container` 任务没有在 GitHub 上真正跑过，结构只由工作流校验和上面的测试核对。第一次在 GitHub 上运行时，还要确认 `ubuntu-24.04` 能访问 `example.com`，以及宿主地址检查在那台机器上是否成立。
- **Hermes 上走新入口**：Hermes 的代码副本没有安装 `.ci-output/tools`，所以没有走 `qualify:container`。那台机器上的资格测试本身已在[第四批](../p2-temporary-credential-01/README.md#verification)通过。
