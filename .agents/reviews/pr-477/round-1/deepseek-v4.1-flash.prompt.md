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
仓库就是当前目录，已检出 37050af31897597f5aaa47238075cbca1c1d6bea。
对比基准是 64f8b0029f0bf17189ca12c75fd9ff8ef4ec761a，先运行 git diff 64f8b0029f0bf17189ca12c75fd9ff8ef4ec761a..37050af31897597f5aaa47238075cbca1c1d6bea 看改动。
作者的说法（可能有错，请核对）：
# PR 477 第 1 轮作者说明
目标：给 iOS 第 11 批导出、文件、登录设备三页补网关能力；不改表，不碰发给模型的内容。决定写在 docs/adr/0263-export-everything-in-one-job-with-progress-and-cancel.md。
1. 导出：DataExportJobs 的一个任务先 buildPortableExport 再 buildChatExport，压缩包里 himawari-export/ 和 himawari-chats/ 两个文件夹并列（createStoredZipOfFolders），各自清单不变。结果多 conversations、messages；对话部分 128 MiB 荷载上限，超过整份失败，网页直接下载 413。
2. 进度：两个 build 函数加 onProgress(textsRead, textsTotal) 和 signal；每段荷载前 throwIfAborted。快照的 progress 只在 running 时有，契约校验段顺序、已读不超总数、总数未知时已读为 0。
3. data.export.cancel：running 时置 cancelled 并 abort，之后 build 的成功和失败回调都不改状态；ready 时丢掉结果；cancelled 重发 replayed；找不到或过期 404；failed 409。取消后马上 start 可能在收尾的几毫秒里得到 DATA_EXPORT_BUSY。
4. files.list 每行 threadTitle：classifiedThreadTitleReader 只给 public、private 分级、text/plain 的标题，每页按对话去重读取；service-main 的审批标题改用同一个函数。
5. login.devices.revoke_others：列出 active 设备、去掉当前 deviceId；没有就 replayed 且不要求最近验证；有就验证一次后逐台 revokeDevice。
有意不做的：网页 /api/data-export/v1/chats 保留（网页还在用）；对话超上限时不退回只导记忆（不交出缺对话的“全部数据”）；revoke_others 中途某台失败时前面已退出的不回滚（和逐台退出一致，重发会继续退剩下的）。
做法只是参考，若你认为有更好的做法请提出。
