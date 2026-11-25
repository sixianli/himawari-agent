<a id="pi-and-workspace"></a>
# Pi 优先与工作区约定

<a id="repository-boundary"></a>
## 仓库边界

- 产品代码和产品文档属于本仓库。
- 同级的 `pi-mono` 仓库是上游源码参考和调试用的检出副本。
- 使用 `/Users/triggerjames/DoNotDeleteThis/documents/sxl_code_work_space/pi-mono` 作为唯一认定的只读 Pi 源码检出副本；不要再去寻找其他检出副本，如果它不可用，要报告。这并不授权本地依赖链接，也不授权提交依赖改动。
- 不得把 Himawari 专属的产品逻辑放进 `pi-mono`。

<a id="pi-first-development-principle"></a>
## Pi 优先的开发原则

- Himawari 构建在 Pi Coding Agent 和 `pi-mono` 中其他可复用模块之上。在设计或实现任何与模型连接、提供方、路由、流式输出、模型运行时、Agent Loop（代理循环）、工具、会话或扩展相关的能力之前，先检查当前的 `pi-mono` 源码和锁定版本的 `@earendil-works/pi-*` API。
- 把对 Pi 的检查限定在与当前改动相关的模块、接口和调用方。依赖关系或尚未解决的证据需要时，再扩大检查范围。
- 只要现有的 Pi 能力已经满足需求，就复用、组合、配置它，或对它做最小的适配。不得仅仅为了做一个产品本地版本，就在 Himawari 里重新实现 Pi 的模块或协议。
- Himawari 自有的代码应当补上 Pi 不负责的产品专属事务，例如权限与审批、数据分级与披露、密钥句柄和主机密钥来源、受保护的 Payload（载荷）、持久状态与审计、产品层面的模型选择/备选策略、预算执行，以及 Gateway/Worker/Memory 的集成。
- 在保留一个重复实现之前，记录下具体缺少哪项 Pi 能力，验证薄适配层或与上游兼容的扩展无法满足需求，并解释为什么必须重复实现。优先选择 Pi 适配层或小型上游扩展，而不是第二套协议实现。
- 怎么接入 Pi（用哪个事件、哪个接口）以 [Pi 二次开发规范](../../docs/pi-development-guide.md) 为准：官方有写法就照官方写，偏离要先出方案经 Andy 同意（[ADR 0294](../../docs/adr/0294-building-on-pi.md)）。
- 做与 Pi 相关的设计或代码审查时，说明复用了哪项 Pi 能力、哪项职责归 Himawari、以及为什么需要额外的实现。这份复用说明的篇幅要与改动大小相称；一个小的适配可能只需要一小段。

<a id="workspace-contract"></a>
## 工作区约定

- 所有直接外部依赖的版本都保持精确；不得为直接依赖引入版本范围。
- 只能在 `packages/runtime-pi` 中导入 `@earendil-works/pi-*` 包；产品领域、契约、应用代码和入口依赖产品自有的类型。
- 把已发布的 Pi 依赖保存在已提交的清单文件和锁文件中。本地 `../pi-mono` 源码链接必须是主动开启的、可撤销的，并且不得改变已提交的依赖声明。
