你是独立的代码复核者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
系统的真相在代码里。下面「作者的说法」可能有错，每一条都要对照代码核对；发现说法和代码不一致，要明确指出。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.agents/instructions/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
你的额外侧重：错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销的操作，以及规则文件、说明文档和代码是否一致。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你查过的这类路径和结论。
输出格式：按严重度从高到低排列，每条意见单独一个以「### 」开头的三级标题（标题里写序号、严重度和一句话问题），下面写：文件:行、问题、证据（引用你亲自读到的那几行代码）、建议；意见以外的内容不要用三级标题。把「读代码证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 d38fb34d1958928ed8b68fa6f4ea0ca773bf1817。
对比基准是 011f5807854a264768e6976eefac95831f8e6df5，先运行 git diff 011f5807854a264768e6976eefac95831f8e6df5..d38fb34d1958928ed8b68fa6f4ea0ca773bf1817 看改动。
上一轮复核到 af47ef8d09c9e70313b11a5aa1e56b35630808b4，这一轮先看 git diff af47ef8d09c9e70313b11a5aa1e56b35630808b4..d38fb34d1958928ed8b68fa6f4ea0ca773bf1817 的增量，只做三件事：一、下面列出的上一轮意见是否真的改好了；二、增量改动的那些行有没有新错；三、增量产生或修改的值（导出的函数、配置键、字段、格式）的直接使用端能不能接受，用 git grep 找。增量没有碰到、行为也没被增量改变的旧代码前几轮已经复核过，不必整份重读；但证据指向旧代码时要跟下去。必答问题照样回答，和这次增量无关的，一句话写明不涉及即可。结论里写清这一轮查过哪些范围。
上一轮的判断记录没有提交或读不出来，没有带入。
作者的说法（可能有错，请核对）：
# PR 634 删掉推送延后判断：材料

## 问题和目标
ADR 0285（docs/adr/0285-one-main-thread-subthreads-and-one-inbox.md）第 4 条和设计文档 docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md 第 1 步：去掉 ADR 0273 的“主人在忙就先不推送”判断（Jev 推送时机判断）。推送以后只由主人定的安静时段规则（ADR 0244 推送闸门）延后；推送闸门里“主人正在看 App 就不弹”的判断保持不变。

## 约束
- 迁移不改旧迁移文件，编号用 migration:new 生成。决策记录相关表冻结（decision_ledger、decision_signals、web_push_feedback 不得加迁移改动）。
- 不写代码注释；理解用户意思不用词表。
- 生产配置里可能还留着 runPolicy.deliveryTiming，新版不能因此起不来。

## 作者的说法（请核对）
1. 删掉的：推送时机判断、判断用的来源和设置、delivery_timing.settings.read/snapshot/change 三个网关操作和 iPhone 的“通知”调节页、push.delivery-timing-question 提示词、WebPushStorePort.recordDeliveryTiming 和 deferredByTiming、实测评测和夹具。新迁移删 delivery_timing_settings 表。
2. 决策记录种类 delivery_timing 保留，旧记录仍能读出；只删了写这种记录的代码。
3. runPolicy.deliveryTiming 是退役键：配置解析接受并忽略它，启动时写 configuration.key_retired。
4. Mac 在线窗口改成固定 300 秒（原默认值），在 apps/agent-service/src/mac-placement.ts；测试检查 Mac App 假定的 30 秒不超过它。
5. 推送仍按安静时段延后；正在看 App 时不弹的行为不变（push-channels.test.ts 的对应用例通过）。
6. 合并 main 时 clients/apple/Sources/HimawariShell/DemoScenes.swift 有一处冲突：保留 main 新加的 .her 系列场景，去掉 .notifications 和 .notificationsEdit。

## 第 3 轮新增：修 main 浏览器检查（提交 d38fb34d1）
main 的浏览器检查在 PR 631（固定主对话）之后三个引擎都红：首次打开用例等 thread.create，测试服务器不认 thread.main。本提交：测试服务器加 thread.main（独立空主对话 thread-home）和 /__fixture/finish-runs；用例改为只发 thread.message.submit 到主对话；网页端在主对话查到之前不显示输入框（避免输入框被换掉丢焦点）、设置页打开时不自动跳主对话、侧栏“主对话”入口显示后台在跑/待处理标记。请重点看 thread-control-center.tsx 里 openingMain 的条件（查询失败时能否回到原来的输入框、route.status 或其他页面时不会卡在骨架屏）。
