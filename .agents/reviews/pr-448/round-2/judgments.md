# PR 448 第 2 轮逐条判断（只跑 DeepSeek）

1. `allowed` 不再被限制为批准的两个模型（模型给“中”）：不成立。依据：提交里的 `scripts/model-review/review-models.json` 第 2 行 `allowed` 正好是批准的两个模型，ADR 0255 的那句话说的是这个文件的现值，是真的；没有任何输入能让脚本用上清单外的模型（`parseArgs` 的 `--models` 只从 `REVIEW_MODELS` 里找，找不到报 `ARG_INVALID --models`）。要加第三个模型必须改提交进仓库的文件，这和改动前改脚本常量是同一回事，改动前也没有测试把模型名钉死；能改配置的 PR 同样能改测试。协调者转来的要求是“不要写死”，把两个模型名再钉进测试等于换个地方写死。已在 ADR 0255 和 model-review.md 写明：往 `allowed` 加模型要先改项目指令第 17 条。
2. `covering` 对 `substitute` 字段的判断和 `direct` 不一致：成立，会出错，低。触发：手写或损坏的账本里同一轮有正常记录和 `substitute` 为 `false` 或字符串的记录，且提交不同；后果是 `REVIEW_ROUND_HEADS_DIFFER` 报错停下，不会放过未复核的改动。改法：`covering` 的非替补分支也要求没有 `substitute` 字段；`test/tooling/opencode-review-merge-gate.test.mjs` 加一条“正常记录加两条坏记录、提交不同”的用例，期望这一轮照常算数。
3. 文档措辞：成立，会出错，低（文字不准，不会让人做错事）。改法：ADR 0255 第 2 条改成“`allowed` 和 `default` 不能为空、不能重复，`default` 和 `substitutes` 里的模型都必须在 `allowed` 里，`substitutes` 可以为空”；ADR 0255 第 3 条和 model-review.md 第 6 步把“不是替补的模型”改成“在 `allowed` 清单里、记录上没有 `substitute` 字段的模型”。
4. delegate 写本地默认模型（模型自己标“推测/风险（未证实）”）：不成立。依据：`reviewArgv` 写出 `--models` 之后，云端跑的清单和本地 `checkResult` 用 `parseArgs(reviewArgv(task)).models` 期望的清单是同一份；交接分支上的 `allowed` 不含这个模型时，云端脚本在花钱前以 `ARG_INVALID --models` 停下，这是正确的结果，不是错误结果。模型建议的两种改法（省略 `--models`，或从交接分支读配置）正是第 1 轮它自己指出有风险的写法和它的变体。

同时改了 ADR 0255 的背景一节：核对代码说法时，模型把“改动前脚本怎样”的 7 句话对着改动后的代码判成不一致。改成直接引用 ADR 0175 的原话。
