# PR 480 第 1 轮复核判断

- V1（模型判中）不成立：复核运行把新记录追加到工作区账本，预算和轮次也读它；合并前检查要求账本已提交，最终检查的就是这份账本提交后的内容。改读 HEAD 反而会看不到 `--accept-low` 刚追加、尚未提交的 low-fix 记录。
- V2（模型判中）成立，线程判低：只有不是 `--accept-low` 正常写出的 low-fix 记录才会触发。已改：把合并前检查的 low-fix 核对抽成 `lowFixChecker`，开跑前检查共用它；不合格就报链已断。
- V3 成立，低：同一轮补跑时 `--previous` 必须和这一轮已有 ok 结果的相同，否则以 `round-previous-differs` 拒绝。
- V4 成立，低：补了 `head-not-after-accepted`、同轮补跑、low-fix 不合格三条用例；反向验证分别撤掉判断、`main()` 调用、low-fix 重核、同轮核对。
- V5 成立，低：文档改成 low-fix 记录的 `head`（`REVIEW_LOW_FIX … head=`，或提交账本后 `REVIEW_CURRENT … reviewed=`）。
