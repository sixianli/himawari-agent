# PR 375 第 1 轮复核：逐条判断

两个模型都跑完（DeepSeek 0.1043 美元，GLM 0.0776 美元）。

| 编号 | 模型 | 意见 | 判断 | 处理 |
| --- | --- | --- | --- | --- |
| D1 | DeepSeek | memory.recall 名额满时已确认替不下待确认，替换会打乱顺序 | 成立，会出错，中高 | 重写合并逻辑：待确认、已确认分两个列表；先查重复再看名额；已确认按检索顺序输出。新测试 limit=2 的情况在旧代码上失败、新代码上通过 |
| D2 | DeepSeek | ADR 说评测记录在 history.jsonl，但没写入 | 成立，会出错，中高 | 修复提交后实跑一轮评测，记入 history.jsonl 一起提交 |
| D3 | DeepSeek | 数字保护不管正负号和中文数字 | 成立，会出错，低 | 数字串改为“正负号 + 阿拉伯数字”或连续中文数字；新测试在旧正则上失败 |
| D4 | DeepSeek | 测试替身相似度是点积 | 成立，会出错，低 | 改为余弦并要求维度相同；新测试用非单位向量和维度不同的向量，在旧实现上失败 |
| D5 | DeepSeek | 去重后结果分类可能变低 | 不成立 | 被去掉那条的正文不会发出，分类按实际发出的记忆计算 |
| G1 | GLM | “调用方显式打开”的说法和服务层固定打开不一致 | 成立，会出错（文档），按中高 | ADR 0221 决定 4 改为写明记忆引擎看调用方开关、`DurableMemoryService.search` 固定打开 |
| G2 | GLM | relevance_unknown 诊断链路没有测试 | 成立，会出错，低 | `file-summary-configuration.unit.test.ts` 新增用例：memory.retrieval 配置和 onRelevanceUnknown 都传到记忆引擎；去掉透传时测试失败 |
| G3 | GLM | 同 D4 | 同 D4 | 同 D4 |
| G4 | GLM | 达到上限后 dropped 不完整 | 成立，可以更好 | 生产不用 dropped，删掉这个返回值 |
| G5 | GLM | 替换后 tentativeNote 消失没有断言 | 成立，可以更好 | 新测试补断言（当前代码就通过） |
| G6 | GLM | 评测数字未核实 | 同 D2 | 同 D2 |

另：开 PR 后 `npm run check` 的边界检查发现评测离线测试在 memory-engine 包内读 `node:fs`，已把测试移到 `test/integration/memory-retrieval-eval/fixture.test.ts`，用 JSON 导入，`npm run check` 全部通过。
