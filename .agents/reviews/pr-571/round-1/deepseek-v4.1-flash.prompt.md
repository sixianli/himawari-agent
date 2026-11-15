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
仓库就是当前目录，已检出 a4c09a077e7a40e8620d0fa26e0697e76f855b26。
对比基准是 3800398f5ea54d9880bfcb54cfea8e669d5d23ef，先运行 git diff 3800398f5ea54d9880bfcb54cfea8e669d5d23ef..a4c09a077e7a40e8620d0fa26e0697e76f855b26 看改动。
作者的说法（可能有错，请核对）：
# PR 571 复核材料

问题：第二十九次上线（main 08f181e5）在停服前的 S6_ACCEPTANCE 失败。报错原文是 `RESOURCE_SAMPLING_FAILED_SCENE_RETAINED_NO_AUTOMATIC_DELETION`，同时 resources 阶段报了 `[Errno 2] No such file or directory: '/tmp/hy5ct/r8-use-RByZBv/3/private/node-compile-cache/v22.22.3-x64-9de703df-999/e283c256.ktzuYx'`。scripts/delivery-mode/packet-template/acceptance/cloud/run-stage-03.py 的 Resources 采样器每 5 秒用 directory_bytes（os.walk 加 lstat）统计验收临时目录的大小。Node 的编译缓存临时文件被列出之后、lstat 之前被删掉了，采样器把这个 FileNotFoundError 记进 errors，结果整次验收判为失败。

做法：新增 file_bytes。遇到 FileNotFoundError 按 0 字节计，其他异常照旧抛出。directory_bytes 改为调用它。test_make_packet.py 新增 AcceptanceScratchSamplingTest：用 ast 取出真实的两个函数，模拟“列出后被删”和“权限错误”两种情况。同时更新 INTENDED_CHANGES，并在事故清单加 I-107。

请特别查：
- 忽略 FileNotFoundError 会不会掩盖真正的问题，例如临时目录整个被删、或者统计偏小导致越过磁盘门槛。
- self.scratch.exists() 和 os.walk 的其他竞态。os.walk 默认忽略目录列出错误。
- 包里有没有其他副本或摘要清单（例如 OWNED-SHA256SUMS、cloud-inputs 的摘要、basis-04 下的副本）需要同步更新，以及出包检查 verify-packet-consistency 会不会因为摘要变化而拒绝。
