你是独立的方案审核者。
你能用的工具：read、grep、glob、websearch、webfetch，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。
下面是一份还没动手实施的方案。逐条对照代码和一手来源核对：有没有漏掉的场景、判断错的地方、和业界成熟做法不一致的地方。方案作者的说法可能有错。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
你的额外侧重：错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销的操作，以及规则文件、说明文档和代码是否一致。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你查过的这类路径和结论。
输出格式：按严重度从高到低排列，每条写：严重度、问题、证据（文件:行引用的代码，或网址和原话）、你建议怎么改。把「证实的」和「推测」分开写。最后写：如果由你来定，你会怎样改这份方案，并逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 5b00a249c1ff6df30614091a8b86444d70c4f500。
待审核的方案：
# 方案：自建合并队列（PR 跑快检 + 相关测试，批量候选跑完整 CI，过了再合进 main）

## 前提（带来源）

1. 现行合并门槛：PR 最新提交上的 `ci/required` 成功才能合。来源 `.agents/instructions/delivery-mode.md` 第 27 行：“合并进 `main` 之前，PR 最新提交上的 `ci/required` 必须是成功”。
2. 合并由做 PR 的线程执行。来源 `.claude/rules/owner-standing-rules.md`：“合并 PR 一律由做这个 PR 的线程执行”。
3. 不在 GitHub 上花钱（Andy 2026-11-11 原话“我绝不在 GitHub 上花钱”，CI 线程）。GitHub 自带 merge queue 对个人私有仓库是否可用：未核实，方案不依赖它。
4. 用 `GITHUB_TOKEN` 触发的事件不会再起新的工作流运行，`workflow_dispatch` 和 `repository_dispatch` 例外。来源 https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow ：“events triggered by the `GITHUB_TOKEN` will not create a new workflow run”，“`workflow_dispatch` and `repository_dispatch` events always create workflow runs.”
5. `ci.yml` 已支持 `workflow_dispatch`，输入 `base_sha`（`.github/workflows/ci.yml` 第 14–18 行）；`scripts/ci/context.mjs` 对 `workflow_dispatch` 用 `inputs.base_sha` 作基线。
6. main 上的确认工作流 `main.yml` 只在 `push` 到 main 时运行（`.github/workflows/main.yml` 第 2–4 行）。由前提 4，`GITHUB_TOKEN` 做的合并不会触发它。
7. 复核门槛有脚本可查：`node scripts/model-review/opencode-review.mjs --assert-reviewed --pr <n>` 打印 `REVIEW_CURRENT` 才算复核到最新提交（`.agents/instructions/model-review.md`）。
8. vitest 的 `--changed` 只按静态 import 找相关测试，动态 import 不算（https://vitest.dev/guide/cli ：“Works with static imports … but not the dynamic ones”）；`forceRerunTriggers` 里的文件出现在 git diff 里时跑全量（https://vitest.dev/config/forcereruntriggers ）。仓库里有 63 个测试文件启动子进程，vitest 看不到子进程用到的代码（本线程 grep 结果）。
9. 各测试项目耗时：tooling 703 秒、integration 617 秒、unit 183 秒、contracts 34 秒（`.agents/evidence/ci-test-timing-2026-11-13.md`）。

## 目标

每个 PR 从推送到“可以排队”的时间尽量短；完整 CI 的次数从“每个 PR 一次”降到“每批一次”；进 main 的每个提交的树都完整测过。

## 设计

### 1. PR 阶段（快检）
- PR 上的 `ci.yml` 照旧跑 policy、static、build、security、tooling、browser 和 tests，但 tests 作业在 `pull_request` 事件里只跑相关测试：`vitest run --changed <基线>`，`forceRerunTriggers` 扩成“凡不是 `.ts/.tsx/.mjs/.js` 源码的改动都跑全量”（锁文件、配置、`ci/**`、`.github/**`、SQL、JSON、提示词文本、夹具等），另外改到 `scripts/**` 也跑全量。动态 import 和子进程看不到的漏测，由第 2 步的完整 CI 兜住。
- 后续一步（本方案不做）：PR 阶段去掉 browser，只在队列里跑。

### 2. 排队
- 线程原来“等 Andy 说合并后调用合并接口”，改成“给 PR 加 `merge-queue` 标签”。加标签前照旧：复核到 `REVIEW_CURRENT`、PR 上 `ci/required` 成功（或按第 27 行长期授权）。

### 3. 队列处理器（新工作流 `merge-queue.yml`，跑在 `ci-vps-gate` 上）
- 触发：`pull_request_target` 的 labeled、`workflow_run`（CI 完成）、每 10 分钟的 `schedule`、`workflow_dispatch`。`concurrency: merge-queue`，不取消正在跑的。只执行 main 上的脚本，不执行 PR 代码（候选合并只用 git 命令）。
- 状态全部从 GitHub 读（标签、`mq/*` 分支、候选运行结果），不另存数据库。
- 每次触发做一件事：
  1. 有候选正在跑：退出。
  2. 上一个候选跑完且成功：按候选里的顺序，逐个用合并接口合并（`merge`，带 `sha` 等于候选里记下的 PR 头），合完核对 main 的树和候选的树逐字节相同；不同就停队列、在 PR 上评论。去掉标签，删 `mq/*` 分支。
  3. 上一个候选失败：批里只有 1 个 PR 时，把它踢出队列（去 `merge-queue` 标签、加 `merge-queue-failed`、评论失败的作业链接）；多于 1 个时，下一批只取前一半（二分），失败的那批信息写在候选提交说明里。
  4. 没有候选：按加标签的时间取最多 5 个 PR，每个要求 `--assert-reviewed` 打印 `REVIEW_CURRENT`、PR 头上 `ci/required` 成功；以当前 main 为底逐个 `git merge --no-ff` 生成候选，冲突的 PR 踢出并评论；把候选推到 `mq/<序号>`，候选提交说明写清 PR 编号、头提交、main 提交；用 `workflow_dispatch` 触发 `ci.yml`（ref 是候选分支，`base_sha` 是 main 提交），完整跑全部测试。
  5. main 在候选跑的过程中被别的方式改了（不是队列合的）：丢掉候选，下次重建。
- 合并用 `GITHUB_TOKEN`（权限 contents: write、pull-requests: write、actions: write），由前提 6，`main.yml` 不会被触发；候选的完整 CI 就是 main 这棵树的确认，`main.yml` 只在人手合并时运行。

### 4. 规则和文档
- delivery-mode.md 第 27 行和 owner-standing-rules 的“合并由线程执行”改成“线程加 `merge-queue` 标签即完成合并操作，由队列合入”；新 ADR 记决定。
- 事故门槛：队列脚本的单元测试覆盖二分、冲突、树不一致、main 被抢先改、复核未过被拒。

## 放弃的做法
- GitHub 自带 merge queue：不花钱的前提下不用。
- 候选通过后直接把候选推成 main（快进）：要能直推 main，绕过 PR 合并接口，PR 不会显示已合并；改用逐个调用合并接口再核对树。
- 激进版“PR 只跑相关测试、不兜底”：没有队列时漏测会直接进 main，Andy 选了和队列一起做。

## 风险
- 随机失败的测试会把整批拖红，二分要多跑几次；单个 PR 失败可能是随机失败，线程看过后可重新加标签。
- 队列处理器有写 main 的权限，脚本出错可能合进没测过的东西；用“合并接口带 sha + 合完核对树”兜住。
