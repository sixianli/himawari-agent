# PR 562 第 1 轮复核材料

问题：App 的想一想设置页只能按 key 写死文案，规定不许写死。
做法：`think.settings.snapshot` 每项新增 `label`、`description`、`unitLabel`，各带 `zh-CN`、`en`、`ja`；文字在 `production-think-settings.ts` 的 `THINK_SETTING_TEXT`（按 ThinkSettingKey）和 `THINK_SETTING_UNIT_TEXT`（按单位）里，少一项编译不过。查询参数不变，旧客户端照常能用。
作者的说法，请核对：1. 文字描述和代码实际行为一致（例如排队上限包括正在想的、两个门槛之间算拿不准也跳过、超时后记失败）。2. 新字段的长度上限 400 字够用且不会让快照校验失败。3. 不涉及发给模型的内容。
