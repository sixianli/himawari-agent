# PR 441 第 3 轮复核材料

## 这个 PR 做什么

CI 检查失败时，把失败用例的名字、报错开头和命令日志写进作业摘要，并逐行加 `| ` 前缀打印到作业日志，让只能读作业日志的代理查得到是哪条用例失败。主要文件：`scripts/ci/ci-summary.mjs`、`.github/workflows/ci.yml`、`scripts/ci/check-policy.mjs`、`test/tooling/ci-summary.test.mjs`、`test/tooling/policy.test.mjs`、`docs/adr/0243-ci-uses-no-github-artifacts.md`。

## 第 2 轮之后改了什么

- 读 `result.json`、`details.json` 和 vitest 报告统一走 `readJsonInside`：普通文件、不超过 64 MiB、解析符号链接后仍在报告目录内。
- 省略文件的说明文字按实际字节数预留，不再固定 512。
- 用例名、文件名带私钥标记时整个名字显示成 `?`；命令日志也去掉 ANSI 颜色码。
- 用例：目录外路径四种写法、多字节文件名的上限边界、三个数字的断言、`--failed-logs` 的两种反向变体。
- ADR 0243 第 4 条补充和设计文档第 250 行同步。

## 请重点看

- `readJsonInside` 的 `realpath` 判断有没有漏洞或误拒（例如报告目录本身是符号链接）。
- 说明文字预留量的新算法在第一份文件就放不下时会不会超出上限。
- 这一轮的改动有没有破坏原有的诊断摘要行为。
