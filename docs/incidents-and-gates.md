---
status: active
supersedes: ""
superseded_by: ""
date: "2026-10-29"
---

# 事故与门槛清单

<a id="contents"></a>

这份清单记两件事：Himawari 出过的事故，以及每个事故落下的“门槛”。这里的事故指生产故障、上线失败或回退、上线前很晚才被拦下的问题，以及 Andy 自己用的时候才发现、本来能被检查发现的缺陷。门槛指一道自动运行、不通过就拦住的检查，例如上线脚本的上线前检查、出包检查（生成上线操作包时在测试机 Hermes 上跑的检查）、测试、`npm run check` 里的一项，或者每次使用都会自检的脚本。只写文档或案例不算门槛。

规则（Andy 2026-10-29 00:56 JST 定，[ADR 0107](adr/0107-every-incident-gets-an-automatic-gate.md)）：

- 每个事故都要落成一道门槛，事故才算关闭。
- 同一个错误出现第三次时，必须已经有硬门槛（任何一种测试或可执行的逻辑）挡住第四次。
- 每个线程开工时读这份清单；收尾时在交付报告里写明这次的事故落了哪道门槛（文件或命令），或者为什么不需要，并更新这里的条目。

`npm run check` 会运行 `scripts/check-incident-gates.mjs` 检查本表：状态必须是下面四种之一；“已落门槛”的条目必须在门槛一栏用反引号写出仓库里真实存在的文件；次数达到 3 的条目只能是“已落门槛”“等 Andy”或“仓库外”。

| 状态 | 意思 |
| --- | --- |
| 已落门槛 | 门槛已在仓库里，并且会在规定的时机自动运行 |
| 缺门槛 | 还没有门槛，这个事故没有关闭 |
| 等 Andy | 门槛准备好了或有明确方案，但只有 Andy 能做的决定或操作还没做 |
| 仓库外 | 原因在仓库管不到的地方（例如 Claude Code 自己的权限检查），写明替代做法 |

- [事故清单](#incidents)
- [编码代理反复犯的错误](#agent-mistakes)

<a id="incidents"></a>

## 事故清单

时间都是日本时间（JST）。

| 编号 | 日期 | 现象 | 根因 | 次数 | 门槛（文件或命令） | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| I-01 | 2026-10-25 | 上线后只读回了首页 200 和服务端状态，没人在真浏览器里用一遍；长回答被截断、旧前端、搜索卡 5 分钟、重启后开关勾不上，都是 Andy 自己发现的 | 上线脚本对“在浏览器里按用户的用法走一遍”没有任何条件 | 4 | `scripts/delivery-mode/browser-acceptance-gate.py`：`deploy.sh` 先核对 `test/integration/product-path-browser.test.ts` 的发布走查记录，缺一项就以退出码 5 拒绝上线（[详细](lessons.md#release-without-browser-walkthrough)） | 已落门槛 |
| I-02 | 2026-10-26 | 复制上一次的上线操作包时留下旧文件、旧文件名、旧配置预期，第十次、第十二次上线因此失败或回退 | 操作包靠复制再手改，没有东西机械核对新旧值 | 4 | `scripts/delivery-mode/make-packet.py` 按参数生成操作包，`scripts/delivery-mode/generated-packet-gate.py` 拒绝不是生成器做的包（退出码 6），`scripts/delivery-mode/test_rollback.py` 核对回退步骤名（[详细](lessons.md#copied-packet-stale-names)，[ADR 0086](adr/0086-generate-release-packets-from-parameters.md)） | 已落门槛 |
| I-03 | 2026-10-25 | 生产一直在跑 10 月 7 日的旧前端，设置里的联网搜索开关点不动 | 配置里的前端目录没跟着新版本更新 | 1 | `scripts/delivery-mode/make-packet.py` 发现运行中的前端目录不是当前版本就拒绝出包；`scripts/delivery-mode/packet-template/systemd/verify-switch-config-fixtures.py` 核对切换时写入新前端目录 | 已落门槛 |
| I-04 | 2026-10-25 | 上下文窗口配错，长回答只剩一个字 | 配置里的上下文窗口和输出上限是手抄的 | 1 | `scripts/delivery-mode/instances/andy-production.json` 定目标值，生成器从生产读出原值；发布走查的“长回答从第 1 段到最后一段都显示”一项（`test/integration/product-path-browser.test.ts`） | 已落门槛 |
| I-05 | 2026-10-19 | 第 0 层（改代码前后跑的定向测试）漏跑直接相关的测试，第 2 层或 main 上才暴露 | 选测试清单靠人想；检查钩子只装在 Andy 的 Mac 上，云端会话没有，快速模式下又直接放行 | 7 | 第 7 次是 `bd04dd1`（2026-10-28，门槛进仓库之前），见 I-22；现在对它运行 `check-commit` 会以 `L0_RELATED_TESTS_UNDECLARED` 拒绝并点名 `test/integration/thread-run-lifecycle.test.ts`。检查脚本 `scripts/layer0-tests/check-layer0-tests.py` 和钩子 `scripts/git-hooks/commit-msg`、`scripts/git-hooks/pre-push` 已放进仓库，快速模式下也检查；`npm run check` 里的 `scripts/check-layer0-hooks.mjs` 把 git 指向这些钩子；`test/tooling/layer0-hooks.test.mjs` 证明缺声明会被拒（[ADR 0108](adr/0108-layer0-check-in-repository-and-fast-mode.md)，[详细](lessons.md#layer0-related-tests)） | 已落门槛 |
| I-06 | 2026-09-29 | 提交 `51fe7f6` 改了网页代码却没重新封存对应的操作手册，之后文档严格校验一直失败 | 改代码时没人核对受影响的文档 | 1 | `scripts/check-docs-governance.mjs`（`npm run check:docs`，每次提交前跑；快速模式下只放过操作手册封存过期两类问题） | 已落门槛 |
| I-07 | 2026-10-28 | 第十八版切换后 worker（执行命令的后台进程）报 `WORKER_STARTUP_TIMEOUT`，自动回退，停服约 9 分钟；回退后第十七版第一次启动也超时一次，第十七版上线时已超时 2 次 | worker 只等 agent 30 秒，agent 启动要 35–55 秒：启动时对沙箱运行目录 34456 个文件逐个检查权限，串行约 28 秒。启动成不成看运气 | 4 | `scripts/delivery-mode/packet-template/systemd/S7-startup-readback.mjs`：切换后从 worker 启动到两边都就绪超过 30 秒（`scripts/delivery-mode/instances/andy-production.json` 的 `startupReadyBudgetSeconds`）就判失败；`scripts/delivery-mode/make-packet.py` 要求这个上限再加 15 秒余量不超过 worker 的等待时间，否则拒绝出包；夹具 `scripts/delivery-mode/packet-template/systemd/verify-startup-readiness-fixtures.mjs` 每次出包都跑。慢的那一步由 PR #89 修复（权限检查改到后台线程，worker 等待改为 45 秒） | 已落门槛 |
| I-08 | 2026-10-28 | #80 改了界面（搜索授权从复选框改成开关、过程默认折叠、记忆移出设置），发布走查测试没跟上，第十八版出包时才被拦下，又多做一个 PR（#87）和一次出包 | 走查测试里的页面定位是写死的字面量，界面改动时没有任何测试会失败 | 1 | `apps/control-center/test/release-walkthrough-ui.ts` 是走查定位的唯一来源；`apps/control-center/test/release-walkthrough.unit.test.ts` 用真实网页组件按走查的顺序点一遍，并核对走查代码不再自己写定位；`npm run check:release-walkthrough` 在 `npm run check` 里，每次提交前跑 | 已落门槛 |
| I-09 | 2026-10-25 | Mac 远程会话里，Andy 在项目聊天说过的授权（“合进 main”“上线第十次”“上”）和点过的选择卡不被认，又要他在线程里亲手再打一遍；只读诊断也被拦过 | Claude Code 远程会话的自动权限检查只认 Andy 在该线程亲手打的字，协调者转达和选择卡都不算 | 7 | 不在仓库里，没法加测试；第 7 次是 2026-10-29 01:37，第十八版包出好、预检全过后，Andy 睡前在项目聊天“提前同意”的上线仍被拦下 `deploy.sh`。替代做法：合并 PR 交给云端线程代合；在 Mac 远程会话里上线前，协调者先请 Andy 在该线程亲手打一句短授权，提前同意和转达都不算，不先发选择卡（项目记忆 no-repeat-authorization）。在 `deploy.sh` 里加不拦人的提示不算门槛，所以没加 | 仓库外 |
| I-10 | 2026-10-28 | 第十六版上线后，模型跑任何命令都在执行前被拒，连 `echo done` 都报 `PI_SHELL_EFFECT_SCOPE_INCOMPLETE`；出包线程做浏览器验收时才发现，第十七版修复（PR #79） | PR #64 只给命令读、新建、修改三项权限，沙箱里的旧检查要求同时有移动和删除权限；#64 没跑端到端验收，发布走查也没有“模型跑一条命令”这一项 | 1 | 这个具体错误有测试 `packages/platform-node/test/sandboxed-coding-operations.unit.test.ts`。发布走查 `test/integration/product-path-browser.test.ts` 新增 `accept-run-command`：让模型跑一条统计行数的命令，必须在回答里看到命令真实算出的 `lines=37`；`scripts/delivery-mode/browser-acceptance-gate.py` 把它列为必过项，没过 `deploy.sh` 以退出码 5 拒绝上线。`test/tooling/walkthrough-command-permissions.test.mjs` 核对走查安装给每个文件工具开放的目录权限和生产签名脚本 `cloud-seal.mjs` 一致，避免走查装的权限和生产不同而放过问题。在 Hermes 上用第十六版安装包复现时这一项报 `PI_SHELL_EFFECT_SCOPE_INCOMPLETE` 失败，用第十八版安装包时 7 项全过 | 已落门槛 |
| I-11 | 2026-10-29 | 生产对话报“查找相关记忆时，连接模型服务失败”（11:25 发现）；网关对同一账号的请求返回 402 `User budget exceeded. Current spend: $3.16, limit: $3.00` | 评测线程没报费用就同时跑了三个模型的真模型评测（约 1.0 美元），把 Vercel 按人汇总的“用户预算”（3 美元）推过上限；生产 key 和评测 key 都是 Andy 建的，共用这条预算。生产只记下 `transport_unresolved` 和 `CONTEXT_MEMORY_UNAVAILABLE`（11:11:07 起 4 次嵌入失败），没存网关原文；页面也把“额度被拒”说成“连接失败” | 1 | `scripts/jarvis-test/live.mjs` 不带 `--confirm-cost` 不开跑，开跑前先发 1 个 token 试探网关，被拒就不跑；`test/tooling/jarvis-test-history.test.mjs` 两条测试，在 `npm run check` 里自动运行（[ADR 0109](adr/0109-paid-eval-runs-need-cost-cap-and-preflight.md)）。可观测性：嵌入失败写一行 `memory.embedding_failed` 日志，带 HTTP 状态和网关原文；402 时运行失败码改为 `CONTEXT_MEMORY_QUOTA_EXCEEDED` / `PI_MODEL_QUOTA_EXCEEDED`，网页用三语说明是额度被拒，不是网络问题（测试 `packages/memory-engine/test/hybrid-memory-provider.unit.test.ts`、`apps/control-center/test/execution-view.unit.test.ts`、`packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts`）。根治要 Andy 把 Vercel 预算改成按 key 设 | 等 Andy |
| I-12 | 2026-10-28 | Andy 两次指出网页里模型的回答整段都像粗体（第一批界面意见第 9(c) 条、2026-10-29 12:01 的新闻回答）；第一次只查了 Markdown 渲染代码，结论是“疑为模型输出 `**`”，没有修掉 | `apps/control-center/src/review-v4.css` 给整个页面设了 `font-weight: 430`。苹方等中文字体只有 400、500、600 几档固定粗细，浏览器按 CSS 字体匹配规则把 430 取到 500（中粗），模型真加粗的 `**…**` 也只到 600，于是全文看起来一样粗。模型这轮只加粗了文件名，系统提示里的加粗规则是守住的 | 2 | `test/tooling/answer-font-weight.test.mjs`：样式里出现非整百的字重，或回答所在的容器（`.app-shell`、`.chat-turn`、`.assistant-markdown` 等）设了 400 以外的字重，测试就失败；`npm run check:answer-weight` 在 `npm run check` 里，每次提交前跑。把 `430` 放回去时两项都失败，去掉后通过（[案例 49](engineering-casebook.md#case-answer-weight)） | 已落门槛 |
| I-13 | 2026-10-29 | Andy 在记忆页“时间线”里先点了一个筛选，再看其他筛选按钮，数字全是 0；点“更正”后又变成 3。“全部记忆”里选了“偏好 5”，状态行仍写“在用 12”，和选了“偏好”后真正能看到的条数对不上；页面还没拿到数据时“全部记忆”标签和页头先显示 0 | 时间线的每个计数是在“已按当前筛选过滤后”的列表上数的，所以没选中的类型永远是 0；全部记忆的状态行数的是全部记忆，没有跟着已选的大类和搜索词，大类行也不跟搜索词；数据到达前组件把空列表的 0 当成真实数字显示 | 1 | `apps/control-center/test/memory-interactions.unit.test.ts` 的“every filter number is what clicking that filter shows”：在时间线和全部记忆（含搜索词）里把每个带数字的筛选依次点两轮，要求点开后看到的条数等于按钮上的数字；“shows no counts before the memories arrive”要求数据到达前标签和页头不出现数字。文件页的“N 个文件”在服务器还有下一页时写成“N+”，由 `apps/control-center/test/files-library.unit.test.ts` 检查。在修复前的代码上前两项分别报“整理 0 点开有 1 条”“在用 7 点开只有 3 条”和“全部记忆0”，修复后通过 | 已落门槛 |
| I-14 | 2026-10-29 | iPhone 主屏应用里一点输入框整页放大不回弹（记忆页、对话框、记忆编辑左右被切、按钮只露一半）；设置面板关闭按钮落在状态栏下面点不到，退不出通知设置。Andy 自己发现 | 输入框字号继承根字号 14px，对话框的 `:focus` 规则把手机上的 16px 改回 14px，iOS 对小于 16px 的输入框聚焦即放大；弹窗最大高度 `100vh - 2rem` 没扣状态栏和底部横条的安全区，整块弹窗一起滚 | 1 | 每次提交：`scripts/check-phone-layout.mjs`（`npm run check:phone-layout`，在 `npm run check` 里）要求手机输入控件 16px 的统一规则存在、别处没有能压过它的 `!important` 或内联字号、viewport 不禁缩放、弹窗高度扣安全区且内容单独滚动，`test/tooling/phone-layout-check.test.mjs` 证明它对旧写法报错。上线前：`test/integration/product-path-browser.test.ts` 新增 `accept-phone-layout`（393×852 手机尺寸下逐个聚焦输入控件量字号、页面不许横向溢出、设置每个分类的弹窗和关闭按钮在屏幕内、记忆页每个标签），`scripts/delivery-mode/browser-acceptance-gate.py` 列为必过项 | 已落门槛 |
| I-19 | 2026-10-29 | Andy 在 Vercel 账单页看到本月 `anthropic/claude-sonnet-5.5` 花了 2.27 美元（793 次请求，缓存 0%），超过生产主模型 DeepSeek V4.1 Flash 的 1.48 美元：10-28 Jarvis Test 裁判三段共 0.94 美元，10-29 三模型对比评测约 1.33 美元（[ADR 0111](adr/0111-no-expensive-models-anywhere.md#bill)） | 评测第二层裁判在代码里写死了 Sonnet 5.5（ADR 0103 只要求“异厂”，没比价格）；对比评测又把 Claude 写成可选被测模型；没有任何检查看代码里用的是什么价位的模型 | 2 | `scripts/check-expensive-models.mjs`（`npm run check` 的一步，`test/tooling/expensive-models.test.mjs`）：代码、脚本、评测和配置里出现 `anthropic/`、`openai/` 或 Claude、GPT 型号名就失败；裁判模型集中在 `test/fixtures/jarvis-test/models.json`，10-29 先改 Qwen3.8 Flash，Andy 当天改选 GLM 5.3 Flash | 已落门槛 |
| I-22 | 2026-10-29 | `main` 上 `test/integration/thread-run-lifecycle.test.ts` 有 4 条测试从 10-28 21:51 起一直失败，到 10-29 15:16 才由 UI 第二批线程报出；中间 `32e2c0a` 的线程已经看到这 4 条失败，只在提交说明里写“未改动的 main 上同样失败”就推送了 | `bd04dd1` 把发给模型的最后一条用户消息改成 `<himawari-context>` 加 `<owner-message>` 两段，这个测试仍断言旧的纯文本。当时第 0 层的测试清单靠人挑，漏了它（I-05 第 7 次）；GitHub Actions 关着（[ADR 0092](adr/0092-pause-github-actions.md)），快速模式不跑全量测试，没有任何地方会跑到它；看到失败的线程也没有义务去修或上报 | 1 | 漏选这一步：I-05 的检查现在会拒绝 `bd04dd1`（已复现）。“声明了的相关测试其实是红的仍能推送”还没有门槛。方案：`scripts/layer0-tests/check-layer0-tests.py` 的推送前检查在非 Mac 的机器上真的跑一遍推送提交声明的相关测试，有失败就拒绝推送；代价是每次推送多等这些测试的时间，而且云端容器以 root 运行时 `packages/runtime-sandbox/test/container-execution-backend.unit.test.ts` 本来就有 12 条失败（2026-10-29 本线程实测），要先处理，否则改沙箱代码的提交在云端推不上去。等 Andy 决定 | 等 Andy |

[↑ 回到开头](#contents)

<a id="agent-mistakes"></a>

## 编码代理反复犯的错误

编码代理（Claude、Codex、opencode 等替 Andy 写代码、跑测试的程序）自己反复犯的错误，按 [ADR 0060](adr/0060-hard-constraint-on-third-repeat.md) 记在 [docs/lessons.md](lessons.md)，每条都写了第三次之后加的硬约束和它在哪里运行。那里的约束很多在本机的 `.ci-output/` 或 `agent-skills` 仓库里，不在本仓库，所以不进上面的表；它们出现新的一次时，在 lessons 对应条目下追加，如果那一次造成了事故，再在上表加一行。

[↑ 回到开头](#contents)
