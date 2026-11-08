# PR 310 第 1 轮复核：线程逐条判断

复核提交 `3f32cb87`，两个模型经 Magpie 一次跑成，累计 0.2934 美元。

结论：有 1 条中、高严重度的“会出错”意见（DeepSeek 第 1 条），已改，需要再复核一轮。

## 会出错

| 意见 | 严重度 | 改法 |
|---|---|---|
| 网页导入只用旧的 `mentionsSensitiveMaterial`，“pwd:”“PIN码是”这类写法没标敏感，默认勾选、按 private 入库（DeepSeek 第 1 条） | 中、高 | `parseMemoryText` 再并入 `classificationWithIdentifiers(line, "private") === "sensitive"`；测试覆盖 pwd、PIN码和普通句反向，去掉修改后测试确实失败 |
| ADR 0185 决定 2 说含密码的提醒推送自动隐藏，说过头（DeepSeek 第 4 条、GLM 第 1 条） | 低 | 改成“被这样认出来的提醒”，并指向已知缺口 |
| 案例库还写导入直接丢密码行，评测脚本 Arm B 还写密码用 restricted（DeepSeek 第 5 条） | 低 | 两处改成现行为；sensitive-capture README 补 `containsCredential` |

## 可以更好（不单独再复核）

- 导入“勾选敏感行再导入”缺测试（DeepSeek 第 2 条、GLM 第 3 条）：已补并运行通过。
- `containsCredential` 的假阳性（DeepSeek 第 3 条、GLM 第 2 条）：与出口遮盖同一规则，是决定 2 的原意。
- I-78 反向用例换成合成文字（DeepSeek 第 6 条）：机制仍被测，真实提示词的正向用例保留。
- 提示词版本号没 bump（GLM 第 4 条）：该值只写不比。

## 不成立

- 评估数据集 secret 组负例（GLM 第 5 条）：模型自己标推测，两条样例都是一次性任务，与新提示词不矛盾。
