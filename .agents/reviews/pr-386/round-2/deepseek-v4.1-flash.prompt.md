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
仓库就是当前目录，已检出 e1428183701470abd4b1d23adc58a5306970551f。
对比基准是 949d2fa91eefbcc9fc834c9625be505792e473c9，先运行 git diff 949d2fa91eefbcc9fc834c9625be505792e473c9..e1428183701470abd4b1d23adc58a5306970551f 看改动。
上一轮复核到 97d505ed2660d85205de946ec369765590596707，先看 git diff 97d505ed2660d85205de946ec369765590596707..e1428183701470abd4b1d23adc58a5306970551f 的增量，但可以读任何文件。
作者的说法（可能有错，请核对）：
# PR 386 复核材料

## 改动目的
P2-3（ADR 0213）把主人在对话里立的长期规则存在 rule_book_rules，编号以 owner: 开头，Gmail 检查每次执行。对外只读 MCP 入口（ADR 0219）的 rule_book 工具原来只列 ruleBookFor 的四条内置规则。本 PR 让它在内置规则之后列出主人规则（ADR 0219 决定 8）。

## 改了什么
- apps/agent-service/src/production-mcp-read.ts：sources 新增可选 ownerRules；#ruleBook 按 ruleId 排序后追加 ownerRuleEntry；能执行（enforceableOwnerRule）的带 gate、outcome、参数，否则 enforced:false、不带参数。
- apps/agent-service/src/service-main.ts：生产传 repository.ownerRules().list({includeRetired:false})。
- packages/prompt-catalog/src/tools.ts、prompt-manifest.json：rule_book 工具说明更新。
- docs/adr/0219：决定 8。
- test/integration/mcp-read.test.ts：一条能执行、一条类型不认识的主人规则。

## 作者说法
- Himawari 自己发给模型的请求一字节不变：mcp.rule-book 只用于对外 MCP 工具说明。
- 已撤销的规则不列；待重新确认（needs_review）照常列，因为 ADR 0211 规定它照常执行。
- npm run check 的 format:check、check:secrets 两步在干净 main 上同样失败，来自 PR 380。

## 请重点看
- 主人规则的参数（发件域名、词语）对外暴露是否合适；返回整体经 maskSensitiveTexts。
- 列表排序、字段是否确定。
- ownerRules 读取失败时整次 rule_book 失败（和 settings 失败一样），是否可接受。

## 第 2 轮：只看 97d505ed2660d85205de946ec369765590596707..HEAD
# PR 386 第 1 轮判断

- r1-1、r1-2（中，成立，两个模型都提）：测试只有两条 active 规则，排序、已撤销不列、待重新确认照常列、已知类型但参数不合法都没被锁住。集成测试改为在开库前直接写五行 `rule_book_rules`：一条 active（更新时间最晚，排序用例）、一条 needs_review（更新时间最早，断言 `enforced: true`）、一条 retired（断言不出现）、一条类型不认识、一条参数不全。数据库按更新时间倒序返回，用例断言按编号排序，删掉排序后失败；把 `includeRetired` 改成 true 后 retired 那条会出现，用例失败。
- r1-3（不成立，模型标中）：规则参数（词语、发件域名）随静态令牌对外。持有同一令牌的程序本来就能用 `find_memories` 读到这条规则的出处记忆（规则类记忆，原话），参数没有扩大暴露面；ADR 0219 已写明这个入口的令牌就是主人的全部只读权限。分令牌、按程序授权是 P5-3 的范围。
- r1-4、r1-5（低，成立，两个模型都提）：对外给的是存储的原始参数，不是执行时归一化后的参数。改为对能执行的规则再过一遍 `parseOwnerRuleParameters`，给解析后的参数；用例存 `@ISA.go.jp `，断言对外是 `isa.go.jp`。
- r1-6、r1-7（低，成立）：一行规则让 `enforceableOwnerRule` 抛出非 `RuleTypeError`（例如例子和表达式不符）时整本规则手册失败。改为逐条捕获，这条标 `enforced: false`、不给参数，其他规则照常列出。ownerRules 整体读取失败仍让整次失败，和 settings 一样（同一个 SQLite），不另加用例。
- r1-8（不成立）：作者关于 `format:check`、`check:secrets` 在 main 上失败的说法未核实。已在干净的 main 949d2fa9 上实跑两步，均失败（evals/owner-rule/*.json 没格式化；scripts/evals/owner-rule-live.eval.ts 的 authorization-bearer），本 PR 不碰这些文件。
