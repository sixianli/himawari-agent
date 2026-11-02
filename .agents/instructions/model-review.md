<a id="model-review"></a>
# 合并前的双模型复核

每个 PR 合并前，用 `opencode-go/deepseek-v4.1-flash` 和 `opencode-go/glm-5.3-flash` 两个模型，推理强度都设为高，各复核一遍。只能用这两个模型（Andy 在项目指令第 17 条规定）。交给它们的材料只讲问题、目标、约束和已核对的事实，不预设结论，并写明：列出的方案只是参考，请从问题本身出发，提出你认为更好的方案（项目指令第 16 条）。线程对每一条意见逐条处理并写下理由，报告 Andy，Andy 认可才合并。

<a id="checklist"></a>
## 每次复核都要问的问题

1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？

<a id="how-to-run"></a>
## 怎么跑

用 `node scripts/model-review/opencode-review.mjs` 跑，不要自己拼 `opencode run` 命令。它做这些事（Andy 2026-11-03 定）：

- 模型自己读代码：只开读文件、按内容搜索、按文件名找文件，以及 `git diff`、`git log`、`git show`、`git blame`、`git status`；改文件、别的命令、派子代理、读 `.env` 类文件、仓库外的路径全部禁止。原因：系统的真相在代码里，只读线程给的材料，材料错了复核就跟着错。
- 代码复核（`--mode code-review`）不联网；方案讨论（`--mode discussion`）可以读网页，不能搜索。
- 在 PR 最新提交的一次性副本里运行，副本删掉了远程地址，用完即删。
- 把 opencode 默认写死的 32 000 输出上限调高（`OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX`），DeepSeek 高推理时不再被截断。
- 开跑前先对本机假服务器自检：工具表、输出上限、推理强度不对，或 `git log --output=文件` 这类写文件的参数没被拦住，就以 `SELF_CHECK_FAILED` 停下，不花钱。
- 两个模型并行，结果写到 `--out` 目录；每次的真实用量（输入、输出、推理、缓存命中 token 和费用）追加到其中的 `usage.jsonl`。某个模型被截断、超时或没出文字时退出码为 4，按输出里的 `outcome` 处理，不要原样重跑。

用法：

```
node scripts/model-review/opencode-review.mjs --mode code-review \
  --base <分叉点提交> --head <PR 最新提交> [--previous <上一轮复核的提交>] \
  --brief <作者说明.md> --out <结果目录>
```

`--brief` 只写这次的问题、目标、约束和作者的说法；脚本会在前面加上固定说明（上面的必问问题、项目指令第 16 条原话、「作者的说法可能有错，请对照代码核对」、输出格式），并让模型自己用 `git diff` 看改动。第二轮起传 `--previous`，模型先看增量，但可以读任何文件；合并前最后一轮对最终提交复核时不传它。
