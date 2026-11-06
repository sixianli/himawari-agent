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
你的额外侧重：测试有没有覆盖这次改动、文档和规则与代码是否一致；挑一条最普通的使用流程，从入口走到结束，标出经过的、没有测试覆盖的代码路径。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你走过的流程和结论。
输出格式：按严重度从高到低排列，每条写：严重度、文件:行、问题、证据（引用你亲自读到的那几行代码）、建议。把「读代码证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 917767327922a37faf264605f1c8b7ca12e5b113。
对比基准是 1f12c92f5df8e209f5bfda38b182e772601ba01f，先运行 git diff 1f12c92f5df8e209f5bfda38b182e772601ba01f..917767327922a37faf264605f1c8b7ca12e5b113 看改动。
作者的说法（可能有错，请核对）：
# 作者说明

## 要解决的问题

`scripts/delivery-mode/` 下 4 个 Python 单元测试 `test_deploy.py`、`test_rollback.py`、`test_release_cleanup.py`、`test_untested_claims.py` 没有任何自动运行点（不在 `npm run check`、CI 或钩子里）。它们覆盖部署前检查、回退计划、上线后清理和提交说明里“未测试声明”的格式门槛。`docs/incidents-and-gates.md` 的 I-02 行把 `test_rollback.py` 列为门槛，但它从来不会自己运行。快速模式下本地 `npm run check` 是合并前必过的检查（`.agents/instructions/delivery-mode.md`），所以接进这里。

PR 269 已合并（它加了 `check:delivery-packet` 和 `check:check-runner`），本 PR 从合并后的 main 开始。

## 改动

1. `package.json`：新增 4 个步骤 `check:delivery-deploy`、`check:delivery-rollback`、`check:delivery-cleanup`、`check:untested-claims`，都是 `python3 -I <文件>`，放进 `check:steps`，排在 `check:delivery-packet` 之后、`check:check-runner` 之前。
2. `test/tooling/run-all-checks.test.mjs`：断言这 4 个步骤在 `check:steps` 里，防止被悄悄去掉（`check:check-runner` 在本地运行这个文件）。
3. `scripts/delivery-mode/test_rollback.py`：原来模块加载时读环境变量 `ROLLBACK_TEST_PACKET`（一个真实上线包的目录），没有就 `KeyError`，整个文件无法运行。现在 `PlanTest` 自己用 `make-packet.py` 的 `render()` 和 `fixtures/twelfth-parameters.json` 把模板渲染成上线包，把 `inputs/bindings.draft.json` 里的 `S0_DB:<键>` 占位换成固定的测试值（schema 取参数里的 `CURRENT_SCHEMA`，身份和权限取文件里已有的 `DEPLOYMENT`），写成 `inputs/bindings.json`。`PlanTest` 检查的是模板、`rollback.py` 和 `deploy.sh` 三者之间的一致性（步骤名在步骤表里、恢复点报告名、生成的回退批准能过包里的维护检查），不依赖生产上读出来的真实值。出现新的 `S0_DB:` 键而测试没有对应值时 `KeyError`，测试失败，提醒补值。不再读 `ROLLBACK_TEST_PACKET`：仓库里没有任何地方设置它（`grep` 只在这个文件里），保留两条路径会让 `npm run check` 跑的和手动跑的不是同一份输入。

## 已核对的事实

- Hermes（hermes-home，Python 3.12.10）上，改动前：`test_deploy.py` 62 个、`test_release_cleanup.py` 44 个、`test_untested_claims.py` 13 个用例全过；`test_rollback.py` 因 `KeyError: 'ROLLBACK_TEST_PACKET'` 无法运行。直接把渲染出的 `bindings.draft.json` 当 `bindings.json` 用时，`PlanTest` 3 个用例报 `KeyError: 'recoveryS0_DB:schema.currentId'`，所以要替换占位。
- `test_deploy.py` 的 `test_real_seal_template_roots_let_every_command_link_resolve_on_this_host` 检查运行机器的 `/usr/bin` 链接，在 Hermes 上通过；`npm run check` 只在 Hermes 和 Hermes 上的 CI runner 上跑。
- 正向、反向验证结果见提交说明。

## 请重点看

- `with_s0_readback` 的替换会不会让 `PlanTest` 变成“永远通过”：例如把 `rollback.py` 的 `RESTORE_ACTION` 改回历史上出错的 `S9_RAW_RESTORE56` 时，它是否仍然失败。
- 4 个新步骤每一步失败时 `npm run check` 是否退出非 0。
