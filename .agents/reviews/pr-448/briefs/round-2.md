# PR 448 第 2 轮：对第 1 轮意见的修改

第 1 轮四条意见都判为成立，修改如下，请核对修改是否到位、有没有引入新问题：

1. `reserveModels` 去掉 `previous` 条件，第 1 轮单模型代码复核也为替补预留 GLM。
2. `coveragePoints`：`requested` 只取 `allowed` 清单里、且没有 `substitute` 字段的记录；“直接通过”同样只认没有 `substitute` 字段的记录。
3. `model-review.md` 写明往 `allowed` 加模型还需要脚本里的固定侧重、输出上限和 `gateway.json` 条目；测试核对现有模型三样都有。没有把这项校验放进 `reviewModelsProblems`。
4. `delegate.mjs` 的 `reviewArgv` 总是写出 `--models`（任务没写时用本地默认模型）。

逐条判断见 `.agents/reviews/pr-448/round-1/judgments.md`。
