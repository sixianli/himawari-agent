# PR 353 第 1 轮逐条判断

| 编号 | 意见 | 判断 | 依据和处理 |
| --- | --- | --- | --- |
| r1-ds-1 | context 示例删改已发历史 | 成立，会出错，中高 | 规范原文第 187-194 行示例按条件过滤历史，与 `.claude/rules/prompt-prefix.md` 第 4 条冲突；示例前加“官方示例原样，Himawari 不得照抄”和只能在末尾追加的说明 |
| r1-ds-2 | before_agent_start 示例每轮改系统提示 | 成立，会出错，中高 | 换成 Himawari 冻结写法的示例，注明官方示例不得照抄 |
| r1-ds-3 | 照官方写没接上大改动审批 | 成立，会出错，中高 | 第一节加第 7 条，引用 owner-standing-rules |
| r1-ds-4 / r1-glm-2 | D5 漏了 agent.continue、hasQueuedMessages、state.tools | 成立，会出错，中高 | `pi-runtime-adapter.ts:1237-1238`、`:1788`，`pi-tool-batch-continuation.ts:74` 确有；补进 D5，插消息一节写明不得调 `session.agent` 上的方法。GLM 判低，线程判中高：偏离表是升级时逐条重查的依据，漏项会漏查 |
| r1-ds-5 | npm pack 只拉 1.5.1 | 成立，会出错，中高 | 命令改为两个版本都拉，并说明用 diff 看差异 |
| r1-ds-6 | 没有自动检查偏离表准确性 | 成立，可以更好 | 不改变任何陈述的真假；偏离表是文档，不是门槛；列给 Andy |
| r1-ds-7 / r1-glm-1 | “扩展不放在磁盘上”不准确 | 成立，会出错，低 | `pi-runtime-adapter.ts:1426-1431` 传了 additional*Paths；生产入口未接 resources（GLM 核对 `production-run-composition.ts:403-431`）。改写措辞 |

DeepSeek 侧重检查里提到 `tool_call` 改参数与 `execute` 内权限判断的顺序，补了一句说明。GLM 第 3 条是“官方原文未核实”的信息提示，不是意见：原文由线程用 `npm pack` 拿 1.5.1 包核对过行号。
