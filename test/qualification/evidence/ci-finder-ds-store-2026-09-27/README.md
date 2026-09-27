# 完整测试的打包核对忽略访达的 .DS_Store

日期：2026-09-27 UTC。

## 问题

`.DS_Store` 是 macOS 访达（Finder）在它显示过的文件夹里自动写的隐藏文件，记录图标位置、视图方式等显示设置，和产品无关。完整测试（`npm test`）先在仓库的 `.ci-output` 下打包产品：列出打包目录里所有文件并写进清单，再重新列一遍核对。访达在这两步之间写入 `.DS_Store` 时，两次列出的文件对不上，测试报 `ARTIFACT_CONTENT_MISMATCH`，以前只能关掉访达窗口再跑。之前的记录见[重启后释放的记录中的完整 npm test 一节](../isolated-tool-execution/p3-srt-restart-01/README.md#完整-npm-test提交-d5b22e9)。

## 改了什么

所有者选择的做法是让核对忽略这种文件：

- 收集文件清单（[`artifact-files.mjs`](../../../../scripts/ci/artifact-files.mjs)）时，跳过名字恰好是 `.DS_Store` 的普通文件。
- 打包成压缩包（[`artifact-archive.py`](../../../../scripts/ci/artifact-archive.py)）时同样跳过，压缩包和清单保持一致，也不会因为访达在打包途中删改它而读取失败。
- 名字相近的文件（`DS_Store`、`.DS_Store.js`）、名为 `.DS_Store` 的文件夹里的文件、名为 `.DS_Store` 的符号链接仍按原规则拒绝。

代价：打包目录里任何名为 `.DS_Store` 的普通文件都不再被核对，也不会进入压缩包，产品本身不需要这种文件。删除打包目录时访达同时写入可能报 `ENOTEMPTY`（目录不为空），这次没有处理。

## 测试

代码版本：提交 `fa3fef3` 加本次改动（即本证据所在提交）。由 Claude 运行，`HIMAWARI_CI_PYTHON` 指向完整测试安装的固定 Python（`.ci-output/tools/python/python/bin/python3.12`，版本 3.12.10）：

```sh
npx vitest run --config vitest.workspace.ts --project tooling --reporter verbose test/tooling/artifact.test.mjs
```

- 改动前：[`tooling-before.log`](tooling-before.log) 中“在各层目录写入 `.DS_Store` 后核对仍通过”失败，报错正是 `ARTIFACT_CONTENT_MISMATCH`；[`tooling-archive-before.log`](tooling-archive-before.log) 中“写入 `.DS_Store` 前后打出的压缩包完全相同”失败。
- 改动后：[`tooling.log`](tooling.log) 中 [`artifact.test.mjs`](../../../tooling/artifact.test.mjs) 32 项全部通过，含上面两项、三种相近名字仍被拒绝、符号链接仍被拒绝，以及原有的全部打包核对测试。
- `npm run typecheck`、`npm run lint`、`npm run check:ci-policy`、`npm run check:secrets` 通过。整个 tooling 测试项目在 Claude 的命令沙箱里有 49 项因不能写 `/tmp` 等限制失败。完整测试（`npm test`）不运行 tooling 项目，它由单独的 `policy` 检查运行（见 [`check-policy.mjs`](../../../../scripts/ci/check-policy.mjs)），这项检查尚未运行。

## 完整 npm test（提交 `7f9ad63`，通过）

由用户在本机终端运行 `npm test -- --output .ci-output/npm-test-7f9ad63`，访达保持打开，全部通过：contracts 379、unit 2060、integration 1842、e2e 3、pi-compat 130，报告在 [`npm-test-7f9ad63.tar.gz`](../isolated-tool-execution/p3-srt-crash-01/npm-test-7f9ad63.tar.gz)。它的打包步骤用的就是改动后的清单和打包脚本；tooling 测试项目不在完整测试里。无法确定访达这次是否显示过打包目录，所以这次通过只说明打包没有受到干扰，不能单独证明忽略 `.DS_Store` 起了作用；这一点由上面的自动测试覆盖。
