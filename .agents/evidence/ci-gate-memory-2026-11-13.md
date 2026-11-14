# 汇总作业各步骤的内存峰值（2026-11-13 实测）

目的：汇总 runner `ci-vps-gate` 的内存上限是 2 GB（`scripts/operations/ci-runner/runners.sh` 第 3 个 runner 的三个内存值）。把汇总作业 `ci/required` 切过去之前，量它最吃内存的两步。

做法：在云端容器里一份干净的检出（提交 79f9c7e69）上，照 `.github/workflows/ci.yml` 里 `required` 作业的命令运行，每 0.1 秒把这条命令和它所有子进程的常驻内存（`/proc/<pid>/status` 的 `VmRSS`）加起来，取最大值。

| 步骤 | 命令 | 峰值 | 结果 |
| --- | --- | --- | --- |
| 安装并核验固定工具 | `node scripts/ci/install-tools.mjs --directory .ci-output/tools --node 22.22.3 --without-scanners` | 259 MB | 成功，写盘约 460 MB |
| 安装汇总器最小依赖 | `install-gate-dependencies.mjs` 里那条 `npm ci --prefix .ci-output/gate-runtime --ignore-scripts --no-audit --no-fund`（ajv、typescript、yaml 及其依赖） | 140 MB | 成功，写盘 30 MB |

两步先后运行，不叠加，峰值约为上限的八分之一。写盘产生的文件缓存算在内存池里，但内核可以随时回收，不会触发杀进程。

没有量的：收报告（`run-share.mjs collect`）和汇总（`required.mjs`）两步需要 CI 服务器上的报告目录，本地量不了；它们各是一个 Node 进程，读最多 8 份报告。检出和 `actions/setup-node` 也没有量。

局限：这是容器里的数，不是 CI 服务器上的数。真机上的峰值在第一次完整运行后用 `systemctl show ghgate.slice -p MemoryPeak` 读（运行手册排错表“汇总作业被系统杀掉”一行）。真机上已经看到的只有：草稿运行的汇总作业在 `ci-vps-gate` 上 7 秒结束（运行 43257576947）。
