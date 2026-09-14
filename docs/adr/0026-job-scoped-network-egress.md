---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-09-10"
---

# ADR 0026：Job Host 管理每作业可信网络出口

## 背景

R8 实机反例显示，SRT 0.0.75 对 domain:port 的允许列表匹配后仍会解析并连接回环地址；操作系统阻止直接 TCP 不代表经 HTTP/SOCKS 代理的地址边界成立。Owner 比较过可行路线后，明确批准复用 SRT 上游代理能力、由 Job Host 管理可信出口的方案。本决定补充 ADR 0025，不替代其生命周期、授权或平台保证。

## 决定

每个 Job Host 建立自己的认证 HTTP 上游出口，固定 `parentProxy.http` 和 `parentProxy.https`，显式清空 `noProxy`。SRT 继续实现客户端 HTTP、CONNECT、SOCKS 和 OS 隔离；SOCKS 由 SRT 转为上游 CONNECT。Himawari 只负责这个上游的目标、地址与连接生命周期，不新增 SOCKS 实现，不解密 TLS，也不注入真实凭据。

出口使用冻结的确切小写 hostname:port，在每次建连时解析并检查全部地址；保守拒绝非公网、特殊用途、映射与转换地址，再用检查过的数字 IP 建立连接。不能先检查后重新按域名解析；TLS 的服务器身份仍由原客户端按原域名验证。HTTP 请求不自动跟随重定向，后续新请求重新核对目标。请求头去除代理认证和 hop-by-hop 字段，原请求体流式传输；这不替代原 Grant 的数据披露与预算约束。

出口准备完成后才允许 SRT 初始化和任务启动；停止时立即关闭监听和所有连接，待完成后记录计数与关闭事实。等待中的 DNS 返回必须再次检查关闭状态，不能在撤权停止后创建迟到连接。进程崩溃会丢失内存证据，仍沿原监督丢失与隔离规则处理，不能重建确认记录。

SRT 0.0.75 的代理 URL 使用 localhost，在当前受限 Mac Node 客户端中解析失败。Job Host 在 SRT 包装内部仅把其生成的代理变量主机名规范为 127.0.0.1，保留认证和端口，不开放额外 DNS 服务。冻结的目标策略、runtime 摘要及 runner 摘要共同绑定这一强制路由实现；动态端口与认证不接受模型输入，也不写入证据正文。

## 比较过的方案

- SRT 上游扩展：可减少代理层，但当前固定版没有连接地址校验/拨号钩子；不以维护私有 fork 或修改 node_modules 作为本次实现。
- 现成外部代理：需要额外验证每作业身份、关闭语义及跨平台安装，未证明优于小范围的认证 HTTP 上游。
- 狭窄下载/安装适配器：适合特定操作，但不能完整替代本次通用联网工具需求。
- VM/容器：可用于更强隔离需求，但不是本次隐式安装项，仍需出口与生命周期资格。

## 后果

Himawari 需要维护 HTTP 转发、CONNECT、解析地址分类和有界关闭的回归验证。特殊用途地址按保守策略拒绝，不能自动允许局域网 registry；需要此能力时应另行设计授权与资格。系统 DNS、已外发的数据、Mac 脱离后代的文件权限不受这个出口完全控制，不宣称绝对零外联、可撤回外发数据或瞬时撤销文件权限。平台/mode 未测或失败时不注册。

## 关联

- [SOURCE: docs/adr/0025-pi-tools-and-managed-execution-lifecycles.md]
- [SOURCE: docs/execution/specs/2026-09-07-srt-unified-execution-design.md]
- [SOURCE: docs/execution/plans/2026-09-07-srt-unified-execution-plan.md]
