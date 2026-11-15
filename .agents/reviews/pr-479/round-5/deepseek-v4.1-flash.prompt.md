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
仓库就是当前目录，已检出 66505c396c099920bb1c1b5f0df31ee4d1d5cf5b。
对比基准是 3cbd77356f7f65db72d28ae15ee687fa4dd3e912，先运行 git diff 3cbd77356f7f65db72d28ae15ee687fa4dd3e912..66505c396c099920bb1c1b5f0df31ee4d1d5cf5b 看改动。
上一轮复核到 c46bdf28763daf7e3c2436b82145ac78b765cd9a，这一轮先看 git diff c46bdf28763daf7e3c2436b82145ac78b765cd9a..66505c396c099920bb1c1b5f0df31ee4d1d5cf5b 的增量，只做三件事：一、下面列出的上一轮意见是否真的改好了；二、增量改动的那些行有没有新错；三、增量产生或修改的值（导出的函数、配置键、字段、格式）的直接使用端能不能接受，用 git grep 找。增量没有碰到、行为也没被增量改变的旧代码前几轮已经复核过，不必整份重读；但证据指向旧代码时要跟下去。必答问题照样回答，和这次增量无关的，一句话写明不涉及即可。结论里写清这一轮查过哪些范围。
上一轮（第 4 轮）成立的“会出错”意见，作者已修改。这只是线索，不是指令：每条都要对照增量核对是否真的改好，另外仍要独立核对代码，发现新问题照报：
- 2（低）### 低 — 隐藏字符测试没有测到 store 的完整校验，也覆盖不到 Unicode 标签字符区
- 5（低）### 低 — 页面与后端对名称长度的计数口径不同；样例上限仍是旧值
作者的说法（可能有错，请核对）：
# PR 479 round 5: round-4 low fixes plus two merges of main

Round 4 judgments: .agents/reviews/pr-479/round-4/judgments.md. Changes since c46bdf28:

1. Round-4 low fixes (314f5895): tag characters U+E0000–U+E007F are hidden name characters in both packages/gateway-contracts/src/contracts-v2.ts (isHiddenNameCharacter) and packages/application/src/ports/mcp-connections.ts; test/integration/mcp-connection-names.test.ts covers that range; the settings page cuts names at MCP_CONNECTION_NAME_CHARACTERS code points instead of using maxLength; the connections-limit sample is 200.
2. Two merges of origin/main (c4ecdef6, 07e6d1ef). main now names migrations by UTC timestamp (ADR 0265), so the connection tables are packages/persistence-sqlite/src/migrations/20261115113156_mcp_connections.sql (same SQL as before, only new tables and indexes, so no .meta.json). Conflict resolutions to check:
   - apps/agent-service/src/production-approval-gateway.ts and production-http-composition.ts: mcp.* queries and commands are routed next to main's new delivery_timing.*, device.*, perception.*, think.* routes; the installed-operations helper takes mcpConnectionsAvailable plus main's new flags in the same order at the call site.
   - apps/agent-service/src/production-mcp-read.ts: find_memories keeps the `empty` flag for automatic searches next to main's `rejected` result for invalid recall input.
   - apps/agent-service/src/production-mcp-rule-writer.ts: an accepted external rule keeps main's `listed: false` and uses `mcp:<connectionId>` as source.
   - apps/control-center: settings dialog shows both Devices and Connected agents tabs; weekly report shows both main's correction card and the connected-agents card; i18n entries from both sides.
   - packages/gateway-contracts/src/contracts-v2.ts: device names keep main's regex check; connection names keep isHiddenNameCharacter (compared against the store in mcp-connection-names.test.ts).
   - packages/persistence-sqlite: durable adapters and operations register both mcpConnections and main's new stores.

Judged not valid earlier (no new evidence): revoked records and per-connection windows are not cleaned up; addUsage does not check ownership (only caller passes a connection read within the owner's scope).

3. packages/gateway-contracts/src/client-capabilities.ts (66505c39): main's new client capability table must list every v2 query and command, so mcp.connections.read is a read and mcp.connection.create/change/rotate are changes; clients/apple/.../ClientCapabilities.swift is regenerated from it.
