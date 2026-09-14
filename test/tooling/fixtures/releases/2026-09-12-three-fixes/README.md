# 2026-09-12 发布的冻结探针

`probe-protected-runtime.mjs.txt` 保存历史资格脚本 `hermes-three-fixes-qualify.py` 当时绑定的原始字节，仅作为校验数据，不执行。

- 来源：Git 提交 `1cb72b1` 中的 `scripts/probe-protected-runtime.mjs`（亦即 `e56fa08` 修改前的版本）。
- SHA-256：`8d3c6cc8270dc79d14c1fb97988f1f0dcba97572b623ca49e6cbe1233b92d4de`。
- 当前探针继续保存在 `scripts/probe-protected-runtime.mjs`，允许独立演进。历史资格脚本中的固定发布路径、输入摘要和既有发布证据保持原值。

不要通过修改历史摘要或此快照来适配新版本。新发布须审核自己的输入并绑定自己的版本；历史快照损坏、缺失或内容变化必须使测试失败。使用 `.txt` 后缀避免格式化工具改写原始脚本字节。
