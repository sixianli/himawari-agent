# PR 431 第 2 轮逐条判断（DeepSeek）

1. 高：删掉台账条目后，本 PR 和合并提交在 main 上的 CI 都会判红。成立，会出错，中高。读代码核对：push 事件的 base 是 `payload.before`（`scripts/ci/context.mjs`），台账取 base 的版本，所以合并提交那次也按旧台账核对。修法采用模型的建议：候选台账删掉的 published-synthetic-fixture 条目不再算例外（`loadReviewedExceptions` 返回 `removedPublishedPaths`，`createPublishedFixtureReview` 把这些路径从期望里去掉）。这只会让检查更严：被删的成员如果还有命中，就不在期望里，按 `PUBLIC_ARTIFACT_CONTAINS_SECRET` 失败；候选新增或放宽的条目仍然无效，例外照旧只能来自 base。加了两条用例：删掉后成员干净时通过、删掉后仍有命中时失败。去掉这处过滤后，两条都失败（已运行）。
2. 中：真实台账测试不检查被删除的条目。成立，会出错，中高。上一条的机制让 CI 的产物扫描自己核对被删条目（还有命中就失败），并有两条用例钉住；真实台账测试只负责“留下的条目和当前扫描一致”。
3. 中低：测试直接用台账 path 拼路径。成立，会出错，低。触发：台账里出现 `runtime/../../x` 这类路径；后果：测试读到仓库外的文件（只读，只在测试里）。模型给的是“中低”，我判低，因为台账本身先经过 `validateSecurityExceptions` 的 `exactPath` 校验才会在 CI 里用，且测试只读不写。已在测试里加路径形状和 `runtime/<packageLockPath>/` 前缀的断言。
4. 低：全大写无数字的真实值仍会放过，`$API_KEY_2024` 会被报。成立，会出错，低。触发：真实密钥恰好是 `$` 加 12 个以上大写字母或下划线；后果：credential-literal 不报，但私钥、sk-、gh*_、AKIA、Bearer、JWT 等格式规则照样检查。这和 gitleaks 默认配置的取舍完全相同，不再改；`$API_KEY_2024` 被报是更严的方向，不会漏报。
5. 信息：作者说明里把 5 条归零归因于第 2 轮的正则收紧，时间线不准确。成立，可以更好：只涉及说明文字，不改变代码和事实。第 2 轮说明里写的是“规则改后”，这里更正：第 1 个提交（616f77439）就已经让这 5 条归零。
