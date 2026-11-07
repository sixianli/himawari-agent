# 第 1 轮逐条判断（PR 280，提交 51d1705a）

方案性质：这是根治（改了探测脚本，并加了出包时真跑它的门槛）。大厂做法是发布前在构建环境对候选版本跑验收探测。

## 会出错，已修改（全部判为低，见 verdicts.jsonl 的理由）

- ds-1 探测没有超时：加 900 秒超时，超时写 `INSTALLED_PROBE_TIMEOUT` 并失败；测试 `test_a_probe_that_never_returns_is_stopped_and_reported`。
- ds-2 / glm-2 工具目录可回退到系统工具：目录必须存在，fd 只从该目录取，bash、rg 取系统目录；I-81 措辞同步；测试 `test_fd_comes_from_the_given_directory_and_the_other_tools_from_the_system`。
- ds-3 / glm-1 `adapterSha256` 无人核对：先用脚本核对五个适配器的值都等于文件实际哈希，再加测试 `test_every_adapter_hash_in_the_adaptation_manifest_matches_its_file`。
- ds-4 / glm-3 报告校验宽松：要求 `reports` 是列表且行数等于期望数；测试 `test_a_report_without_the_expected_number_of_rows_is_refused`。
- ds-6 / glm-5 环境变量措辞：I-81 改成列出实际变量，并说明不含 `HIMAWARI_QUALIFY_INSTALLED_RUNTIME`（`probe-foreground.mjs` 里 grep 该名为 0 次，探测不读它）。

## 可以更好（不改，列给 Andy）

- ds-5 `binaries.mkdir` 加 `exist_ok`：现在候选包没有该目录，将来有则直接失败（失败关闭，不是错误通过）；建议暂不改。
- glm-6 补“旧上线包缺这一项会被 deploy 拒绝”的测试：`generated-packet-gate.py` 已按 `plan()` 取必需检查，`test_deploy` 的记录生成器也用它；建议采纳需 Andy 说。
- glm-7 `run_installed_probe` 全链路只在 Hermes 真跑：已知限制，门槛证明就是这条；建议不采纳。

## 不成立

- glm-4 删注释：项目规则要求删除编辑过的文件里的注释（`~/.agents/AGENTS.md` Engineering and Design），不是缺陷。
- glm-8 `piToolBin` 缺键：`hermes/builder.json:10` 有该键（GLM 自己也核对到），是实例配置，推测风险。

## 未核实项的核对

- 两个新哈希：已用 `shasum` 重算，且五个适配器的值全部等于文件实际哈希。
- Hermes 结果：见提交说明，第 2 轮后重跑。
