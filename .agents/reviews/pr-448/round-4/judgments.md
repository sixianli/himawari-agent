# PR 448 第 4 轮逐条判断（完整复核，只跑 DeepSeek）

1. 只有替补记录、没有被替补模型的失败记录也能算数：成立，会出错，中高（能绕过合并前检查；脚本正常运行不会写出这种账本）。改法：`stoodIn` 额外要求这一轮里被替补的模型自己有一条没通过、没有 `substitute` 字段的记录；`test/tooling/opencode-review-merge-gate.test.mjs` 加反向用例（只有替补记录报 `no-complete-round`）和正向用例（失败记录加替补记录算数）。
2. 文档说只改 `default`，测试却按现在的默认值写了断言：成立，会出错，中高按模型给的档处理（文档与事实不符）。改法：ADR 0259 和 model-review.md 写明改默认时脚本不用改，但测试里按现在默认值写的断言要一起改。没有把这些断言改成不看具体值：复核链的用例本来就要以“默认是哪个模型”为前提，断言失败正好提醒改默认的人核对这些用例。
3. ADR 0175 正文仍是旧规则：不成立。依据：文档治理规则不许改写旧 ADR 的决定内容（`.agents/instructions/document-governance.md`：“绝不改写先前 ADR 的决定内容”），仓库的做法是在旧 ADR 的 frontmatter 记 `amended_by`，ADR 0068 被 0175 修正时就是这样（`docs/adr/0068-deepseek-only-codebuddy-fallback.md` 第 7 行）；ADR 0259“与 ADR 0175 的关系”一节逐条写了哪几句被改。

必答问题四项模型都答了，没有另外的问题。
