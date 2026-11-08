你是独立的代码复核者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
系统的真相在代码里。下面「作者的说法」可能有错，每一条都要对照代码核对；发现说法和代码不一致，要明确指出。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
你的额外侧重：错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销的操作，以及规则文件、说明文档和代码是否一致。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你查过的这类路径和结论。
输出格式：按严重度从高到低排列，每条写：严重度、文件:行、问题、证据（引用你亲自读到的那几行代码）、建议。把「读代码证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 338e5ff46db6500befbed430adc7900b54a2269f。
对比基准是 171e8f8212c4e218ac8a12b729da194214dd0075，先运行 git diff 171e8f8212c4e218ac8a12b729da194214dd0075..338e5ff46db6500befbed430adc7900b54a2269f 看改动。
作者的说法（可能有错，请核对）：
# PR 289：云端复核默认经 Magpie，并加入 OpenDesign

## 问题和目标

PR 281 让复核脚本 `scripts/model-review/opencode-review.mjs` 可以加 `--gateway magpie`，经每次运行自起的本机 Magpie 调模型（ADR 0178）。Andy 验收后要求：一、云端复核默认走 Magpie；二、加入他新开的 OpenDesign 包月套餐，固定顺序 CodeBuddy → OpenDesign → OpenCode Go。

## 约束

- Mac 上没有出口代理代填凭证，只能直连 Go，所以默认值不能写死成 Magpie：由环境变量 `HIMAWARI_REVIEW_GATEWAY` 决定，命令行 `--gateway magpie|direct` 优先，都没有时直连。
- 测试结果不能受云端环境变量影响。
- 密钥只在云端环境的网络密钥里，由出口代理代填；仓库、容器、Magpie 配置里都不能有真密钥。
- 现有的费用插件、每模型 0.2 美元上限、先问线、积分底线 20、账本校验、开跑前自检都不能被削弱。
- 发给模型的内容只追加（`.claude/rules/prompt-prefix.md`）。不写代码注释。

## 作者的说法（请逐条核对）

1. `parseArgs(argv, { defaultGateway })`：没写 `--gateway` 时用 `defaultGateway`；只认 `magpie`、`direct`，别的值报 `ARG_INVALID HIMAWARI_REVIEW_GATEWAY`；`direct` 等于不走网关；`--assert-reviewed`、`--report` 子命令不受环境变量影响。`main` 传入 `process.env.HIMAWARI_REVIEW_GATEWAY`。
2. `vitest.workspace.ts` 给 tooling 项目把 `HIMAWARI_REVIEW_GATEWAY` 设成空串，用 workspace 配置跑时子进程读到的是空（实测过）。
3. `gateway.json` 新增 `opendesign`（`kind: "custom"`、`url`、`models`），成员顺序 CodeBuddy、OpenDesign、Go，`routing=order`、`stays=session`；OpenDesign 按 Go 的单价记账（包月，Andy 确认）。
4. 文档 `.agents/instructions/model-review.md` 和 ADR 0178 后续与代码一致。

## 实测

`test/tooling/review-gateway.test.mjs` 41 条（含经 Magpie 的真实自检和故障转移探针）、`opencode-review.test.mjs` 通过；经 Magpie 的真实请求：CodeBuddy 可用时都由 CodeBuddy 回答，去掉 CodeBuddy 后都由 OpenDesign 回答；`npm run check` 41 步通过。

请重点查：默认值的优先级和错误路径（环境变量拼错、子命令、自检模式）、测试隔离是否完整（不用 workspace 配置直接跑 vitest 时会怎样）、自定义服务方 `opendesign` 的配置校验和用量记账、文档和代码是否一致。
