# PR 354 第 1 轮复核判断

| 编号 | 意见 | 判断 | 处理 |
| --- | --- | --- | --- |
| r1-ds-1 | 测试和适配器格式不符合 Biome | 成立，会出错（中） | `biome format --write` 两个文件 |
| r1-ds-4 / r1-glm-3 | `getToolDefinition` 查的是注册表，含没激活的工具 | 成立，会出错（中）：1.5.0 `getToolDefinition` 读 `_toolDefinitions`，活动工具是 `agent.state.tools` | 先查 `session.getActiveToolNames()` 再取定义，和原来完全一致；加用例：注册了但没激活的可并行工具按顺序执行处理，激活后按并行处理 |
| r1-ds-2 / r1-glm-1 | 偏离表 D5 官方写法列还写“读工具执行方式需要另查” | 成立，会出错（低） | 删掉这半句，位置列补 `getActiveToolNames` |
| r1-ds-3 | ADR 只引了续跑协议测试 | 成立，会出错（低） | 前提 5 补上适配器的 “suspends and resumes a generic side-effect tool” |
| r1-glm-2 | Pi 源码前提无法核实 | 不成立：线程在装有 1.5.0 的副本里读过这些行（`agent-session.js` 第 1100、1123、1248 行，`tool-definition-wrapper.js` 第 11 行），模型的副本没有 `node_modules` | 不改 |
| r1-glm-4 | 另两个测试的假会话没有 `messages` | 成立，可以更好：改动前它们也没有 `agent.state`，不是本 PR 引入 | 不改，列给 Andy |
