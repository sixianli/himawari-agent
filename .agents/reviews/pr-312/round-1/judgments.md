# PR 312 第 1 轮复核：逐条判断

两个模型都说没有发现高、中严重度的功能回归。两份答案指出的成立问题高度重合，合起来是四处文档或门槛问题，没有一处是代码行为错误。

## 会出错（已修改）

### R1-1 / R1-2 低：`docs/lessons.md` 还把已删除的 `test/tooling/safe-tool-reason-codes.test.mjs` 列为必须手工加进第 0 层清单的门槛

成立。`docs/lessons.md` 里 2026-11-08（PR #282、I-84）那条教训把三个「按路径扫源码的门槛」列给后来的代理，其中一个是本 PR 删掉的文件；全仓库只剩这一处引用。

严重度判低。触发：后来的代理照这条教训把那个文件加进第 0 层清单。后果：文件不存在，跑不出任何用例，代理当场就会发现；不会产生错误的产品行为、不会丢数据、不会绕过任何门槛。DeepSeek 给「低」，GLM 给「中低」；GLM 没有说出它会让人照着做错哪一类事，按 [model-review.md](../../../instructions/model-review.md) 的分档，中、高要求会让人做错「错误结果、丢数据、泄露凭据、绕过检查、不可撤销操作」这几类事，这条不属于其中任何一类。

修改：那一行改成只列 `apps/agent-service/test/prompt-catalog.unit.test.ts` 和 `npm run check:glossary`，并写明原来那个文件比对的是白名单的两份拷贝、本 PR 合成一处后已删除。

### R1-3 / R1-4 低：Backlog `BL-20261017-005` 还是 `open`，摘要说白名单「现在有两份」

成立。这条 Backlog 的处理方向就是本 PR 第二条改动，而文件仍是 `record_state: "open"`，摘要与改后的代码相反。

严重度判低：只会让人去找一份已经不存在的第二份清单，不影响运行行为。

修改：按 `document-governance` 的流程用 `idea_backlog.py close BL-20261017-005 --state done --result …` 关闭，再用 `archive_doc.py` 归档到 `docs/archive/backlog/`。`validate_docs.py --strict` 仍是 main 上原有的 11 条 Runbook 哈希错误，没有新增；仓库里没有指向这条记录的其他链接。

### R1-5 / R1-6 低：第三条改动没有任何会变红的检查

成立，而且这是两个模型里最有价值的一条。改动前我在 I-84 那一行写的是「单个沙箱调用的轮次跑不红，所以不加用例」。DeepSeek 指出可以不走那条路：直接在同一份状态上调用只判断的那个实例，断言它一条记录都不写。

严重度判低：要触发得有人把 `resultUnrecoverable` 挪进两个实例共用的那份参数，不是正常使用就会发生；但一旦发生，延续授权那条纯判断的路会写下不可恢复记录并让这一轮提前判失败，而改动前没有任何用例会变红。

修改：`production-run-composition.ts` 把只判断的那个实例也放进返回值；`test/integration/sqlite-sandbox-execution-v2.test.ts` 的 `loss-unrecoverable` 在写记录之前先调用它，断言返回 `undefined` 且数据库里 `sandbox-tool-result-unrecoverable:%` 的记录数为 0。

反向验证（已实测）：把 `resultUnrecoverable` 加进 `toolResultRecoveryParts` 之后，这条断言以 `expected { count: 1 } to deeply equal { count: +0 }` 失败；还原后通过。

### R1-7 低：I-84 那一行说「在类型上就拿不到写入口」不准确

成立。`resultUnrecoverable` 仍是可选字段，拦住写入的是运行期条件 `options.resultUnrecoverable &&`，不是类型系统。

严重度判低：只会让读事故表的人高估保护强度，不影响运行行为。

修改：改成「这条路的实例没有传入这个回调，写记录的条件永远不成立」，并把 R1-5 新加的那条断言写进同一行。

### R1-8 低：我说 `check:incident-gates` 只查「已关闭行」的路径，不准确

成立。`scripts/check-incident-gates.mjs` 对每一行都提取反引号里的路径并检查是否存在，不只已关闭的行。

严重度判低：只是说明写得不准，不影响代码。修改：PR 描述里那句话改准（提交说明已经推送，不改历史）。

## 可以更好（不改，列给 Andy）

- R1-9（DeepSeek）/ R1-10（GLM）：按 1024 换算却仍写 `KB`、`MB`，严格说是 `KiB`、`MiB`；另外 `limitBytes` 的 KB 用 `toFixed(1)`，而界面上 `delivered-files.ts` 的 KB 用 `Math.round`，落在 1 MB 到 1 MiB 之间的值（例如 1000000 字节）现在读作「976.6 KB」。两条都不改变行为。单位名怎么写是 Andy 这次已经定过的（他问「这几个你建议采纳哪些」时，我建议不引入 MiB、他说开工）；两处 KB 的取整方式不一致是真的，要统一得动界面文案，列给他定。生产上的上限只有 1024 MiB 和 48 KiB，不落在那个边界区间。
- R1-11（GLM）：`thread-execution-state.unit.test.ts` 的白名单用例只点名了 21 个原因码里的 11 个，从单一集合里删掉另外 10 个不会有用例变红。这是改动前就有的缺口（旧的两份比对测试同样拦不住「两份一起删」），不是本 PR 的退步；要补得逐个列出全部原因码，列给 Andy 定。
- R1-12（DeepSeek）：它没能排除「同一轮次有多个沙箱调用」这种情形，所以对我原来那段推理存疑。推理本身对单个调用成立，而且它自己也写了行为与改动前完全一致、不是回归。R1-5 的新断言已经不依赖这段推理，I-84 那一行的措辞也按 R1-7 改了，不另做改动。

## 不成立

无。
