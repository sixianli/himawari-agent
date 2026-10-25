---
status: "archived"
document_type: plan
supersedes: ""
superseded_by: ""
date: "2026-09-15"
---

# 控制中心 v4 实施计划

**来源：** [SOURCE: docs/execution/specs/2026-09-15-control-center-v4-design.md]

## 边界与依赖

复用现有 React 控件、Gateway 幂等命令、Pi 模型呈现和持久执行投影。按批准的页面体验迁移调用关系，不更改提供商配置，不执行生产发布。原有未跟踪浏览器证据保持原样。

## 实施顺序

- [x] 保存 v4 原型、截图、字节校验与批准记录。
- [x] 检查既有实现和回归路径，保留实际运行失败证据。
- [x] 新建草稿、首次发送、切换与失败重试。
- [x] 侧栏管理、归档、会话红点和统一设置。
- [x] 模型滑块、输入焦点和逐轮工具展示与真实计时。
- [x] 场景截图对照与浏览器/集成回归。
- [x] 必需质量检查、文档核对及审阅变更。
- 本地提交作为本次交付的最后一步，包含实施、测试和批准记录。

## 证据与完成条件

证据保存于 `test/qualification/evidence/control-center-v4/`；决策记录为其中的 `decisions.tsv`。现有 `.agents/skills` 未发现项目验证 skill，故不凭空新建或声明维护过验证 skill。

验证命令：`npm run test:browser`、相关集成测试、`npm run check`、`npm run build`，以及新增的持久 Playwright 场景。每阶段先做窄范围验证，最后按影响扩大。受阻的真实服务或视觉差异必须保留为未完成，不得以模拟结果替代。

## 交付核对

本地安装包测试 3,365 项通过；浏览器组件 355 项通过；Node 服务 380 项通过。最终 Chrome 的首次加载、移动端、权限、同步与四组工具过程测试通过。具体报告与视觉差异说明见 `test/qualification/evidence/control-center-v4/verification.md`。原型九个关键部件属性相等，整图非零像素差异不冒充逐像素一致。没有生产发布。
