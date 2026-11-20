# PR 480 第 4 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）不成立：### 1｜中｜`--previous` 解析失败时被静默当成“没传”，开跑前检查会放行全量复核并花钱。照模型指的 resolveCommits 实跑：--previous nothash 抛 GIT_FAILED git rev-parse --verify --quiet nothash^{commit}（node 调 resolveCommits 的运行结果），git() 对非零退出会抛错，main 在花钱前以退出码 2 停下；resolveOne 返回 undefined 只发生在没传 ref 时，不存在传了却静默当没传的输入
- 2（deepseek-v4.1-flash）成立，会出错，低：### 2｜低｜同轮记录本身的 `previous` 接不上链时，不会提示 `use=new-round`。触发：线程在同一轮重试时传了该轮记录里已用的 previous，而这个 previous 本身接不上链；后果：提示 use=no-previous 或 use=--previous <hash>，照做会再被 round-previous-differs 拒绝；不花钱只多试一次，已把此分支的提示改成 use=new-round；判低理由：只拒绝不花钱，后果是多试一次，提示不准但不会丢数据
- 3（deepseek-v4.1-flash）成立，可以更好：### 3｜低｜“惰性 skip 只算一次、所有 low-fix 点同一份清单”没有自动检查。实现用 ??= 只算一次，与模型描述一致（opencode-review.mjs:3542-3555）；缺的是调用次数的反向用例，属测试写法可以更好，现有代码没有输入会出错
- 4（deepseek-v4.1-flash）不成立：### 4｜低｜作者给的复核基线与提交历史不一致，描述的三项改动已在 `6482fbf` 之前。说的是复核材料里基线的措辞，不是代码；第 3 轮复核的三项改动在 6482fbf 之前，本轮 --previous 6482fbf 正是只看其后增量（git merge-base --is-ancestor 6482fbf 108e8c603 成立），脚本和链记录都按这个走，没有代码或文档会因此出错
