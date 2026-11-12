# PR 397 作者说明

## 问题
私有仓库的 GitHub 产物存储额度（0.5–1 GB）被 CI 报告撑满，上传失败，`ci/required` 收不到报告一直红。原因：每轮报告约 300 MB（构建归档被复制进 browser、coverage 报告），ADR 0201 只在汇总通过后删除，草稿 PR 永远不删。Andy 要求绝不在 GitHub 上花钱。两个自托管 runner（账号 gh-runner、gh-runner-2）在同一台 CI VPS 上。

## 改动
- 新增 `scripts/ci/run-share.mjs`：作业之间的文件放 `HIMAWARI_CI_SHARE`（`/srv/gh-runner-share`）下的 `<运行号-尝试号>/<作业-成员>/`；put 写临时名、核对摘要后改名；get 复制后核对摘要；collect 按 `needs` 里每个成员交出的摘要取回；remove 删本次运行目录。umask 设 007，目录 2770、文件 660。
- `.github/workflows/ci.yml`：上传报告/下载构建与报告换成 run-share；摘要走 job outputs；required 收回 `actions: write`，最后 always() 删除本次目录；`main.yml` 的 full 不再单独授权。
- `scripts/ci/check-policy.mjs`、`scripts/ci/main-workflow.mjs`：把以上写成硬规则；删掉 `artifact-output.mjs`、`delete-run-reports.mjs`。
- `scripts/operations/ci-runner/`：安装脚本建组 `gh-ci-share` 和共享目录（失败回滚时删除）；服务模板加 `SupplementaryGroups`、`HIMAWARI_CI_SHARE`、`ReadWritePaths`；clean-old.sh 删 6 小时前的运行目录，定时器改每小时；卸载 all 删组和目录。
- 文档：ADR 0238 取代 ADR 0201；运维手册、设计文档、事故 I-93 的门槛说明。

## 作者的说法，请核对
1. 摘要核对能发现存与取之间文件被改或缺失；矩阵作业每个成员只设置自己的 output 键，其他键为空不会覆盖别的成员的值。
2. 两个 runner 账号经 SupplementaryGroups 都能在共享目录建、读、删对方的文件；并发时不会因为对方建的目录权限不对而失败。
3. 汇总缺报告时仍判失败（`required.mjs` 原有规则），不会因为 collect 的部分缺失而误判通过。
4. 安装脚本失败回滚能删掉新建的组和目录，不影响已有账号。
5. 没有任何作业保留写权限，main.yml 调用 ci.yml 不会再 startup_failure。

## 约束
不写代码注释；不改 ci.yml 的 job 数量和 DAG；不使用任何 GitHub 付费项（缓存、付费存储、付费 runner）。
