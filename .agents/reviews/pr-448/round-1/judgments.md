# PR 448 第 1 轮逐条判断（只跑 DeepSeek）

1. 第 1 轮替补没有在 Magpie 里预留 GLM：成立，会出错，中高。依据：`reserveModels` 仍要求 `previous`，而 `substituteFor` 已不要求。改法：`reserveModels` 去掉 `previous` 条件；`test/tooling/review-gateway.test.mjs` 加第 1 轮（`previous` 为空）也预留 GLM 的断言。
2. 合并前检查把账本里任意模型名当成要跑的模型：成立，会出错，中高（能绕过合并前检查）。依据：`coveragePoints` 的 `requested` 直接取账本的 `model`，`parseUsage` 只要求它是非空字符串。改法：`requested` 只认 `allowed` 清单里的模型，并且只认没有 `substitute` 字段的记录（`substitute` 写成字符串的不算直接结果，也不算替补）；`test/tooling/opencode-review-merge-gate.test.mjs` 加三条反向用例，都必须报 `no-complete-round`。
3. `allowed` 的校验不保证模型有固定侧重和输出上限：成立，会出错，低（只有改配置的人加了脚本不认识的模型才触发，触发后是 `LENS_UNKNOWN` 报错停下；另外文档说“只改这个文件”不准）。改法：`model-review.md` 写明 `allowed` 里的模型还要有 `MODEL_LENSES`、`MODEL_OUTPUT_LIMITS` 和 `gateway.json` 条目；`test/tooling/opencode-review.test.mjs` 加断言核对现有每个模型三样都有。没有把这项校验放进 `reviewModelsProblems`：`MODEL_LENSES` 在模块里定义得比读配置晚，挪动顺序的改动比这条意见本身大。
4. `delegate.mjs` 用本地的默认模型：成立，会出错，低（触发后是拒绝一份正常结果，不会放过错误结果）。改法：`reviewArgv` 总是写出 `--models`（任务没写时写本地的默认模型），云端跑的和本地核对的就是同一份清单，不再依赖交接分支上的配置；`test/tooling/review-delegate.test.mjs` 加断言。

必答问题四项模型都答了，没有另外的问题。
