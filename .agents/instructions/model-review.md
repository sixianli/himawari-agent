<a id="model-review"></a>
# 合并前的双模型复核

每个 PR 合并前，用 `opencode-go/deepseek-v4.1-flash` 和 `opencode-go/glm-5.3-flash` 两个模型，推理强度都设为高，各复核一遍。只能用这两个模型（Andy 在项目指令第 17 条规定）。交给它们的材料只讲问题、目标、约束和已核对的事实，不预设结论，并写明：列出的方案只是参考，请从问题本身出发，提出你认为更好的方案（项目指令第 16 条）。线程对每一条意见逐条处理并写下理由，报告 Andy，Andy 认可才合并。

<a id="checklist"></a>
## 每次复核都要问的问题

1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？

<a id="how-to-run"></a>
## 怎么跑

用 `node scripts/model-review/opencode-review.mjs` 跑，不要自己拼 `opencode run` 命令。它做这些事（Andy 2026-11-03 定）：

- 模型自己读代码：只开读文件、按内容搜索、按文件名找文件，以及 `git diff`、`git log`、`git show`、`git blame`、`git status`；改文件、别的命令、派子代理、仓库外的路径全部禁止。git 命令里的重定向（`>`、`<`）、制表符、`difftool`（它能执行任意命令）、写文件参数（`--output`、`-o`）、读仓库外文件的参数（`--no-index`、`--contents`）、外部程序参数（`--ext-diff`、`--textconv`）另行禁止。opencode 只按命令文字匹配，引号和反斜杠能绕过（实测 `"--output=文件"` 照样写出文件），所以脚本还在模型用的 `PATH` 最前面放了一个 git 替身：它拿到的是 shell 解析后的真实参数，子命令不在上面五个里、参数是这些禁用参数及其缩写、或是会读文件的 `--ignore-revs-file`、`--pathspec-from-file`、`--mailmap-file`、`--orderfile`、`blame -S`、打开帮助程序的 `--help`，或者短参数连写里藏着 `-o`、`-O`（如 `-pO文件`）就拒绝，否则才交给真的 git；同时用 `GIT_TEST_DISALLOW_ABBREVIATED_OPTIONS` 让 git 自己也拒绝缩写，并不读系统和用户的 git 配置。opencode 的文字规则还漏掉了 `cd 副本 && git log > 文件` 这种写法（实测写出了文件），所以模型的命令改在受限 bash（`bash -r`，bash 自带的模式：不许输出重定向、不许 `cd`、不许改 `PATH`、不许用带斜杠的命令名）里执行。文字规则和参数检查挡不住所有写法（实测模型先 `export GIT_EXTERNAL_DIFF=程序` 再跑 `git diff`，git 就会执行那个程序），所以最后一道是系统级沙箱，做法和 Claude Code 在 Linux 上的沙箱一致（[官方说明](https://code.claude.com/docs/en/sandboxing)：权限规则只看命令文字，系统沙箱管的是运行中的进程）：每条命令在新的用户、网络、挂载、进程命名空间（Linux 内核给一组进程单独一套视图的机制，用 `unshare` 开）里运行，没有网络；所有挂载点只读，跑之前逐个试写确认，有一个能写就以 `SANDBOX_NOT_READ_ONLY` 拒绝；`/root`、`/home`、`/tmp`、`/run`、`/mnt` 等目录换成空目录，只把副本和 git 替身放回原处；环境变量清空，只留 `PATH`、`HOME`、`LANG` 和固定的 git 设置；git 替身调用真 git 时再去掉所有 `GIT_*`、`LD_*` 等变量。需要系统有 `unshare` 并允许非特权用户命名空间，没有就直接报错不跑。opencode 自己的读文件、搜索、找文件工具不在沙箱里，靠 opencode 的路径限制和自检。原因：系统的真相在代码里，只读线程给的材料，材料错了复核就跟着错。
- 代码复核（`--mode code-review`）不联网；方案讨论（`--mode discussion`）可以读网页，没有搜索工具。读网页不限网址，所以模型仍可能去打开搜索引擎的结果页，这一点没有硬拦。
- 必问问题从 `--base` 提交里的本文件读（方案讨论没有 `--base` 时从 `--head` 提交读），不从被复核的改动或工作区读，免得改动自己改掉要问的问题。
- 第一次运行会联网用 npm 安装 `opencode-ai@1.19.5` 到 `~/.cache/himawari-opencode-1.19.5`，之后复用；也可以用 `HIMAWARI_OPENCODE_BIN` 指定已装好的程序。
- 在 PR 最新提交的一次性副本里运行：副本是干净克隆，只有提交过的文件。历史里任何一个提交（包括合并提交）的文件树里出现过 `.env` 一类文件（`.env.example` 这类模板除外）就拒绝复核，因为 git 命令能从历史里读出它。副本删掉了远程地址、引用日志（reflog，记录分支移动的日志，里面有原仓库路径）和 `FETCH_HEAD`，用完即删，脚本收到中断或结束信号（`SIGINT`、`SIGTERM`）时也会删；被强杀（`SIGKILL`）时删不掉。副本里 PR 自带的 `.opencode/`、`opencode.json(c)`、提交进仓库的 `.env*` 文件和指向副本外的符号链接会先删掉，因为 opencode 启动时会执行项目目录里的插件，符号链接能把读文件带出副本；配置改从副本外的文件读。副本里的分支和标签全部删掉，只留 `refs/review/head`、`refs/review/base`、`refs/review/previous` 三个引用；其他提交的对象还在，知道哈希仍能读到。opencode 的全局配置（`~/.config/opencode`）不会被读入，脚本给它一个空的配置目录。
- 把 opencode 默认写死的 32 000 输出上限调高（`OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX`），DeepSeek 高推理时不再被截断。
- 开跑前先对本机假服务器自检，不花钱：让假模型发出一条正常的 `git log`、十几种写文件的命令（含引号、反斜杠、缩写、`difftool` 等绕过写法），以及用 git、读文件、搜索、找文件四种工具读仓库外文件的尝试。正常命令必须能跑；写文件命令既写到副本外，也写到副本里（含先 `cd` 再重定向）；每条写文件命令和每条读仓库外的 git 命令都必须被明确拒绝，只认 opencode 的权限拒绝、git 替身的 `REVIEW_GIT_REFUSED` 和受限 bash 的 `restricted` 三种文字，因别的原因失败（如目录不存在）同样算失败；读仓库外的尝试不能拿到内容；探针按内容对号，不按顺序。读文件、搜索、找文件三种工具读仓库外也必须被明确拒绝。另有几条先 `export` git 环境变量再跑 git 的探针（让 git 去执行 `env`、`touch`），要求看不到父进程里的标记、副本没有任何改动；每个模型跑完都检查副本的 `git status`，有改动就算失败。工具表、输出上限、推理强度也要对。任何一项不对就以 `SELF_CHECK_FAILED` 停下。
- 两个模型并行，结果写到 `--out` 目录；每次的真实用量（输入、输出、推理、缓存命中 token 和费用）追加到其中的 `usage.jsonl`。每个模型累计费用超过 0.2 美元就停掉它，某一步的费用读不出来也停（标 `cost-unknown`），不当作 0；费用是每一步结束后才知道的，最后一步可能略超，所以两个合计约 0.4 美元加最后一步，仍在 0.5 美元内。超时先发结束信号，10 秒不退再强杀。被截断、超时、超费用、进程出错、被信号杀掉或没出文字时退出码为 4，按 `usage.jsonl` 里的 `outcome` 处理，不要原样重跑。

用法：

```
node scripts/model-review/opencode-review.mjs --mode code-review \
  --base <分叉点提交> --head <PR 最新提交> [--previous <上一轮复核的提交>] \
  --brief <作者说明.md> --out <结果目录>
```

`--brief` 只写这次的问题、目标、约束和作者的说法；脚本会在前面加上固定说明（上面的必问问题、项目指令第 16 条原话、「作者的说法可能有错，请对照代码核对」、输出格式），并让模型自己用 `git diff` 看改动。提交可以写分支名，脚本先在原仓库解析成提交哈希。第二轮起传 `--previous`，模型先看增量，但可以读任何文件；合并前最后一轮对最终提交复核时不传它。
