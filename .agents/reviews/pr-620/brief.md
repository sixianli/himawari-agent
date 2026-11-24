# PR 620 复核材料：翻原话的两个工具

## 问题和目标

ADR 0286（docs/adr/0286-the-main-model-reads-and-writes-memory-itself.md）第 1 步下半：给主模型加两个只读工具。`conversation_search` 按意思和词搜主人和她以前对话的原话（可按日期范围、分页）；`conversation_open` 按对话编号和轮的序号打开前后原文（往后或往前翻页）。上半（PR 614）已建好 conversation_turns 索引和 ConversationTurnService.search/window。

## 约束

- 发给模型的内容只追加（.agents/instructions/prompt-prefix.md）：两个新工具定义加在工具列表最末尾，原有 23 个工具定义一字不改（测试里有前 23 个的哈希）。
- 工具结果长度：每页上限 = max(2000, floor(主模型上下文窗口 × 份额))，份额默认 0.02，可用配置 memory.toolResultShare 改（0 < x ≤ 0.5）。
- 遮盖由 ModelEgress 对整个外发请求做（含工具结果），工具本身不另做遮盖。
- 只搜主人发起的、未进回收站的对话；think 后台对话不搜不打开（由 PR 614 的服务保证）。
- 返回内容的密级 = 请求密级和所显示各行密级里最高的。
- 上线前的旧对话会全部删掉，不做兼容。
- 代码不写注释。

## 作者的说法（请核对）

1. 原有工具定义和顺序不变，新工具只在末尾追加；没配置 conversations 时两个工具都不出现。
2. 输入不合法（多余键、空 query、日期格式错、page 越界、sequence 非正整数、direction 不在枚举里、日期不存在）一律变成 CONVERSATION_INPUT_INVALID；其他错误变成 CONVERSATION_UNAVAILABLE，不把内部错误外露。
3. 搜索结果按字符预算分页，单行超长会截断并标 truncated；nextPage 只在还有下一页时出现。
4. service-main 里对话轮服务的创建挪到 recallProjection 之前后，行为和 PR 614 一致（同样的嵌入准入槽位、同样的失败上报）。
5. 工具动作表里两个工具按只读、主人范围、按运行加调用去重登记，和别的只读内置工具一致。

## 请重点看

- apps/agent-service/src/production-conversation-tools.ts
- apps/agent-service/src/production-runtime-tools.ts 的描述符拼接、#conversation 错误映射
- apps/agent-service/src/service-main.ts 的接线
- packages/prompt-catalog/src/tools.ts 新提示文字是否清楚、会不会让模型误用
