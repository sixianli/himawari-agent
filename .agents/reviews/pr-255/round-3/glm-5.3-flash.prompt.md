你是独立的代码复核者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
系统的真相在代码里。下面「作者的说法」可能有错，每一条都要对照代码核对；发现说法和代码不一致，要明确指出。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
你的额外侧重：测试有没有覆盖这次改动、文档和规则与代码是否一致；挑一条最普通的使用流程，从入口走到结束，标出经过的、没有测试覆盖的代码路径。另一个复核者侧重别的方面，所以你仍要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你走过的流程和结论。
输出格式：按严重度从高到低排列，每条写：严重度、文件:行、问题、证据（引用你亲自读到的那几行代码）、建议。把「读代码证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 a253b15fa4c80f52a20554ea3f65fd33dff03d3d。
对比基准是 bd0859a9084bd32bb7e00c4e6fcecd0c6a3e7874，先运行 git diff bd0859a9084bd32bb7e00c4e6fcecd0c6a3e7874..a253b15fa4c80f52a20554ea3f65fd33dff03d3d 看改动。
上一轮复核到 8e37839522faafe0d04008c8da6cf3535b781d28，先看 git diff 8e37839522faafe0d04008c8da6cf3535b781d28..a253b15fa4c80f52a20554ea3f65fd33dff03d3d 的增量，但可以读任何文件。
作者的说法（可能有错，请核对）：
PR #255：OpenCode 复核流程整改。

## 要复核的范围

重点是会执行的代码和规则：`scripts/model-review/opencode-review.mjs`、`scripts/model-review/opencode-lock/`、`test/tooling/opencode-review.test.mjs`、`biome.json`、`.agents/instructions/model-review.md`。
`.agents/handoffs/` 是交接文件和方案；`.agents/reviews/` 是两次方案讨论和一次对比实验的存档，里面是模型的原文。这两类只是文字，不必逐字核对；它们在你的副本里也被刻意隐藏了。

## 问题和目标（作者的说法，可能有错，请核对代码）

1. 环境变量（T1）：原先 `runOpencode` 把脚本的整份环境传给 opencode，模型运行 `git log $GITHUB_TOKEN` 就能从 git 的报错里读到令牌值。现在改成白名单 `OPENCODE_KEPT_ENV`；自检加了一条探针 `git log $REVIEW_PARENT_CANARY`，并且要求读 `/proc/self/environ` 被拒。
2. 安装（T7）：opencode 改为按提交的 `opencode-lock/package-lock.json` 用 `npm ci` 安装；每次使用前再核对已装的每个包的 sha512，不一致报 `OPENCODE_INTEGRITY_MISMATCH`。安装目录名带锁文件摘要的前 12 位。
3. 重跑（T8）：`--round <序号>` 把单个模型的重跑记回原来那一轮。这一轮不存在、该模型已有 ok 记录、head 不同、提示词不同时，都在花钱之前拒绝；失败那次的文件改名为 `<模型>.attempt-<n>.*`。
4. 记录进仓库（T3）：代码复核必须传 `--pr`，方案讨论必须传 `--topic`；记录目录固定为 `<repo>/.agents/reviews/pr-<n>/` 或 `topic-<slug>/`；`--out` 只在 `--self-check-only` 时允许。每轮存 `<模型>.prompt.md`、`<模型>.md`、`<模型>.stderr.txt`；原始事件和思考内容写到系统临时目录。复核副本用 sparse checkout 去掉 `.agents/reviews/`，在副本的 `.git/info/attributes` 里把它标成 `-diff`，git 替身拒绝含 `agents/reviews` 的参数，以及 `-a`、`--text`、`--binary`。
5. 合并前核对（T2）：`--assert-reviewed --pr <n>` 从当前提交读账本，取最后一个两个模型都 ok 的轮次，要求那一轮的 head 是当前提交的祖先、两者之间只改了本 PR 的记录目录、`origin/main` 已合进分支。`--accept-unreviewed "<原话>"` 把例外写进账本。
6. 汇报（T6）：`--report --pr <n> --stop <原因>` 生成固定几行，并核对停下的原因和账本一致。
7. 各有侧重（T5）：`MODEL_LENSES` 给两个模型各加一节额外侧重（只用于代码复核和方案审核）；规则文件加了第 4 条必答问题；新增 `--questions-ref`。

## 约束

- 复核模型只读，限制的目的是防误操作，不防有人故意埋恶意代码（`model-review.md` 写明 Andy 2026-11-03 的决定）。
- 发给模型的内容只能在末尾追加；复核每次运行都是新会话。
- 不写代码注释。
- 测试用真实的 opencode 1.19.5 和本机假服务器；测试文件里有一条 `stops reading near the time limit`，在改动前的 main 上就会让 vitest 内存耗尽，本 PR 没碰它。

## 作者自己没把握的地方

- `OPENCODE_KEPT_ENV` 够不够 Mac 上用（没在 Mac 上验证）。
- `--assert-reviewed` 对合并提交、只改了记录目录以外文件的各种情况，是否都判对了。
- 隐藏记录目录的局限：模型若先 `git log --raw` 找到对象编号再 `git show <编号>`，仍能读到内容。

## 第 3 轮：上一轮复核到 8e378395 之后的修改（作者的说法）

PR #255 第 2 轮 OpenCode 代码复核（增量 bb057722..8e378395，DeepSeek 0.0579、
GLM 0.0390 美元，累计 0.2202），逐条判断见 .agents/reviews/pr-255/round-2/judgments.md。
修改：
- 代理地址（HTTPS_PROXY/HTTP_PROXY 及小写）带账号密码时拒绝开跑
  （PROXY_HAS_CREDENTIALS，报错不打印值）：白名单里的变量模型同样读得到。
- --assert-reviewed 认出已提交的例外记录（之后只改了记录目录就 REVIEW_OVERRIDE
  ... recorded=<提交> 并通过）；工作区账本和当前提交不一致时拒绝写例外。
- --brief 读入时去掉行尾空格，.stderr.txt 写入时同样处理。
- --round：例外记录不算进任何一轮；同一轮已有别的模式时 ROUND_MODE_MISMATCH；
  提示词文件和账本摘要都没有时 ROUND_CANNOT_VERIFY。
- 规则文件：原始事件路径补上仓库摘要那一层；写明脚本只能核对“至少三轮”；写明
  存档结论去掉了行尾空格；补上述新错误码。
- 测试按平台断言 /proc/self/environ 探针。

门槛证据（云端容器）：新增或扩充的测试先失败；逐个撤掉修复时对应测试失败：
代理（review env 真实入口，退出码 2）、已提交例外（merge gate）、账本不一致
（merge gate）、无法核对（rerun round）、模式不一致与例外记录（rerun round）。

Layer-0-tests: test/tooling/opencode-review.test.mjs
Fast-mode-checks: 云端容器（Linux），本提交工作区：opencode-review.test.mjs 113 通过
1 跳过（-t 排除 “stops reading near the time limit”，原因同 b1af81aa）；
npm run check 通过；npm run build 通过。
