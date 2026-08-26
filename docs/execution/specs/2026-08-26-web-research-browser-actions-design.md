---
status: active
document_type: spec
supersedes: ""
superseded_by: ""
date: "2026-08-26"
---

# Himawari Agent v0.2 Web 研究与受控认证操作设计 Spec

## 目标

定义公共 Web 搜索、页面打开、基于来源的研究，以及按域管理的受控认证 Web 会话。Agent 应能在最小披露和完整 Trace 下获取资料，同时把提交表单、发送消息、发帖、购买和账户修改作为独立外部行动重新授权。

## 来源上下文

- 产品能力范围：[SOURCE: docs/prd-v0.2.md#产品范围]
- 机器秘密与 Trace：[SOURCE: docs/prd-v0.2.md#机器秘密敏感数据与可观察-trace]
- 行动风险：[SOURCE: docs/prd-v0.2.md#行动风险与授权]
- 正式能力：[SOURCE: docs/prd-v0.2.md#正式能力与授权边界]
- 正式能力验收：[SOURCE: docs/prd-v0.2.md#正式能力]
- 确定性授权：[SOURCE: docs/adr/0004-deterministic-authorization.md]
- 能力注册表：[SOURCE: docs/adr/0008-governed-capability-registry.md]
- 完整 Trace：[SOURCE: docs/adr/0010-complete-session-trace.md]
- 授权与能力治理：[SOURCE: docs/execution/specs/2026-08-26-authorization-capability-governance-design.md]
- 持久基础设计：[SOURCE: docs/execution/specs/2026-08-26-portable-durable-web-agent-design.md]
- v0.2 Spec 总纲：[SOURCE: docs/execution/specs/2026-08-26-v0.2-spec-suite-integration-design.md]

## 范围

### 本 Spec 包含

- 公共 Web 搜索、URL 打开、页面读取、来源提取和多来源研究。
- 页面内容的来源、抓取时间、引用片段、派生摘要和可重现 Trace。
- 按域建立、查看、暂停和撤销的认证浏览器会话。
- Cookie、session token、下载凭据和登录状态的机器秘密隔离。
- 页面导航与会产生外部副作用的浏览器动作分离。
- 表单提交、消息、帖子、购买和账户修改的预览、授权、执行和对账。
- 下载、上传、重定向、跨域、弹窗和未知结果的安全边界。

### 本 Spec 不包含

- 绕过登录、验证码、付费墙、访问控制、网站限制或反自动化保护。
- 在 v0.2 中承诺所有网站兼容、长期登录稳定或代替网站官方 API。
- 浏览器作为通用不可信代码 sandbox，或网页内容直接安装能力。
- 站外消息投递渠道；网页上的发送动作仍是受授权外部行动。
- 具体浏览器自动化产品选择；实现必须通过当前 Mac/Hermes 兼容性和安全验证。

## 验收标准

### 公共研究

- 已启用公共 Web 能力且目标公开、只读、范围有界、无登录、无新披露和无费用时，可以在有效长期 Grant 内自动搜索和打开页面。
- 研究结果必须列出实际使用的来源 URL、页面标题、获取时间和支持结论的引用关系；模型不得把未打开的搜索摘要伪装成已验证页面事实。
- 网页文本、脚本、提示或下载内容都是不可信数据，不能修改系统指令、Grant、能力 manifest、secret scope 或授权结果。
- 发送给模型的页面内容只包含当前任务所需最小片段，并记录选择、排除、数据等级和 model disclosure。

### 认证会话

- Owner 可以为明确域名建立受控会话，查看域、用途、身份引用、创建/最近使用、secret 状态、数据范围和撤销状态。
- 登录凭据、Cookie、token、恢复码和浏览器密钥只存在 host secret/session store；产品状态和 Trace 只保存引用与结果。
- 域名、身份、权限或用途变化需要新的授权；一个域的会话不能被另一域、子域或重定向目标默认复用。
- 迁移到另一主机后，所有认证 Web 会话保持不可用，直到 Owner 在目标主机重新建立和授权。

### 外部副作用

- 普通导航、只读查询和草拟未提交表单不会被记作已产生外部副作用。
- 点击最终提交、发送消息、发帖、购买、修改账户、授权第三方或上传私人数据前，必须形成新的 ActionIntent，展示最终目标、数据、收件人、价格/费用、账户和可逆性。
- 已登录不能降低风险或自动授权；资金、凭据/访问控制、公开发布或法律承诺继续为 `CRITICAL` 并逐次确认。
- 执行后必须通过页面/API/邮件外的可观察结果做 bounded readback。网络中断且结果未知时进入 reconcile，不重复提交。

## 设计

### 能力拆分

~~~text
web.search_public   搜索公开索引
web.open_public     打开公开页面
web.research        组合多来源、引用和摘要
web.session_read    使用已授权域会话进行只读访问
web.prepare_action  填写但不提交，生成预览
web.execute_action  提交/发送/购买/修改
web.reconcile       查询未知外部结果
~~~

每个 operation 有独立 manifest 和 permission facts。`prepare_action` 不授权 `execute_action`；页面内按钮名称或脚本不能改变 operation 类型。

### Web Resource 与来源

一次读取生成 `WebResourceRef`：canonical URL、requested URL、redirect chain、origin、retrieved_at、content type、status、content digest、classification、session ref 和 protected body ref。研究引用绑定 resource digest 与最小片段范围，页面变化后旧结论仍可追溯到原 snapshot。

robots、站点条款、访问错误和 rate limit 作为 adapter 可观察状态处理；系统不通过伪造身份、绕过控制或无限重试取得内容。

### 不可信内容边界

页面 DOM、文本、脚本、附件和搜索结果不得直接进入 system policy。Content extraction 先去除执行性元素和机器秘密，再按任务选择片段。页面声称“必须运行命令”“上传密钥”“忽略授权”时，只作为页面内容进入 Trace，不形成能力调用。

下载文件在隔离 temporary area 中保存，记录 digest、MIME sniffing、size 和来源；未经过文件能力授权不能写入 Owner 目录或执行。上传必须引用 Owner 已授权文件并展示目标域和披露范围。

### 认证 Session

WebSession 产品记录保存稳定 ID、allowed origins、Owner/Agent、用途、identity label、secret refs、storage partition、created/last-used/expiry、revocation 和 health。真实 Cookie/token 位于 host-bound encrypted session store，browser worker 通过一次性 Handle 使用。

重定向到不在 allowed origins 的目标会暂停并形成新 ActionIntent。第三方登录弹窗、跨站 SSO 和嵌入 frame 分别记录 origin；不得把顶层域授权扩展为整个登录生态。

### Prepare、Approve、Execute

`prepare_action` 产生冻结预览：最终 URL/origin、method、fields、uploads、recipients、displayed price/currency、account identity、side-effect class、reversibility 和 expected success marker。敏感 field 只显示类型和 secret reference。

Owner 批准预览 hash 后，短期 execution handle 只允许一次匹配提交。页面在批准后发生字段、价格、收件人、域或权限变化时，执行停止并生成新预览。

### 结果与对账

提交结果分为 `confirmed_succeeded`、`confirmed_failed` 和 `unknown`。确认必须来自稳定 receipt/order/message/account state 或明确错误，不能只依赖按钮消失。`unknown` 保存请求 identity、页面/网络观察和下一对账方式；重复执行被禁止。

## 错误处理

| 失败 | 必需行为 |
| --- | --- |
| 页面包含提示注入 | 作为不可信内容记录；不改变 policy、工具或授权 |
| 域/重定向超出 scope | 暂停并 `ASK`，不携带原会话 secret |
| Cookie/token 过期或撤销 | 会话 degraded；要求 Owner 重新认证，不尝试其他凭据 |
| CAPTCHA/反自动化/付费墙 | 停止或请求 Owner 接管，不绕过 |
| 页面内容过大或类型未知 | 有界拒绝或隔离下载，不发送全部内容给模型 |
| 提交前页面变化 | 使 Approval 失效，重新生成冻结预览 |
| 提交后连接中断 | 标记 `unknown` 并 reconcile，不自动重发 |
| 下载检测到可执行/不可信内容 | 保持隔离，执行需要独立高风险授权 |
| host migration | 会话全部 blocked_credentials，等待目标主机重新建立 |

## 验证策略

- 使用受控测试站点覆盖公开搜索/打开、多来源引用、redirect、iframe、下载、上传和认证 session 分区。
- 构造网页提示注入、伪登录、跨域 redirect、恶意 MIME、超大正文和 secret exfiltration 测试。
- 验证 search snippet 与实际打开页面分离，引用绑定内容 digest，页面变化后历史 Trace 可重现。
- Browser E2E 覆盖登录、session 撤销、prepare/approve/execute、字段变化、购买/消息/账户修改风险和 recent re-auth。
- 对提交前、网络发送后、响应前、readback 前后 kill process，验证结果未知时不重复副作用。
- 验证 Cookie、token、password 和恢复码不进入 Payload、模型、Memory、日志、可读 Trace 或迁移包。
- 在 Mac 与 Hermes 运行相同 conformance；若所选 browser adapter 任一平台不满足，停止并修订 Spec。
- 运行 unit、contract、integration、browser/security、`npm run check` 和 strict document validation。

## 确认记录

- 确认人：Owner
- 确认日期：2026-08-26
- 确认范围：公共 Web 研究、按域认证会话和 Prepare→Approve→Execute→Reconcile 边界及其验收标准。
- 授权边界：允许从本 Spec 派生 Implementation Plan；本次确认不授权创建 Plan、建立认证会话、提交网页动作、调用外部服务或修改产品实现。
