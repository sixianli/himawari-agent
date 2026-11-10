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
仓库就是当前目录，已检出 65166549f9c7b1fd0a866c589cc10d51028b36bf。
对比基准是 bf2b7234a6c0020cf47c4c9a86a80e1bca68113a，先运行 git diff bf2b7234a6c0020cf47c4c9a86a80e1bca68113a..65166549f9c7b1fd0a866c589cc10d51028b36bf 看改动。
作者的说法（可能有错，请核对）：
# 复核材料：PR 345 记忆页网页导出

目标：记忆页的“导出全部记忆”改为下载与命令行同格式（himawari.data-export.v1）的 zip，替换原来浏览器里拼 JSON 的下载。网页不提供导入（导入只能进空库）。

改动文件：
- apps/agent-service/src/production-data-export.ts：新路由 GET /api/data-export/v1/archive，store-only zip 写入，只读 SQLite 连接，buildPortableExport，同源检查（Sec-Fetch-Site）、会话认证、单并发、总量 512MB。
- apps/agent-service/src/production-http-composition.ts：注册路由。
- packages/persistence-sqlite/src/data-export/read-only.ts：只读连接。
- apps/control-center/src/data-export.ts 和 components/memory-page.tsx（ExportPanel）：fetch 后下载，显示条数和被扣留处数。
- 三语文案、上线走查新增场景 accept-memory-export / accept-export-requires-login、ADR 0200 第 9、10 条、check:data-export 门槛 44 条。

已核对的事实：
- 导出库（merged PR 340）已有“含机密文字只留占位符、无口令则不带密封文件”的行为，路由不传口令。
- 接口测试 test/integration/data-export-http.test.ts 4 条通过；真实 Chromium 正向下载、未登录 401、跨站 403 手动验证通过；进程级测试和走查需要上线包，本机跑不了。
- 本改动不发模型请求。

请特别核对：认证和主人校验是否与 registerProactiveRoutes 一致；并发标志在异常路径是否复位；buildPortableExport 同步读快照对事件循环的影响；zip 写法（UTF-8 标志、CRC、偏移）；响应头里的数字有没有可验证的定义；文案与行为是否一致。
