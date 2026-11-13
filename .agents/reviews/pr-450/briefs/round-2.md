# PR 450 第 2 轮：作者说明

第 1 轮之后的改动，请只看这些：

1. `docs/adr/0256-gate-job-gets-its-own-runner.md`：按第 1 轮的 6 条意见补正。PR A 的清单补上服务模板、安装、卸载、重启保护、防火墙单元里 3 号 runner 要动的地方；跨文件对照用例挪到 PR B；第 2 步里 main 确认用哪些 runner 的说法改准；前提 15 里 `1|2`、`2|all` 改成不带竖线的写法。
2. `docs/adr/0176-ci-on-ovh-vps.md`、`docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md`：`amended_by` 补上 0256。
3. `.agents/evidence/ci-queue-2026-11-12.md`：新文件，记 ADR 0256 里那些出自 GitHub 接口实测、仓库代码里查不到的数字。
4. `scripts/model-review/plan-claims.mjs` 的 `quoteInText`：核对代码说法时，模型常把同一个文件里的几处原文用全角分号“；”连在一起写（第 5 轮 10 条、第 7 轮 15 条），原来的检查只认“…”分段，这些本来对的引文全部被判成“文件里没有”。改成：整段找不到时，再按“…”和“；”一起拆开，每一段（至少 4 个字符）都要在文件里才算找到。文件原文里本来带“；”的引文（整段能找到）不受影响。`test/tooling/plan-claims-gate.test.mjs` 加了一条用例，含三个反向断言（其中一段不在文件里、一段不足 4 个字符、只有分号）。`.agents/instructions/model-review.md` 同步了这句规则。

请重点看第 4 项：放宽之后，有没有办法让一条编造的引文通过检查。

本 PR 不改产品代码，不改发给模型的任何内容（改的是开发用复核脚本的合并检查，不是它发给复核模型的提示）。

实际跑过的检查：`test/tooling/plan-claims-gate.test.mjs` 37 条通过；`biome lint` 和格式检查通过；文档严格校验 13 条错误，和 main 相同。
