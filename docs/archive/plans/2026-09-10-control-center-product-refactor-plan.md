---
status: "archived"
document_type: plan
supersedes: ""
superseded_by: ""
date: "2026-09-10"
---

# 控制中心重构实施与验收计划

**来源：** [SOURCE: docs/archive/specs/2026-09-10-control-center-product-refactor-design.md]

## 文件与工作边界

前端在 `apps/control-center`；真实展示链路涉及 Gateway contracts、application、runtime-pi、SQLite 与 agent-service。测试分别使用已有 browser、integration、pi-compat 和浏览器资格工具。冻结资源目录保持不变，不修改 Pi 只读源码。

## 实施任务

1. [x] 核查 Git 依赖、项目指引、设计与 Pi 0.84.2 事件映射，保存改动前检查结果。
2. [x] 页面与偏好：Shell、品牌、双主题、六色、Thread 导航、输入和详情组件；验证三语与手机阅读。
3. [x] 执行记录：复用持久化 Trace、受保护 Payload 与取消机制，补齐真实流、逐轮记录、工作和等待计时及恢复。
4. [x] 输入选择：明确附件/执行模式范围，模型与思考深度按提交冻结、验证能力和持久化恢复。
5. [x] 综合检查：项目 check、相关测试、生产构建、文档验证、冻结资源校验及真实浏览器流程。
6. [x] 复核任务 diff，按独立目的本地提交，记录可查看入口、截图、验证边界和工作区状态。

## 证据与记录

- 决策记录：`test/qualification/evidence/web-refactor-2026-09-10/decisions.tsv`，按 show-me-your-work 维护。
- 改动前：`npm run test:browser` 7 个文件 / 40 项通过；`npm run build:browser` 与静态包边界检查通过。
- 浏览器本地受控入口：`http://127.0.0.1:4184`，使用正式构建和既有 fixture 服务，不是真实模型验收。
- [本机验收记录](../../../test/qualification/evidence/web-refactor-2026-09-10/acceptance.md) 保存逐项结果、截图、复现入口和验证边界。分项测试、最终安装包和 Chrome 资格检查通过；完整测试入口重复触及 integration 的 300 秒上限，结果为 infrastructure_failed，不能记为通过。用户已明确接受聊天跳转原有完整审批确认页。本机实现按此范围交付，完整测试入口超时仍保留为验证限制，不宣称 CI 全通过。

## 完成条件

全部验收条件有明确结果，当前事实文档已更新且任务提交完成。存在重要未完成能力或未获确认的产品语义时保持 active，不以样式完成代替整体完成。

## 本机交付结论

本轮实现与已确认的审批适配已完成；本地提交保存正式源码、直接相关测试、文档和截图。验收记录明确区分分项通过、完整测试入口超时及未进行的真实模型/主机工具验收。不将归档或本地提交解释为远端 CI、生产部署或真实服务资格通过。
