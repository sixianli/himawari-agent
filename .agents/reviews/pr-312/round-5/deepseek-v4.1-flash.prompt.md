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
仓库就是当前目录，已检出 aff8e4eebf86989c6d07890c3ad1197379363e2e。
对比基准是 1a3a1efecf4fc494057d44989d18d2603ff89fb9，先运行 git diff 1a3a1efecf4fc494057d44989d18d2603ff89fb9..aff8e4eebf86989c6d07890c3ad1197379363e2e 看改动。
上一轮复核到 1f16c11bea42883ddc110ebbfbf16e2ac927ee3d，先看 git diff 1f16c11bea42883ddc110ebbfbf16e2ac927ee3d..aff8e4eebf86989c6d07890c3ad1197379363e2e 的增量，但可以读任何文件。
作者的说法（可能有错，请核对）：
# PR 312 第 5 轮复核材料

## 这一轮要看什么

范围很窄：`--previous 1f16c11b` 到 `--head aff8e4ee`，只有一个提交，实质改动是
`scripts/model-review/opencode-review.mjs` 里 `probeRefused` 的判断方式和
`test/tooling/opencode-review.test.mjs` 里那条用例，另外是第 4 轮的复核记录文件。

这处逻辑我已经改了三次，第 4 轮复核指出前两次都没把根因找完，所以这一轮请着重
核对第三次的改法是否真的覆盖了所有「被拒」的来源。

## 这段逻辑是干什么的

复核脚本在真正花钱之前会跑一次自检：在一份一次性的仓库副本里，用一个 git 替身和
`bash -r` 限制 opencode 能做什么，然后发一批探针命令，检查哪些该成功、哪些该被拒。
`probeRefused(call)` 判断一条探针命令有没有被拒掉。它判错的后果分两种：

- allowed 探针（该成功的）被误判成被拒 → `PROBE_READ_COMMAND_BLOCKED`，自检失败，
  整轮复核起不来。
- write/read 探针（该被拒的）漏判成没被拒 → `PROBE_NOT_REFUSED`，自检同样失败。

所以两个方向都是 fail-closed，不会放行；但误判会让复核根本跑不起来。

## 三次改法和为什么前两次不对

原来的写法：把三段「被拒」的字样按子串在整段输出里找。

```js
export const REFUSAL_TEXTS = [
  "The user has specified a rule which prevents you",
  GIT_REFUSED,
  ": restricted",
];
export function probeRefused(call) {
  return REFUSAL_TEXTS.some((text) => String(call.output ?? "").includes(text));
}
```

问题是 allowed 探针里有 `git show --stat HEAD`，它会把 HEAD 的提交说明一起打印。
提交说明里只要复述过这三段字样中的任何一段，一条正常执行完的命令就被判成被拒。
触发它的正是这个分支自己的提交说明。

第一次改（`026bfdff`）：只把 `GIT_REFUSED` 一段改成行首匹配，另外两段不动。
仍然失败，因为那次的提交说明里同时写到了另外两段。

第二次改（`1f16c11b`）：改成只在不以空白开头的行里找这三段字样，理由是
`git show`、`git log` 打印的提交说明每行缩进四格。第 4 轮复核指出这条理由对自检
真正用的另一个探针 `git log -1 --oneline` 不成立——它的输出是短哈希加提交标题、
整行从列 0 开始。

第三次改（`aff8e4ee`，这一轮要看的）：不靠缩进，按每段字样真正被打印出来的形状
做行首精确匹配。

```js
export const REFUSAL_PATTERNS = [
  /^The user has specified a rule which prevents you/,
  new RegExp(`^${GIT_REFUSED} \\S`),
  /^\S+: (line \d+: )?[^\n]*: restricted/,
];
export function probeRefused(call) {
  return String(call.output ?? "")
    .split("\n")
    .some((line) => REFUSAL_PATTERNS.some((pattern) => pattern.test(line)));
}
```

## 请核对这些

1. 三段字样真正的打印来源在哪、形状是什么，新的三条模式是否都还能命中它们。
   替身的写法在同一个文件里（搜 `GIT_REFUSED, problem`）；`bash -r` 的报错形状
   在测试夹具里有样例；opencode 自己的拒绝话术只有测试夹具可参照。
2. 自检的探针清单（搜 `kind: "allowed"`）里还有哪些命令会打印仓库内容，它们的输出
   有没有可能命中这三条模式。除了 `git log -1 --oneline` 和 `git show --stat HEAD`，
   还有 `git diff --stat HEAD`、`git blame -L 1,1 -- <文件>`、`git status --short`。
3. 这样收窄会不会放过真正被拒的情形，尤其是 `bash -r` 报错形状有变化时
   （语言环境、shell 路径带空格、没有 `line N:` 的写法）。
4. 还有没有别处依赖被删掉的 `REFUSAL_TEXTS` 或 `refusalCandidateLines`。
5. 第 4 轮判断记录（`.agents/reviews/pr-312/round-4/judgments.md` 和
   `verdicts.jsonl`）里对 R4-2、R4-3 的纠正是否和代码一致。注意你的工具大概会以
   `REVIEW_GIT_REFUSED records-path` 拒绝读 `.agents/reviews/**`，读不到就直接说
   读不到，不要替它下结论。

## 我做过的验证

- 那条用例现在六个断言：正向三条（三段字样都在列 0）为 `true`；反向三条把三段字样
  分别放进 `git log -1 --oneline` 形状的提交标题里，期望 `false`；另有一条把三段
  都放进缩进四格的提交说明里。
- 反向验证：把 `probeRefused` 还原成只按缩进过滤的版本，这条用例以
  `expected true to be false` 失败；改回来之后 `test/tooling/opencode-review.test.mjs`
  164 条全过。
- 真实效果：第 4 轮那次运行的自检输出 `SELF_CHECK_OK`（那时还是第二次的改法；
  第三次改法的真实自检结果就是这一轮你看到的这次运行）。
- `biome format`、`biome lint` 对这两个文件都通过；
  `scripts/layer0-tests/check-layer0-tests.py derive` 对这次改动没有列出任何文件。

## 本 PR 的三条实质改动（背景，已复核过四轮，不用重看）

1. 给模型看的字节上限按 1024 换算（`production-sandbox-tool-result.ts` 的 `limitBytes`）。
2. `SAFE_TOOL_REASON_CODES` 合成 `thread-execution-state.ts` 的一处导出。
3. 恢复函数去掉 `recordUnrecoverable` 开关，延续授权那条路用不带回调的实例，并在
   `sqlite-sandbox-execution-v2.test.ts` 的 `loss-unrecoverable` 里断言它一条记录都不写。

## 必答问题

1. 这个改动会不会改变模型已经见过的请求开头？
2. 会不会让同一段文字在不同请求里变成不同的字节？
3. 有没有对应的自动检查，反向用例会不会真的失败？
4. 每个产生或修改的值，两端校验都能接受吗？
