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
输出格式：按严重度从高到低排列，每条意见单独一个以「### 」开头的三级标题（标题里写序号、严重度和一句话问题），下面写：文件:行、问题、证据（引用你亲自读到的那几行代码）、建议；意见以外的内容不要用三级标题。把「读代码证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 80302eded6cd181fe3efe693614dc4a53ecf0b91。
对比基准是 120fdd939e0f35b60e862853cd78740bf127bd9e，先运行 git diff 120fdd939e0f35b60e862853cd78740bf127bd9e..80302eded6cd181fe3efe693614dc4a53ecf0b91 看改动。
上一轮复核到 6ccf14b7650f0e81b37909e74edce30db41d9ed4，这一轮先看 git diff 6ccf14b7650f0e81b37909e74edce30db41d9ed4..80302eded6cd181fe3efe693614dc4a53ecf0b91 的增量，复核增量和它直接影响的代码：调用它的地方、它调用的地方、它产生或修改的值的每个使用端。增量没有碰到、行为也没被增量改变的旧代码前几轮已经复核过，不必整份重读；但证据指向旧代码时要跟下去。结论里写清这一轮查过哪些范围。
作者的说法（可能有错，请核对）：
# PR 495 复核材料

## 问题
云端 Claude Code 线程开局会自动载入仓库根目录 CLAUDE.md（@AGENTS.md）和 .claude/rules/ 下全部规则；官方文档写明云端线程不加载带 paths 前缀的规则、子目录 CLAUDE.md、仓库技能和 settings.json 钩子。此外 .claude/rules/incident-gates.md 要求每个线程开工通读 docs/incidents-and-gates.md（184KB，约 5.8 万 token，96 条里 5 条未结、1 条仓库外）。目标是减少线程开局占用的上下文和 token，同时不改变任何规则的约束力。

## 约束
- 规则本身不放松：事故清单一条不删；“第三次必须硬门槛”仍由 check:incident-gates 拦；发给模型内容只追加的规则仍有效、check:prompt-prefix 仍是阻断检查。
- 不能用 paths 前缀做按需加载（云端线程完全不加载）。
- 文档里的相对链接必须仍然有效（check:instruction-links、check:docs-links）。

## 作者的说法（请核对，不要直接采信）
1. scripts/check-incident-gates.mjs --open 打印状态不是“已落门槛”的条目（缺门槛、等 Andy、仓库外），每条一行：编号 | 状态 | 日期 | 现象第一句（超过 80 个 Unicode 字符截断加省略号）；随后打印 INCIDENT_OPEN count=N total=M，再打印原有的 INCIDENT_GATES 结果行，退出码不变；清单有任何一处通不过 check:incident-gates（找不到、表格坏了、某行状态写错、已关闭条目的门槛文件不存在等）时不列条目，只打印 INCIDENT_OPEN unavailable errors=K，随后仍打印 INCIDENT_GATES failed 行，具体错误在标准错误里；.claude/rules/incident-gates.md 写的是同样的条件。
2. .claude/rules/prompt-prefix.md 移到 .agents/instructions/prompt-prefix.md 后，文件内的 ../../ 相对链接仍然正确（两者都在仓库下两层）；AGENTS.md、docs/、model-review.md、packages/sensitive-capture/README.md 里的引用都已改路径；.agents/reviews 是历史记录，有意不改；.agents/handoffs 里两份 11-05 交接文件的链接在第 1 轮复核后改到了新路径。
3. AGENTS.md 删掉的细节（CI 长期授权、复核分级和轮次、accept-low、accept-unreviewed、Mac 线程交接、Pi 现有偏离不得照抄）都已在被链接的文件里写着，没有规则因此丢失。
4. 不涉及任何发给 Himawari 模型的运行时内容，只改指令文档和一个开发用检查脚本。

列出的思路只是参考，不要局限于这些；请从问题本身出发，如果有更好的做法或遗漏的风险，请直接提出。

第 4 轮新增 docs/adr/0269-load-instructions-on-demand-at-thread-start.md（amends ADR 0107 决定 3）和 ADR 0107 frontmatter 的 amended_by，Andy 2026-11-14 15:48 JST 要求补这份 ADR；plan-claims 已核过 3 次，最后一次 11 句全部一致。

第 5 轮新增的是合并 origin/main（PR 493，AGENTS.md 冲突按本 PR 精简写法解决，并补上“主线程在后台跑 DeepSeek 复核、答案交给子代理判断”）和 ADR 0269 的措辞修改：前提只引 HEAD 里存在的原文、删掉无从核对的估算句、改正第 4 轮低意见 3、4。
