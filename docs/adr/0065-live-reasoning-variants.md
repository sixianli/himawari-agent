---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-21"
---

# ADR 0065：推理档位每次启动实时查询，模型表只记最低档位

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

opencode（本地命令行里的编程代理）的每个模型可以带一个推理档位（`#low`、`#high`、`#max`，表示模型思考得多深）。[ADR 0061](0061-opencode-model-table.md) 把各模型的可用档位抄进了模型表 `.agents/opencode-models.toml`。2026-10-21 这份快照出了错：表里 2026-10-15 的探测记录说免费 DeepSeek V4.1 Flash 没有 `#max`，Claude 据此回答用户，用户用 opencode 界面的截图指出有 `#max`；在 opencode v2.0.32 上用一行提示实测，`#max` 可用。档位随 opencode 的版本变，任何抄下来的清单都会过期。

同日用户要求免费模型至少用 `#high`，复杂任务是否用更高档由 Claude 决定（G153），并提出启动时应实时查询可用档位、再从最新列表里选 `#high` 以上最合适的一档（G154）。

opencode 本地服务的接口 `GET /api/model` 会列出每个模型当前的档位；派活用的启动脚本 `oc-launch.sh`（`opencode-orchestration` skill）本来就为每个任务起一个这样的服务，所以每次启动都能免费拿到最新列表。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **可用档位不再记在模型表里。** 表删除 `variants` 字段，只保留 `min_variant`（新会话允许的最低档位；空字符串表示没有下限）。免费 DeepSeek V4.1 Flash 和免费 GLM-5.3 Flash 的下限是 `high`（G153）；免费 MiMo 没有档位；Go 池不设下限。
2. **启动脚本每次启动前实时查询。** `oc-launch.sh` 向任务的 opencode 服务请求 `GET /api/model`，打印 `LIVE_VARIANTS model=<模型> variants=<当前档位列表>`；请求的档位不在列表里以 `VARIANT_UNAVAILABLE` 拒绝，服务没列出这个模型以 `MODEL_NOT_SERVED` 拒绝，列表读不到以 `VARIANT_LIST_UNAVAILABLE` 拒绝（退出码 3），拒绝信息都带当前列表，供 Claude 重新选。
3. **下限由导出文件强制。** `python3 .agents/opencode-models.py export --all` 在生成白名单 `.opencode/allowed-models.txt` 的同时生成 `.opencode/variant-floor.txt`（每行 `<provider/model> <最低档位>`），`check --all` 一起核对。启动脚本读到这个文件后，低于下限或没带档位以 `VARIANT_BELOW_FLOOR` 拒绝，下限本身不在实时列表里以 `VARIANT_FLOOR_UNKNOWN` 拒绝；模型当前没有任何档位时忽略下限并打印 `VARIANT_FLOOR_IGNORED`。
4. **选哪一档仍由 Claude 按难度定。** 下限之上，按 `opencode-orchestration` skill 的难度规则选：原因不明或跨层、授权、沙箱、存储、协议代码、失败过一次的任务用 `#max`；简报写明做法的编辑、跑验证收证据、文档和小修用下限档。会话内不换档。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

### 方案 A：继续把档位记在表里，发现过期再改（原状）

- 好处：不用改启动脚本。
- 代价：已经误导过一次回答；每次 opencode 升级都要重新探测并改表，没人保证做到。

### 方案 B：启动脚本实时查询，表只记下限（采用）

- 好处：用的永远是当前列表；下限作为项目规则仍可审查、可导出、可核对；错误档位在启动前就被拒绝，不浪费一次会话。
- 代价：启动多一次本地接口请求（不到一秒）；服务异常时启动被拒绝，需要先修服务。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 正面：档位过期这类错误不会再发生；`LIVE_VARIANTS` 行留在每次启动的输出里，可以回查当时有哪些档位。
- 负面：表的 `variants` 字段删除后，`order` 和 `show` 不再显示档位，要看当前档位只能看启动输出或自己请求接口。
- 后续：`AGENTS.md` 的模型一条改为引用本 ADR；ADR 0061 加一行指向本 ADR；[代理工具 Runbook](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/runbooks/agent-tooling-runbook.md) 的拒绝码表补上新的拒绝码。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- 用户原话：`.agents/tasks/round2-tool-execution/goal.md` 的 G153、G154。
- 被细化的规则：[ADR 0061](0061-opencode-model-table.md)（保持有效，只是表少了一个字段）。
- 实现：`.agents/opencode-models.py`、`.agents/test_opencode_models.py`；启动脚本在 `opencode-orchestration` skill 的 `scripts/oc-launch.sh`，测试在它的 `tests/test_oc_scripts.py`。
