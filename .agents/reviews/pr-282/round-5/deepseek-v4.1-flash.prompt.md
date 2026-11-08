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
仓库就是当前目录，已检出 668e62bf6fa47e957b64b9f8f62b5bbb9b9dda20。
对比基准是 2995d5359933f8a57e974c61a2de9c9eb5e5d469，先运行 git diff 2995d5359933f8a57e974c61a2de9c9eb5e5d469..668e62bf6fa47e957b64b9f8f62b5bbb9b9dda20 看改动。
上一轮复核到 4b4347aa53d400feabb129ad9ce33a005f422a43，先看 git diff 4b4347aa53d400feabb129ad9ce33a005f422a43..668e62bf6fa47e957b64b9f8f62b5bbb9b9dda20 的增量，但可以读任何文件。
作者的说法（可能有错，请核对）：
# PR 282 第 5 轮代码复核材料

## 这个 PR 在修什么

生产上一轮对话停在「结果未确认」，要等这一轮的原始期限（约 31 分钟）才收尾，停止按钮一直转。根因是三道互相等待的锁，这个 PR 修其中两道，加上同一类的「输出过多」，第三道（预算账户被记成 `reconcile_required`）另出方案。

## 这一轮（第 5 轮）要复核的改动

第 4 轮复核给了四条意见，线程逐条核对后全部成立并处理完；Andy 看过第 4 轮结果后定「再一轮」，这一轮复核的就是第 4 轮之后的改动，加上随后合并进来的最新 `main`。

### 一、第 4 轮 R4-3：上限在进程自己退出之后越过时，不得把截断输出当成成功结果

模型把这条标成「低，推测」，线程按代码核对后改判为「中、高」并修掉。

事实来源：
- `packages/runtime-sandbox/src/job-host-main.ts:685` 在 stdout 的 `data` 回调里判断输出上限；`exited` 在子进程 `'exit'` 事件时就置真。
- Node 的 `'exit'` 先于 `'close'`，两者之间管道里缓冲的输出仍会继续派发。所以「命令自己以退出码 0 结束、系统排空它剩下的输出时才越过上限」是正常时序，不是罕见竞态。
- 这时 `finish()` 发出的 `reason` 是 `output_limit`，而 `exitCode` 是 0，`taskStarted`、`taskProcessExited`、`stdioClosed` 全为真，worker 里的 `knownExit` 为真。
- 改动前 `apps/execution-worker/src/production-sandbox-execution-v2.ts` 的 `boundedTermination` 要求 `!knownExit`，于是结果落到 `exitCode === 0` 那一支记成 `kind: "result"`，截断过的输出被当成完整的成功结果交给模型，模型据此回答。SRT 任务环境路径的 `knownExit` 分支排在 `output_limit`、`resource_limit` 之前，同样的问题。

这次改了：
1. 本机前台路径：`boundedTermination` 去掉 `!knownExit` 这个条件，「超了上限」优先于「正常退出」；输出上限和资源上限两种一起改。
2. SRT 任务环境路径：新增 `limitTermination`（`output_limit` → `SANDBOX_OUTPUT_LIMIT`，`resource_limit` → `sandboxResourceLimitReason(...)`），放在 `knownExit` 分支之前；原来排在后面的那两支 `output_limit`／`resource_limit` 尾部分支删掉。
3. 副作用的处理有意保持差别：上限是在进程自己退出之后才越过的（`knownExit` 为真），命令确实自己跑完了，副作用维持 `not_asserted`，这一轮当场结算、不走对账；进程是被上限杀掉的，副作用仍是 `unknown`。
4. 新增两条门槛场景 `[I-84] output-limit-after-exit`、`[I-84] resource-limit-after-exit`（`test/integration/sandbox-v2-worker-lifecycle.test.ts`），去掉被测改动后报 `expected { …(9) } to match object { kind: 'error', …(2) }`。

这个缺陷在改动前就存在，不是这个 PR 引入的；但本 PR 第三项写明「输出过多一律明确失败」，有这条路径那句话就不成立，而且它本身就是在给出错误结果。

### 二、第 4 轮 R4-1：投影层的交付门槛

`SANDBOX_OUTPUT_LIMIT` 加进了 `test/integration/sandbox-execution-v2.test.ts` 里 `describe.each([...])("bounded failure disclosure %s", ...)` 的清单，read／write／shell 三种各一条，核对带输出上限的事实真的能通过 `outputProtected` 和 `boundedFailure` 交付给模型。去掉被测改动后报 `expected { conclusion: 'failed', …(11) } to match object { conclusion: 'failed', …(3) }`。

### 三、第 4 轮 R4-2：事故表里的门槛路径写错

那道核对两份 `SAFE_TOOL_REASON_CODES` 一致的门槛，实际在 `test/tooling/safe-tool-reason-codes.test.mjs`（原先放在 `packages/application/test/` 下会被 `npm run check:boundaries` 以「`node:fs` 不允许在 `@himawari-agent/application` 里用」拦下），事故表那一行已改成真实路径。

### 四、第 4 轮 R4-4：没有采纳，等 Andy 定

`thread-execution-projection.ts` 和 `thread-execution-state.ts` 各存一份内容相同的 `SAFE_TOOL_REASON_CODES`。线程建议采纳「抽成一个共享导出」，但它要动另外两个服务文件的结构，超出已批准的范围，所以列给 Andy 等他定，不在这个 PR 做。现在靠解析源码字面量的那道门槛顶着，它挡不住「两份都忘了加」。

### 五、合并了最新 `main`（`2995d535`）

合并后事故表里同时有 `| I-83 |`（来自已合并的 PR #246）和 `| I-84 |`（本 PR），`npm run check:incident-gates` 通过。合并后重跑第 0 层：展开后 70 个文件 2310 条通过；`lint`、`typecheck`、`check:boundaries`、`check:incident-gates`、`check:glossary`、`check:instruction-links`、`check:prompt-prefix` 全部通过。

## 这一轮请重点看

1. 让「超了上限」优先于「正常退出」之后，有没有哪种时序会把本来正常的成功结果误记成失败（例如命令输出刚好等于上限、或者 `finish()` 的 `reason` 在别的情况下也会是 `output_limit`）。
2. 副作用在 `knownExit` 为真时记 `not_asserted`、为假时记 `unknown`，这个区分在三条路径上是否都站得住；`not_asserted` 会让这一轮当场结算、不走对账，这在「命令自己退出但输出被截断」的情况下是否安全。
3. SRT 路径新加的 `limitTermination` 挪到 `knownExit` 之前，有没有漏掉原来那两支尾部分支里做过的事（例如资源用量的携带、`effect` 的形状）。
4. 两条新门槛场景（`-after-exit`）是否真的覆盖了这条路径，去掉被测改动后是否真的会失败；有没有该有而没有的反向用例。
5. 投影层那道 `bounded failure disclosure SANDBOX_OUTPUT_LIMIT` 门槛，是否真的能证伪「交付不出去」这件事。
6. 合并最新 `main` 之后有没有和本改动冲突或语义重叠的地方。
