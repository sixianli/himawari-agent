# 两项工具测试在 macOS 上因临时目录路径不一致而失败

日期：2026-09-27 UTC。问题最早记录在[完整测试的打包核对忽略 .DS_Store 的测试一节](../ci-finder-ds-store-2026-09-27/README.md#测试)。

## 问题

tooling 项目（`policy` 检查运行的 CI 脚本测试集）里有两项测试只在 macOS 上失败：

- [`gate-installation.test.mjs`](../../../tooling/gate-installation.test.mjs) 的“从锁定工具运行隔离的 npm ci，只发布成功安装的最小依赖目录”
- [`main-confirmation.test.mjs`](../../../tooling/main-confirmation.test.mjs) 的“先重新验证资格，再构建、扫描新产物并执行安装服务测试，发布可核对的结果”

macOS 上系统临时目录（`/var/folders/...`）和 `/tmp` 都是符号链接，分别指向 `/private/var/folders/...` 和 `/private/tmp`。“解析真实路径”（`realpath`）指把路径里的所有符号链接展开，得到文件实际所在的位置。两项测试都用未解析的临时目录作为仓库根目录，再拿它去比较产品代码给出的已解析路径：

- 第一项：安装脚本把 `node_modules` 做成指向安装目录的符号链接，测试用 `realpathSync` 读出链接的最终位置，得到的是 `/private/...`，期望值却由未解析的根目录拼出。
- 第二项：[`main-confirm.mjs`](../../../../scripts/ci/main-confirm.mjs) 通过 [`contracts.mjs`](../../../../scripts/ci/contracts.mjs) 的 `existingInside` 找到构建出的压缩包。这个函数先解析真实路径，再检查结果是否仍在输出目录里，用来防止借助符号链接指向目录之外的文件。所以传给安装服务测试的 `HIMAWARI_TEST_ARTIFACT` 是 `/private/...`，而 `HIMAWARI_TEST_CONTEXT` 和工作目录直接由根目录拼出，没有解析。

Linux 的临时目录通常没有这层链接，所以项目正式的 `policy` 检查（在 GitHub 的 Linux 机器上运行）一直通过。

## 判断改哪一边

产品代码没有错：`existingInside` 解析真实路径是安全检查的一部分，不能去掉；两个环境变量虽然写法不同，指向的是同一个目录下的真实文件，安装服务测试都能读到。问题在测试：它假设“根目录本身就是真实路径”，这个假设在 macOS 上不成立。

因此只改测试：两个文件在 `beforeEach` 里改为 `root = realpathSync(mkdtempSync(...))`，先把临时根目录解析成真实路径再使用。断言本身没有改动，仍然逐项比较完整路径。在 Linux 上临时目录没有链接时，解析结果和原来相同，行为不变。

## 测试

代码版本：提交 `96f894c` 加本次改动（即本证据所在提交）。以下命令由 Claude 在命令沙箱之外运行，因为沙箱不允许测试在系统临时目录下建目录：

```sh
npx vitest run --config vitest.workspace.ts --project tooling --reporter verbose test/tooling/gate-installation.test.mjs test/tooling/main-confirmation.test.mjs
HIMAWARI_CI_PYTHON=$PWD/.ci-output/tools/python/python/bin/python3.12 npx vitest run --config vitest.workspace.ts --project tooling
```

- 改动前：[`tooling-before.log`](tooling-before.log) 中上述 2 项失败，其余 17 项通过；差异正是期望 `/var/folders/...`，收到 `/private/var/folders/...`。
- 改动后：[`tooling.log`](tooling.log) 两个文件 19 项全部通过；[`tooling-project.log`](tooling-project.log) 整个 tooling 项目 38 个文件、1073 项全部通过（`HIMAWARI_CI_PYTHON` 指向完整测试安装的固定 Python 3.12.10，打包相关测试需要它）。
- 完整的 `node scripts/ci/local.mjs --check policy`（同样在沙箱之外运行）结果为 `policy/default: passed`，其中 tooling 1073 项无失败，报告在 [`policy-check.tar.gz`](policy-check.tar.gz)。
- `npm run lint`、`npm run check:ci-policy` 通过。日志去掉了终端颜色控制字符和本机沙箱打印的 `failed to copy trust settings` 行。

## 未验证的部分

- 没有在 Linux 上重新运行；改动只是在测试开始时多解析一次路径，Linux 上结果应与原来相同，这一点是推断。
