# PR 451 第 4 轮：合入 main 后的改动

第 3 轮之后，第 3 批（PR 444）已合进 main，本分支合入了最新 main，并把感知两个工具改接到 main 的统一审批。请看相对第 3 轮的增量，重点是下面几处。

## 作者的说法（请核对，不要直接采信）

1. 删掉了临时的外来内容闸门：`perception-origin-gate.ts`、表 `perception_run_reads`、端口方法 `markRunRead`/`runReadRecordIds`/`runInitiator`、配置 `runReadMaximumRecords`、两条闸门提示词都已删，没有别处再引用。
2. 工具动作登记表（`production-tool-actions.ts`）多两行：`perception_read`（读取，结果来源外来）和 `device_action`（走“主人范围”授权）。
3. `perception_read` 返回的记录里有来源为“其他”的，就调用 `markExternalContent`，在 `production-runtime-tools.ts` 里记成来源名 `perception_read` 的外来内容标记。
4. `device_action` 只有非读取动作、且设备和动作都核对通过后，才调用 `authorize`（即主人范围授权的闸门）；`describe` 和读取类动作不过审批。被拒时用 `OwnerScopeStop` 把授权结果原样返回，动作不执行。
5. 迁移改成时间戳命名 `20261114160000_perception_extraction.sql`，只建 `perception_extractions`、`perception_command_utterances` 两张表。
6. 测试里的工具定义指纹按 main 上 PR 414 给规则加静音类别后的实际值更新（和本 PR 无关，main 上该用例本来就是红的）。

## 约束

和前几轮相同。
