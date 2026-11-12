# PR 378 第 6 轮复核判断

复核提交 131f06b7，只用 DeepSeek。这是 Andy 选“再跑一轮 DeepSeek”之后的第 3 轮，仍有中、高意见，改完后停下问 Andy。逐条判断写在同目录的 `verdicts.jsonl`。

## 会出错：中、高（已改，未复核）

- r6-2 删不掉的题干编号只看最新一次运行：改为每次运行把最近运行记录里出现过的全部编号重删一次。测试在中间插入一条空记录仍能删掉，变异验证过。
- r6-3 运行记录和进行中标记重复计数：标记记运行编号，服务用这个编号写运行记录，数据库已有同编号时跳过并删标记。测试 “drops the marker of a run the database already recorded”，变异验证过。

## 会出错：低（已改或写进 ADR）

- r6-1 / r6-7 上限是“按预估挡”的上限，最多超出一次调用的差额：写进 ADR 后果。
- r6-5 评测关着时也删满 7 天的标记：测试 “removes week-old markers while the evaluation is off”。
- r6-8 “一点”漏检：写进 ADR 后果。

## 不成立

- r6-4 旧文件名 `in-progress.json`：那个版本没上线过。
- r6-6 说的是复核说明里的措辞，仓库里的 ADR 已经正确。
