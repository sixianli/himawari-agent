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
仓库就是当前目录，已检出 a97ab3b139eba4a3a3120506e0a0eb31729c5543。
对比基准是 5e06602c1a8d4e5aef04e07585734e25e657c2ed，先运行 git diff 5e06602c1a8d4e5aef04e07585734e25e657c2ed..a97ab3b139eba4a3a3120506e0a0eb31729c5543 看改动。
上一轮复核到 4e612519b2479e143990901ed3ffcd67ec4297b6，先看 git diff 4e612519b2479e143990901ed3ffcd67ec4297b6..a97ab3b139eba4a3a3120506e0a0eb31729c5543 的增量，但可以读任何文件。
作者的说法（可能有错，请核对）：
# 复核材料：iOS 第 2 批客户端第 3 轮（4e612519b 之后的两个提交）

## 改了什么
1. e7f033765：只在 DEBUG 编译的示例数据场景（HimawariChat/DemoChat.swift、HimawariShell/DemoScenes.swift），以及 scripts/ui-review.sh（在 Mac 上用 Xcode 和模拟器按场景截图、录屏，--check 和已存的快照逐像素比对，--approve 存快照）、scripts/compare-snapshots.swift、共享的 Xcode scheme。
2. a97ab3b13：第 2 轮意见的修改。
   - ChatStore.flush 改成循环，每轮发完、排重试、刷新列表后再看 flushAgain。
   - 钥匙串读取分成有、没有、读不到（KeychainValueStore.presence、SecureEnclaveKeys.presence）；AppModel.restore 读不到时显示“钥匙读不到”而不清数据，回到前台再试；确实没有才 forget。
   - DeviceAPI.executionRecords：过程记录翻页，每页必须前进且非空，最多 pageLimit=100 页；fullThread 同样加空页和页数上限。
   - texts：整批都被延后时返回已取到的部分。
   - ProcessLine 新增 failed（运行以 failed 结束），收起行用 alert-circle；“等你点头”只在按 sequence 最新的一条记录是 waiting 时显示，kind=status 的 waiting 用最后一个工具步骤。
   - PairingRequestLimits.deviceName 按 UTF-16 单元截 64、按字形不拆、去控制字符，对齐 PR 404 的 boundedString（input.length，拒绝 <0x20 和 0x7f）。
   - check-design.mjs 的颜色和数值规则补上真实写法。

## 目标和约束
- 服务器接口在 PR 404（分支 origin/claude/project-thread-xuqee1）。
- 不许写注释；能从服务器拿的值不写死；界面照 Andy 批准的原型 v2。
- 示例场景只为截图验收，不能进 Release 包。

## 已核对的事实
- Linux Swift 6.2.1 上 swift test 80 条全过；界面目标只能在 Mac 上用 Xcode 编译，云端只做了 swiftc -parse。
- activity、activityIcon 字段的服务器部分由另一个线程做，本 PR 只消费。

## 请重点看
1. 第 2 轮的修改是否真的修好，有没有引入新问题（flush 循环会不会空转或和 scheduleRetry 打架；钥匙串“读不到”会不会让用户永远卡住；deviceName 截断边界）。
2. DEBUG 示例代码会不会漏进 Release，ui-review.sh 在路径含空格、模拟器不存在、Xcode 没装时是否给出明白的错误而不是误报通过。
3. 快照比对的阈值会不会让真实回归蒙混过关。
4. Swift 6 严格并发下可能编译不过的写法。
