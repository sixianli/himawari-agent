# PR 439 第 4 轮作者说明

第 3 轮没有中、高意见，一条低的已改（运行时身份反向用例改用带当前版本前缀的身份，见 `.agents/reviews/pr-439/round-3/judgments.md`）。这一轮看第 3 轮记账之后的修改：

问题：`npm run check:srt-version`（`scripts/check-srt-version.mjs`）扫描所有已跟踪文件里像沙箱运行时版本号的写法。第 3 轮的复核记录（模型答案、提示词存档、逐条判断）逐字引用了测试里曾经写过的一个旧字面量，于是检查在 `.agents/reviews/pr-439/round-3/` 下报 `SRT_VERSION_STALE`。模型答案和提示词存档按复核规则不能改（逐条判断的原话要能在模型答案里逐字找到，提示词有摘要核对）。

改动：
- `scripts/check-srt-version.mjs`：`HISTORICAL` 加上 `.agents/reviews/`，和 `docs/`、`test/qualification/evidence/` 一样不扫描。
- `test/tooling/srt-version.test.mjs`：“历史证据不查”的用例加一个复核记录文件；新增一条用例证明 `.agents/instructions/` 下的文件仍然会被查。去掉 `HISTORICAL` 那一行后前一条用例失败（已实际运行）。
- `docs/adr/0156-srt-0-0-81-with-a-locked-seccomp-helper.md`：例外清单里补上 `.agents/reviews/`。

约束：不能让真正在用的版本号写法漏检；代码不写注释。

列出的做法只是参考，不要局限于它，请从问题本身出发，提出你认为更好的做法。

请核对：
1. 这个改动会不会改变模型已经见过的请求开头？
2. 把 `.agents/reviews/` 排除在外，会不会让某个真正决定运行时版本的文件漏检；`.agents/reviews/` 下有没有会被程序读取并影响运行的文件。
3. ADR 的改动和脚本是否一致。
