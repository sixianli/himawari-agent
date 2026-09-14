# 本机控制中心重构验收记录

本记录使用正式控制中心源码及 Vite 构建。浏览器连接的是仓库 `test/e2e/fixtures/control-center-browser-server.mjs` 受控服务；模型名、回复、工具结果和审批测试数据均明确为测试输入。它不证明外部模型、真实主机工具或日常安装服务已经可用。

用户确认“还没有，先完成本机版本”。本轮保留冻结原型和 Logo，不升级用户运行目录，不推送、创建 PR 或部署。

## 查看入口

当前本机预览：[聊天页](http://127.0.0.1:4184/threads/thread-main?view=content)。若进程结束，可在项目根目录运行：

```sh
npm run build:browser
HIMAWARI_BROWSER_FIXTURE_PORT=4184 HIMAWARI_EXECUTION_FIXTURE=1 node test/e2e/fixtures/control-center-browser-server.mjs
```

测试服务不调用模型，不执行真实文件工具；提交后只接纳受控 Run，过程事件由测试驱动提供。测试服务自身数据在内存中，重启会重置。正式产品的持久历史由 SQLite/Payload 保存，重开证明来自下列独立集成测试，不能把本预览服务当成已经配置好的个人 Agent。

## 已取得的证据

| 验收项 | 结果和证据 |
| --- | --- |
| 新建、切换、继续对话 | Ego Browser 实际操作新建与切换；Chrome 资格脚本覆盖发送、搜索、重命名冲突重试、置顶、多标签同步、归档恢复、Fork 和删除影响检查。 |
| 多轮及工具记录 | 受控两轮消息分别显示独立过程；启动、结果事件按稳定 ID 合并；重复通知不增加重复条目。SQLite/Pi 定向回归 161 项通过，Run/Worker 定向回归 85 项通过。 |
| 输入、附件和草稿 | 实际选择 UTF-8 文本附件，文件名与正文进入草稿；真实 Shift+Enter 键盘事件插入换行；刷新后正文保持。浏览器单元测试 49 项通过，覆盖无效 UTF-8、二进制、大小上限、偏好和 SSE。 |
| 模型与深度 | 浏览器当前轮模型 B/medium 与下一轮选择 A/high 分开显示；Pi 适配测试确认支持的 high 传给 Session，不支持的深度在创建前拒绝。SQLite 重开保留 Run 选择。配置未安装与跨 Thread 取消负例由 Gateway 集成测试验证（该文件共 3 项通过）。 |
| 流、滚动、停止 | 实际 SSE 通知驱动受控记录更新；向上滚动暂停跟随并出现回到最新入口；停止发送取消命令并读回 cancelled。重复事件、旧连接回调由浏览器单元测试覆盖。 |
| 审批、拒绝与恢复 | Chrome 资格脚本实际操作原有审批页的批准、拒绝、近期认证限制和撤销冲突。聊天等待与恢复由受控事件驱动，工作/等待时间分开累计。不是外部模型与真实工具的审批端到端验收。 |
| 离线、刷新、重连 | 断网立即显示离线并禁用发送；草稿保留；重新联网、关闭重开和 durable cursor 由 Chrome 资格脚本验证。受控服务同时重放事件并断开后重新连接已验证。已持久化历史的服务重开由 SQLite 集成测试证明。 |
| 外观 | 实际点击 Light/Dark × 六色共 12 组合；`theme-matrix.json` 证明同一主题内中性背景、正文、成功/等待/错误色均不随主题色改变。 |
| 桌面、手机、语言与无障碍 | `browser-chrome/browser.json` 为 fixture-only 通过：11 页面、zh-CN/en/ja、键盘焦点、320px 重排、最小按钮高 44px、axe 0 违规。另用 Ego Browser 检查 390×844、320×820 和截图；末次手机菜单 CSS 调整后已重新执行完整 Chrome 资格脚本，共 26 条流程通过。 |
| 原始资源 | `SHA256SUMS` 中全部文件校验通过，原始 Logo 和原型目录无 Git 差异。 |

## 与已确认原型的比较

布局保留 220px 侧栏、66px 顶栏、约 720px 阅读宽度、底部输入和按需详情。深色/浅色中性色、字体栈和六色取自冻结原型。正式页面使用现有 16 个管理模块入口；因此侧栏底部导航可以滚动，搜索和状态筛选保留原有真实能力。

已确认 Logo 原图为带浅底的 RGB PNG，按有底图标使用，未冒充透明图，也未改造花形。真实模型与深度来自配置，未移植原型的示例模型。thinking 无允许展示的摘要时显示缺失说明；工具用途、输入输出和耗时仅显示已有记录。

手机提高按钮高度到 44px；选中对话的小号文字提高对比度。主题菜单的顶栏按钮样式限定到直接子元素，避免把颜色标签压成竖排。以上为响应式和无障碍适配。

原型提供聊天内直接允许/拒绝；本轮实现为聊天中的审批入口跳转到原有完整确认页。用户查看差异后明确回复“接受”，已确认本轮采用这一审批交互。现有风险说明、近期认证和确认步骤继续保留。

## 截图

- [深色桌面](desktop-dark.png)、[浅色桌面](desktop-light.png)、[模型菜单](model-picker.png)
- [工具执行](tools-running.png)、[审批等待](approval-waiting.png)、[逐轮历史](turn-history.png)
- [手机](mobile-dark.png)、[手机主题菜单](mobile-theme-picker.png)、[320px](mobile-320.png)、[离线草稿](offline-draft.png)

## 完整检查状态

最终源码的 macOS arm64 安装包已构建通过（`.ci-output/local-1789036004026/build-macos-arm64/result.json`）。unit 787 项、contracts 266 项通过；integration 分项覆盖 62 文件共 787 项：普通集成 60 文件 781 项，最终安装包的 HTTP 进程 2 项及安装/启停/恢复/权限交接 4 项通过。browser/Pi/E2E 合计 16 文件、123 项通过，其中 browser 49 项也包含在 unit 总数中，不重复累计。

早先完整 `npm test` 的 integration 超过运行器固定 300 秒上限，被 SIGKILL 后没有完整报告，因此该次命令结果为 infrastructure_failed。分项补跑中漏传固定 Python 环境变量导致两个安装测试套件启动失败；补齐后执行成功。一次并发 Job Host 用例在并行构建时超时，后续独立集成执行中 322 毫秒通过；没有修改测试超时或 CI 门槛。使用最终安装包再次执行项目完整测试入口后，unit/contract 再次通过，integration 仍在 300019 毫秒被运行器以 SIGKILL 终止；最终结果为 `infrastructure_failed`（`.ci-output/local-1789037011963/test-macos-arm64/result.json` 与 `tests/integration.log`）。本轮不宣称完整命令通过。

先前两次构建因并行编辑导致输入摘要变化而拒绝，测试未执行，不能计为成功。早期宽测暴露的 revision 零通知、迁移测试旧 schema 复制和旧包数量断言已分别修复并有定向复验；产物包数量原先写死 15，而当前 SRT 依赖分支已有 16 个 workspace，仅更新该测试预期，不更改依赖清单。安装服务测试仍预期 schema 23，实际 `db.status` 为 schema 30 且 quickCheck 为 ok；同步到 migration 0030 后四项安装服务测试通过。

真实模型调用、真实主机工具、真实服务重启/迁移、跨平台设备实机和生产安装资格未验证。手机测试是浏览器尺寸/触摸模拟，不是 iOS/Android 实机验收。

`npm run check`、最终改动测试文件的 Biome 检查、文档严格校验及 `git diff --check` 均通过。分项证据与最终安装包摘要见 [verification.json](verification.json)。
