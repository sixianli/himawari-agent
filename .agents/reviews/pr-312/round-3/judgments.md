# PR 312 第 3 轮复核的逐条判断

这一轮只跑 DeepSeek（第 2 轮之后把最新 main `1a3a1efe` 合进分支，`--assert-reviewed` 报 `REVIEW_NOT_CURRENT`，所以对合并本身和冲突解决再复核一轮）。材料把范围写明了：只看这次合并和 `docs/incidents-and-gates.md` 的冲突解决，确认本 PR 和 main 的改动都没丢。

模型对合并本身的结论是「冲突解决正确、两边都不丢」，并逐条列了它亲自读到的证据。三条意见全部成立，但我把两条「中」都降为「低」，理由逐条写在下面；其中两条是我自己验证做得不够，这一轮补上了实际输出。

## R3-1（模型：中 → 我判：低，已修）`.agents/instructions/model-review.md:140` 说「没有 check:gitleaks」

成立。合并把 main 的 `check:gitleaks` 带进来了：`package.json:66` 有 `"check:gitleaks": "node scripts/check-gitleaks.mjs"`，`package.json:27` 的 `check:steps` 里有 `npm run check:gitleaks`，`.agents/instructions/delivery-mode.md:18` 也已同步；只有 `model-review.md:140` 还留着「目前 `package.json` 里没有 `check:gitleaks` 这个脚本，云端线程不用跑它」。

降为低的理由：这不是这次冲突解决改坏的，而是 main 上原有的不一致被合并原样带进来（模型自己也写明了这一点）；而且那句话读完整是自带后手的——「以后若加了，任务说明里的『有就先运行』一句已经覆盖，云端线程提交记录之前先运行它」，所以按整句执行的线程并不会跳过这道门槛，错的只有开头那个「目前没有」的事实判断。真正的后果是读的人会以为不用跑，属于文档不准，不是会出错的代码路径。

照改。整条改成「已经存在，提交记录之前必须先运行」，指向 `delivery-mode.md` 的快速模式一节，并补上它以 `GITLEAKS_GATE_FAILED` 失败时怎么分辨「命中是不是这一轮新写的记录」——这正是下面 R3-2 我自己撞上的情况。`npm run check:instruction-links` 通过（checked=187 errors=0）。

按 `.agents/instructions/model-review.md` 的规则，低危改动够小时可以用 `--accept-low` 记账不再复核，但 `--accept-low` 要求这一轮有测试文件的新增行，纯文档改动用不了，所以这一条触发第 4 轮（只跑 DeepSeek）。

## R3-2（模型：中、自标未核实 → 我判：低，已用实际输出消掉）合并后没有跑 `npm run check:gitleaks`

成立：合并把这道门槛带进了本分支的 `npm run check`，而我合并后只跑了 `typecheck` 和 `check:incident-gates`，确实漏了这一道；模型也写明它读不到 `.agents/reviews/pr-312/**`（工具以 `REVIEW_GIT_REFUSED records-path` 拒绝），没法自己判断本 PR 新增的复核记录会不会触发它。这是我验证不足，不是代码缺陷，所以判低。

补跑的实际输出（容器里的克隆是浅克隆，门槛以 `GITLEAKS_GATE_ERROR GITLEAKS_HISTORY_SHALLOW` 拒绝运行，先 `git fetch --unshallow origin` 补全历史）：

```
GITLEAKS_FINDING current packages/platform-node/test/deepseek-web-provider.unit.test.ts:93 generic-api-key
GITLEAKS_FINDING current test/tooling/opencode-review.test.mjs:2299 private-key
GITLEAKS_FINDING history packages/platform-node/test/deepseek-web-provider.unit.test.ts:93 generic-api-key e5edb5469d7b80782048a0dead5192e1ebda0429
GITLEAKS_GATE_FAILED current=6523 commits=2548 excepted=54 blocking=3
```

两件事分开看：

1. **模型担心的风险不存在。** 三条命中里没有任何一条在 `.agents/reviews/pr-312/**`——本 PR 新增的复核记录一条都没触发密钥扫描。
2. **这道门槛在 main 上本来就是红的，不是本 PR 造成的。** 命中的两个文件 `git diff origin/main..HEAD` 为空（和 main 逐字节相同），历史那一条在 `e5edb5469`（`git merge-base --is-ancestor` 证实是 origin/main 的祖先，2026-11-07 的提交）。为了不只靠推断，我把 `origin/main`（`1a3a1efe`）检出到一个 worktree 直接跑了一遍，输出是同样的三条命中：`GITLEAKS_GATE_FAILED current=6511 commits=2537 excepted=54 blocking=3`。两条都是明显的假阳性：一个是测试夹具里的网址 `https://user:pw@example.org/a?token=abcdef123456`，一个是遮盖函数自己的测试夹具（私钥头那一行的固定文字，后面接 `${"说明".repeat(5000)}`；这里不照抄原文，否则复核账本自己会被 `record-secret-like` 挡下）。

按门槛自己打印的办法，修法是在 `ci/rules/gitleaks.toml` 按路径加窄的白名单。那是 main 的事，而且是安全门槛的白名单，不该搭在一个无关 PR 里顺手改（远端已有一个 `fix/gitleaks-pr274-false-positives` 分支，但没有开着的 PR），所以本 PR 不动它，列进汇报让 Andy 定谁来修。

## R3-3（模型：低，已用实际输出消掉）`check:incident-gates` 证明不了「两边都不丢」，也不校验列数

成立，而且这条说得对：`scripts/check-incident-gates.mjs` 只校验文件里已经存在的行，I-90 整行被冲突解决吞掉的话结果同样是 `errors=0`，所以我拿 `incidents=85→86` 当「两边都不丢」的证据，严格说只证明了「多了一行」，没证明多的是 I-90。真正的证据是另外两件事，我当时做了但没写进提交说明：合并前后 `grep "^| I-84 "` 的 md5 与 `git merge-base` 处相同（证明 I-84 保留的是分支侧新文本），`git show bf5cbcf6` 的 combined diff 里 I-90 来自 main 侧（模型这一轮也亲自读了这两行，结论一致）。

它指出的另一个真缺口是我没跑 `check:markdown-tables`——那才是严格查列数的那一步。补跑：`MARKDOWN_TABLES passed files=403 errors=0`，所以 I-84、I-90 两行的列数是对的。

它顺带建议给 `check-incident-gates` 加「已知编号集合必须存在」之类的断言来长期兜住这类冲突。这一条我不做，列给 Andy 当「可以更好」：维护一份编号白名单等于每加一个事故都要改两处，而冲突解决丢行这件事已经有 `git show` 的 combined diff 和 `check:markdown-tables` 两道现成的办法，再加一份会漂移的清单不划算。

## 模型自标「未核实」的部分

- 它跑不了 node，所以 `typecheck`、`check:incident-gates` 的结果它只按脚本逻辑推断。这些我这边都跑过，输出在提交说明里。
- 它没有逐条审计 main 从 #290、#291 带进来的改动是否影响模型请求开头。这些在 main 上已经存在，不构成本 PR 相对 main 的净变化，不在本 PR 的范围内。

## 必答问题

模型的三条回答与我自己的核对一致：本 PR 不碰系统提示、工具定义和历史，失败文案是随工具结果追加在最后的内容；`limitBytes` 是纯函数，`SAFE_TOOL_REASON_CODES` 只用 `.has()` 不参与序列化，所以同一段文字不会在不同请求里变成不同字节；反向用例在 `sqlite-sandbox-execution-v2.test.ts` 里，已实测把 `resultUnrecoverable` 挪进共用参数会让它变红。
