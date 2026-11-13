# PR 464 第 7 轮逐条判断

1. 试跑在自托管 runner 上执行草稿 PR 的代码（模型：中）。不成立：仓库是私有的，外人不能开 fork PR。
2. prepare-arm 的 Playwright 包没有完整性校验（模型：中/低）。成立，可以更好；和 prepare-vps.sh 一起改，另开。
3. semgrep 时限用例守不住调用点（模型：中/低）。成立，会出错（低），已改：security-process 用例断言 semgrep 调用的 timeout，删掉调用点的 timeout 后该用例失败。
4. 准备脚本用例的平台名取自脚本自身（模型：低）。成立，会出错（低），已改：按脚本名给定平台。平台写死清单 ci-runner-scripts.test.mjs 的 linux-x64 从 1 记为 2。
5. curl 没有超时、错误码不统一（模型：低）。成立，可以更好；脚本由 Andy 交互运行。
6. 只追加判定对键顺序敏感（模型：低）。成立，会出错（低），已改：判定用深比较，逐条比较只用来写失败信息。

没有中、高的“会出错”意见。本轮花费 0.13 美元，PR 累计 0.68 美元。第 4 条改了 scripts/platform-assumptions.json（不是测试文件），所以再跑一轮复核。
