# 第 1 轮复核：线程逐条判断

复核提交 `bb057722`，对比基准 `bd0859a9`。DeepSeek 0.0585 美元，GLM 0.0647 美元。

## 会出错（已改）

| 来源 | 意见 | 依据 | 改法 |
|---|---|---|---|
| DeepSeek | 合并前检查用 `git diff --name-only`，改名只列新路径，把代码文件 `git mv` 进记录目录能混过去 | 在本仓库复现：`git diff --name-only` 对改名只给新路径；新测试先失败 | 加 `--no-renames` |
| DeepSeek | 环境探针的标记只放在传给 `runOpencode` 的副本里，改回 `...process.env` 时自检仍通过 | 反向验证：改回 `...process.env` 时，改前的真实自检测试不失败 | 自检期间把标记写进真正的 `process.env`，结束后还原；去掉 `parentEnv` 参数 |
| DeepSeek、GLM | 规则文件说“核对已装的每个包的摘要”，代码只核对 npm 的安装记录；安装记录不是合法 JSON 时抛 `SyntaxError` | `installedIntegrityProblems` 只读 `.package-lock.json` | 规则文件改写成实际做法；读不出时报 `installed-lock-unreadable` |
| GLM | 核对失败后永远卡住，只能手工删目录 | `installOpencode` 只在程序不存在时安装 | 复用的安装核对不过时删掉重装一次（`OPENCODE_REINSTALL`），再不过才报错 |
| DeepSeek | `--accept-unreviewed` 没限制在“连续三轮没过”这一种例外 | 规则第 6 步写明只有这一种例外 | 代码复核少于三轮时拒绝例外（`REVIEW_OVERRIDE_REFUSED`） |
| DeepSeek | 原始事件目录只按 PR 编号区分，两个仓库同编号会串 | `rawDir` 只用 `reviewKey` | 路径加仓库路径摘要前 12 位 |
| DeepSeek | `--round` 在提示词文件缺失时不核对 | `roundForRun` 只在文件存在时比较 | 文件不在时用账本里的 `promptSha256` 比较 |
| DeepSeek、GLM | `--assert-reviewed`/`--report` 静默忽略多给的参数，例如 `--report --accept-unreviewed` 会让人以为记下了例外 | `parseArgs` 提前返回 | 多给的参数以 `ARG_NOT_FOR_SUBCOMMAND` 拒绝；两个子命令同时给报 `ARG_ASSERT_AND_REPORT` |
| DeepSeek（推测） | `/proc/self/environ` 探针在 Mac 上可能误报 | Mac 没有 `/proc`；opencode 在 Mac 上先查权限还是先查文件存在，没法在云端核实，按规则拿不准算会出错 | 只在 Linux 上加这条探针 |
| GLM | `PROMPT_TOO_LARGE`、安装目录名没有测试 | 无对应测试 | 补真实入口测试和目录名测试 |

每一条都做了反向验证：撤掉修复时，对应的新测试失败。

## 不成立

| 来源 | 意见 | 依据 |
|---|---|---|
| DeepSeek | `--report --stop three-rounds` 不核对每轮“没过” | “没过”是线程对意见的判断（`model-review.md` 第 4 步：一轮里只要有一条意见被判为“会出错”，这一轮就算没过），账本里没有；三轮模型都 `ok` 也可能都没过。规则第 7 步写明脚本只核对“至少有三轮” |
| GLM | 同一轮两条 ok 记录的 head 不同时退出码是 2 而不是 5 | 账本损坏的另一种情况 `USAGE_LEDGER_INVALID` 也是退出码 2，两者一致；这种账本只有手工改坏才会出现（`roundForRun` 不允许同一轮换 head） |
| GLM | 禁用长参数的匹配放过 `--output2` 这类比禁用名长的参数 | git 没有这类参数；git 替身设了 `GIT_TEST_DISALLOW_ABBREVIATED_OPTIONS`，未知参数由 git 自己拒绝；这段代码本 PR 没改 |
| DeepSeek | 旧账本没有 `round` 时汇报打印 `round=undefined` | 汇报只打印 `mode=code-review` 的记录，这些都由本脚本写入，`record` 里总有 `round` |
| DeepSeek | `<模型>.stderr.txt` 不是每轮都写 | 说法不准的是给模型的材料；规则文件写的是“失败时的报错”，与代码一致 |
| GLM | SIGINT/SIGTERM 清理没有测试 | 这段代码本 PR 没改 |
| DeepSeek | 调用方传 `--main-ref HEAD` 能让“main 已合进”恒真 | 调用方就是做 PR 的线程自己，规则第 6 步只写默认用法 `origin/main`；故意传错属于 Andy 2026-11-03 定的不防范围（`model-review.md`“怎么跑”第一条） |
| DeepSeek | 隐藏记录目录挡不住 `git log --raw` 找对象编号再 `git show` | 要模型先找对象编号再专门去读，属于故意绕过；规则文件已写明这个局限，限制只防误操作（同上） |

## 可以更好（不改，报 Andy）

| 来源 | 意见 | 线程建议 | 依据 |
|---|---|---|---|
| GLM | 主流程把结果写进记录目录、临时目录的那一段没有自动测试 | 不采纳 | 要测就得伪造整个 opencode 的模型调用。规则要求“建议补的测试”先临时写出并运行过才能归为可以更好，这里没写临时测试，依据只有实际运行：这段在 T5 对比实验和本次复核里实际跑了 3 次，生成的文件逐一核对过（`round-*/<模型>.prompt.md`、`<模型>.md`、`REVIEW_RAW_DIR` 下的原始事件）。请 Andy 定是否要求补 |

## 线程自己发现的

- 提交本轮记录时，`git diff --cached --check` 因为模型结论里的行尾空格拒收（方案讨论存档时也遇到过一次）。脚本原样把模型结论写进要提交的记录目录，是 T3 留下的缺口。改为写入 `<模型>.md` 时去掉每行末尾的空格和制表符（`recordText`），并补测试；撤掉时测试失败。本轮两份结论已同样处理。
