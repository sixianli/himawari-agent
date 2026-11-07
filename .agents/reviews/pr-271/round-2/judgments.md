# PR 271 第 2 轮代码复核：逐条判断

复核的提交：`831db506`（基点 `1f12c92f`，上一轮 `91776732`）。只用 DeepSeek，`ok`，这一轮 0.0485 美元，累计 0.1986 美元。机器可读的判断在同目录 `verdicts.jsonl`。

模型确认第 1 轮的 D2、G2 两处修改有效：互换恢复和控制动作会被新断言挡住，把 `check:delivery-rollback` 改成 `"true"` 会让 `check:check-runner` 失败。

## 会出错

没有。

## 可以更好（不修改，列给 Andy）

- R2-1（模型给“中”）：恢复动作名在 `run-step.py`、`run-maintenance.mjs`、`run-user-maintenance.sh`、`S9-control-files.py` 四处各写一份，新断言只核对了 `run-step.py`。这是本 PR 之前就有的缺口，当前四处一致。建议另开一项：把动作表收成模板里的一份，或在 `PlanTest` 里逐处核对。
- R2-2（低）：`re.search(...).group(1)` 找不到时抛 `AttributeError`，测试仍失败、仍拦下合并，只是信息不直白。
- R2-3（低）：控制命令的正则要求恢复动作是最后一个参数，以后加尾部参数会误报失败，不会放过错误。

## 不成立

- R2-4（低）：`test_release_cleanup.py` 读 `/proc`，Mac 上会失败。项目规则不在 Mac 上跑测试，`npm run check` 只在 Hermes 和 `himawari-ci`（都是 Linux）上跑，Hermes 实测全过。
