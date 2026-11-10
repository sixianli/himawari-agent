# PR 344 第 1 轮复核判断

这一轮没有成立的“会出错”意见。

## 不成立

- r1-ds-1 / r1-glm-1（模型判中，线程判不成立）：新增例外在本 PR 自己的 CI 里不生效，要合进 main 才生效。这是例外清单的既有设计（加载时读 base 上的文件，`scripts/ci/security-exceptions.mjs` 的 `loadReviewedExceptions`），PR 338 的 18 条当初也是这样生效的，PR 描述“需要 Andy 的地方”一段已写明，不是本改动引入的错误。
- r1-ds-5：我的模拟已把 node-forge 清单条目排除在新增之外，60 条发布夹具例外加 node-forge 的 1 条共 61 个命中成员，全部覆盖；PR 描述写的就是这个口径。

## 可以更好（不改，列给 Andy）

- r1-ds-2：作者说明里“现有 51 条”不准，改动前清单共 34 条（18 条发布夹具加 16 条合成字面量）。只出现在 PR 描述和提交说明里，不在仓库文件里；PR 描述已更正。
- r1-ds-3：`sourceProofSha256`、`sourceReview` 只有格式校验，没有自动核对来源。是既有设计，本 PR 的值是官方 tarball 的 SHA256。
- r1-ds-4：命中行与理由是否逐条一致。作者已逐条读过命中行并在 PR 描述中分组列出；模型离线读不到 tarball，无法核实，不是发现的错误。
- r1-glm-2：`PUBLIC_FIXTURE_PACKAGE_SOURCE_CHANGED` 没有反向测试。是已有检查的测试缺口，与本改动无关。
