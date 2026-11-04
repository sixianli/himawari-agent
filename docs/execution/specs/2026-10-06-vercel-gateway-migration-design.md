---
status: active
document_type: spec
supersedes: ""
superseded_by: ""
date: "2026-10-06"
---

# Vercel模型迁移与实际费用结算设计

## 阅读导航

- [目标及依据](#目标及依据)
- [范围和验收](#范围和验收)
- [接口及费用流](#接口及费用流)
- [错误与恢复](#错误与恢复)
- [验证顺序](#验证顺序)

## 目标及依据

落实用户G34–G38和ADR 0048：文本仅使用`deepseek/deepseek-v4.1-flash`，移除GLM备用；嵌入使用`alibaba/qwen3-embedding-8b`、4096维。服务商顺序由配置保存，保持runware、deepinfra、morph及cost排序，不发送disallowPromptTraining。

- 决定：[SOURCE: docs/adr/0048-vercel-ai-gateway-replaces-openrouter.md]
- 架构：[SOURCE: docs/architecture-v0.1.md]
- 迁移范围：[SOURCE: docs/backlog/BL-20261004-002-模-型-网-关-迁-移-到-vercel.md]

本设计由Codex按G39/G40独立规划及自审，规定本次迁移的实现及验收边界。G44/G45在Hermes上的原响应确定：文本末帧的usage.cost与choices[0].delta.provider_metadata.gateway.cost一致；嵌入使用providerMetadata.gateway.cost，usage只提供token数。两种字段不可混用。真实请求只证明本次输入和服务商结果，不能代替产品迁移验收或生产服务器资格。

## 范围和验收

覆盖配置、Pi绑定、Agent Loop、受保护ModelPort、标题、Mem0查询和投影的同一账单结算链。复用Pi 0.84.2 ModelRuntime的请求、流式解析、工具参数解析及onPayload；按用户G46升级正式latest为Mem0 3.3.1，复用其实际安装的SDK嵌入协议。产品只增加其负责的路由、费用观察、预算和持久身份保护。

Mem0精确依赖及锁文件按G46更新；不升级Pi，不增加数据库表或迁移，不引入业务工具重放、SDK隐藏重试或费用补查。Mac测试仍延期；生产部署及生产密钥仍需逐次批准。

- 单一主文本模型能够启动；GLM及OpenRouter配置不能继续发送物理请求，旧请求身份不重写。
- 配置和发送均限制文本输出最多32768 token，单次发送还取调用选项与配置上限的较小值；输出截断不能被当成完整工具调用。
- 两条文本入口及记忆查询/投影均按返回实际费用结算，读回预算账户与物理调用身份。
- 合法零费用可以结算；缺失、非法或矛盾费用保留unknown（已经开始但结果不能确定），不当免费或估价处理。
- 中断、取消、服务重启及再次恢复不得产生第二次物理请求或重复结算。

## 接口及费用流

ModelInvocationUsage增加产品已经检查过的reportedCostMicros，以整数微美元表示实际费用。调用身份的provider为vercel-ai-gateway时必须提供该值，安全整数范围内的零合法；缺失或非法即拒绝结算。其他既有非网关适配器维持原冻结单价契约，不能把迁移扩大为无关适配器改造。

通用美元到微美元转换由application拥有，接受有界的非负有限数值或十进制字符串，精确向上取整，不把非法值转成零。网关响应结构及身份验证属于runtime-pi和memory-mem0各自的边界，通用应用层不读取Vercel JSON。

文本观察器只读Pi不暴露的末尾元数据，不另解析正文或工具协议。以实际响应模型、网关generationId及finalProvider验证来源；费用重复出现时必须一致，存在费用字段但非法不能被后来的合法字段掩盖。SDK和响应副本同时读取，结束元数据检查后才发布成功并结算。Agent Loop及ModelPort共享同一个观察规则；单次最多一个物理请求，maxRetries为零。

嵌入在既有SDK的create响应边界读取providerMetadata.gateway.cost，保持原SDK传输实现，不替换为另一套请求。SDK已解析向量后，产品检查模型、费用、维度、有限数值和数量，再交给原查询或投影预算许可。查询和投影都使用实际费用，移除投影里的重复token估价结算。

生成模型的providerRouting改为配置保存的order及sort: cost；通过Pi onPayload注入providerOptions.gateway，并保留Pi所需的推理及取消机制。默认准入价格须覆盖实际允许兜底的服务商及已知高峰价格，不能只用首选三家的最高价格覆盖无限制兜底。价格是冻结的准入估价，账单是实际结算来源，两者不混用。

选择本方案的原因：仅替换URL仍会按token估价结算且强制GLM备用；再引入Vercel SDK会复制Pi及Mem0协议。旁路读取已经被Pi丢掉的计费元数据，能复用已安装协议并保持原权限及身份事务。reportedCostMicros的缺失由冻结provider检查，避免为无关本地及专用适配器制造新费用协议。

新版Mem0默认实体库只替换主库路径的`.db`后缀。既有`vectors.sqlite`不会被替换，实际SDK更新英文人名、公司和地点时已复现实体混入主库（E20261006T191027-0b16e1）。适配器保留原主库与历史库路径，复用新版公开VectorStoreFactory创建独立`entities.sqlite`并绑定SDK已有实体存储槽，不搬迁现存产品记录。实际SDK与loopback HTTP测试覆盖主库身份、独立实体库、重启、查询、删除及历史清理。这里的固定SDK内部槽与既有embedder请求边界一起受精确版本和实际安装源码检查保护。

## 错误与恢复

沿用started/unknown/settled事务、原逻辑槽、物理调用序号及冻结模型身份，不修改历史账单或历史模型编号。请求已经开始，但费用缺失、损坏、矛盾、超出安全整数，或取消导致终态费用无法确认时保留unknown。发送前取消可以释放尚未使用的预约；已经可信结算的费用不会因后续取消而抹掉。重复恢复读取原事务结果，禁止重新发送原业务操作。

保留预算、权限租约、分类披露、秘密句柄、保护Payload及原测试时限。所有底层错误只记录不含秘密的分类，不能为了取证打印认证头。保留失败响应及重跑命令；环境错误和产品错误分别记录。

## 验证顺序

先通过既有公开产品入口及受控网关响应写中等复杂度的自动测试：至少包含工具往返或查询/投影、实际费用与估价不同、身份及预算独立读回、失败后再恢复不重发。数值精度、非法内部费用和流分块边界在聚焦测试中检查，因为真实服务不能稳定制造这些输入。每个测试预期取自上述契约，而非实施输出。

先在Hermes运行红测试，再修改产品并重跑同一测试。稳定后执行第1–2层和自审，按项目规则在最终版本执行第3层。迁移最终版本覆盖Linux安装资格及不筛选资格，补齐container-execution-backend-qualification、quality-local和artifact当前版本检查；报告实际执行的层与版本，不能以真实探测成功替代产品验收。更新架构、配置、操作脚本、测试说明与受影响Runbook，在同一提交严格验证并重新封存。

异步权威检查也会消耗时间。嵌入响应后的这次检查返回时，产品在结算前同步核对取消信号和冻结的原期限；在等待中取消或到期时保留原unknown保护，不返回成功、不释放已经开始的费用预约。定向红测试分别复现取消、到期及请求选项越过配置上限，验收使用同一组断言。

七个历史付费比较CLI已移除旧网关网络调用、旧服务数据库及秘密读取分支；命令行报`HISTORICAL_PROVIDER_PROBE_RETIRED`并指向本设计。已有纯函数保留用于冻结输入的离线回归。原实验响应及历史授权只作记录，不能把旧脚本、旧预算或旧凭据当成现网关的新调用授权。显式opt-in的generation/embedding live测试仍受单独凭据、费用及Mac延期约束；普通完整测试不会自动执行它们。

原安全清单要求的fallback描述随已批准模型合同修正为primary和embedding各一个、至多一个TypeSafe specialist。清单继续检查模型数量、密钥和路由门禁；秘密扫描、预算、权限及原测试时限不变。安装后账本检查必须按调用身份冻结的budget_account_id和budget_operation_key逐条读回，包含Run主账户和独立标题账户，不能把标题费用漏出比较。
