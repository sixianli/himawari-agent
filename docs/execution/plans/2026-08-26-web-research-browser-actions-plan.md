---
status: active
document_type: plan
supersedes: ""
superseded_by: ""
date: "2026-08-26"
---

# Himawari Agent v0.2 Web 研究与受控认证操作 Implementation Plan

**来源 Spec：** [SOURCE: docs/execution/specs/2026-08-26-web-research-browser-actions-design.md]

**v0.2 Spec 套件：** [SOURCE: docs/execution/specs/2026-08-26-v0.2-spec-suite-integration-design.md]

**协同 Source Specs：**

- [SOURCE: docs/execution/specs/2026-08-26-portable-durable-web-agent-design.md]
- [SOURCE: docs/archive/specs/2026-08-26-authorization-capability-governance-design.md]
- [SOURCE: docs/execution/specs/2026-08-26-control-center-experience-design.md]

**依赖 Plans：**

- [SOURCE: docs/execution/plans/2026-08-26-portable-durable-web-agent-plan.md]
- [SOURCE: docs/archive/plans/2026-08-26-authorization-capability-governance-plan.md]
- [SOURCE: docs/execution/plans/2026-08-26-control-center-experience-plan.md]

**目标：** 实现可追溯的公共 Web 搜索/打开/多来源研究，以及按域、host-bound、可撤销的认证浏览器会话和 Prepare→Approve→Execute→Reconcile 外部行动。

**架构：** product-owned Web contracts 与 application services 定义 WebResourceRef、WebSession、prepared action 和结果状态；平台 adapter 在受限 Worker 中执行搜索、导航、提取和浏览器操作；认证材料只在 host secret/session store，通过短期 Handle 使用。所有来源、披露、授权、执行和对账进入统一 Trace/Result。

---

## 执行依赖与停止点

- S1 必须提供 protected Payload、host secret、Worker、HTTP/SSE、Trace/Result、authority fence 和迁移 hook；S4 必须提供 capability/ActionIntent/Grant/Handle。
- 具体搜索、HTTP、DOM 提取和浏览器自动化技术未由 Spec 决定。引入直接依赖前完成 Mac/Hermes version-matched qualification、许可证/安全/资源审计和 Owner 授权。
- 第一次建立真实认证 session、登录第三方站点、上传数据、提交表单、发送消息、购买或修改账户前，逐次展示目标、披露、费用、收件人、副作用和回退/对账边界并取得授权。
- 禁止绕过 CAPTCHA、付费墙、登录、访问控制、站点限制或反自动化；遇到这些情况停止或请求 Owner 接管。
- 任一平台 adapter 无法提供 session 隔离、secret exclusion、冻结预览或 unknown-result reconciliation 时阻止正式能力收口。

## 文件边界

### 新建

- packages/integration-web/
- packages/integration-web/src/contracts/
- packages/integration-web/src/public/
- packages/integration-web/src/session/
- packages/integration-web/src/actions/
- packages/integration-web/test/
- packages/testing/src/conformance/web-capability-suite.ts
- test/fixtures/web-sites/
- test/integration/web-research.test.ts
- test/integration/web-action-reconciliation.test.ts
- test/integration/security/web-content-boundary.test.ts
- test/e2e/browser/web-capability/

若 qualification 证明更合理的 adapter 包拆分，先保持 product-owned Port 不变并记录实现边界；不能让第三方 SDK 类型进入 application/domain/contracts。

### 修改

- packages/application/src/ports/ 与 services/：Web resource/session/action ports 和 orchestration。
- packages/gateway-contracts/src/、packages/execution-contracts/src/：严格命令、结果、Handle 和 fixtures。
- packages/persistence-sqlite/：resource/session metadata、prepared action、operation/reconcile 与 deletion hooks。
- packages/platform-node/：host-bound encrypted browser session store、temporary download area 和 process isolation。
- packages/testing/、apps/agent-service、apps/execution-worker、apps/control-center：conformance、composition 和 UI。
- scripts/check-boundaries.mjs、manifests、lockfile：只加入获批精确依赖和新 workspace。
- Architecture/README：实测后更新。

### 依赖方向

- integration-web → application + domain + gateway/execution contracts。
- apps/execution-worker → application + execution-contracts + integration-web + approved platform adapters。
- apps/agent-service/control-center 只通过产品 contracts 和 application/read model 使用 Web 能力。
- integration-web 不依赖 runtime-pi；第三方 browser/search SDK 类型不得进入 domain、application ports 或稳定 wire contracts。

### 测试

- packages/integration-web/test/
- packages/application/test/
- packages/gateway-contracts/test/
- packages/execution-contracts/test/
- packages/persistence-sqlite/test/
- packages/platform-node/test/
- packages/testing/test/
- apps/execution-worker/test/
- apps/control-center/test/
- test/integration/
- test/integration/security/
- test/e2e/browser/

## 实施任务

### Task 1：建立 S5 acceptance 映射与安全基线

- [ ] 将 S5-A01 公共研究、S5-A02 认证会话、S5-A03 外部副作用绑定 tasks/evidence。
- [ ] 盘点 S1/S4 的 Payload、secret、capability、Worker、Trace、Result、deletion 和 migration contracts。
- [ ] 建立提示注入、跨域、下载、上传、unknown side effect 和 secret exfiltration threat matrix。
- [ ] 运行现有 check/tests/strict validation 并保存 baseline。

### Task 2：完成 Web adapter qualification

- [ ] 从官方 release/docs/registry 评估搜索、HTTP、HTML/DOM、浏览器自动化和加密 session store 候选。
- [ ] 核验精确版本、Node.js engine、许可证、维护/安全、Mac/Hermes browser/runtime availability、headless/headful、sandbox、download/upload 和 network controls。
- [ ] 在受控测试站点验证 redirect、iframe、popup、session partition、Cookie 生命周期、MIME sniffing、进程终止和资源限制。
- [ ] 记录 candidate/blocked 结论与 manifest/lockfile diff；Owner 批准后才安装。
- [ ] 任一硬语义无法满足时停止并修订 Spec，不以 Mac-only 或手工浏览替代双平台。

### Task 3：冻结 Web contracts 与稳定身份

- [ ] 定义 WebResourceRef、WebSession、PreparedWebAction、WebOperation 和 confirmed_succeeded/confirmed_failed/unknown。
- [ ] WebResourceRef 保存 requested/canonical URL、redirect chain、origin、time、status/type、digest、classification、session ref 和 protected body ref。
- [ ] WebSession 保存 allowed origins、purpose、identity label、secret refs、partition、expiry/revoke/health，不保存 Cookie/token 原值。
- [ ] prepared action 保存 final URL/origin、method、fields/uploads/recipients、price/account、side effect、reversibility、success marker 和 canonical hash。
- [ ] 增加 unknown fields/version、cross-scope、stale fence、expired Handle 和 duplicate operation fixtures。

### Task 4：实现公共搜索、打开与来源快照

- [ ] 分离 web.search_public、web.open_public 和 web.research operations 与 manifests。
- [ ] 只有公开、只读、有界、无登录/新披露/费用且匹配有效 Grant 的读取可自动执行。
- [ ] 搜索摘要与实际打开页面分开标记；结论只能引用实际取得的 resource digest/片段。
- [ ] 保存 URL、title、retrieved_at、引用关系和派生摘要 Trace；页面变化后历史仍可重现原 snapshot。
- [ ] robots、条款、rate limit 和访问错误有界处理，不伪造身份或无限重试。

### Task 5：实现不可信内容提取与最小披露

- [ ] 把 DOM、文本、脚本、附件和搜索结果标记为 untrusted data，不能进入 system policy。
- [ ] 去除执行性元素和 machine secret，再按任务选择最小片段与 classification。
- [ ] 页面要求运行命令、上传密钥、忽略授权或安装能力只进入 Trace，不形成调用。
- [ ] 记录候选/采用/排除片段、披露范围和模型 identity/cost。
- [ ] 构造提示注入、伪登录、secret pattern、超大正文、未知 content type 和编码攻击。

### Task 6：实现下载与上传边界

- [ ] 下载进入隔离 temporary area，记录 source URL、digest、MIME sniffing、size、classification 和 expiry。
- [ ] 可执行或未知内容保持隔离；写入 Owner 目录或执行必须经过 S6/S4 独立授权。
- [ ] 上传只引用 Owner 已授权文件，冻结目标 origin、字段、分类、大小和披露。
- [ ] redirect/cross-origin 后不得携带未授权 secret 或 upload Handle。
- [ ] deletion/migration 清理 temporary/cache/session 副本，不延长 Owner 数据保留。

### Task 7：实现 host-bound 认证 Session

- [ ] 在平台 secret/session store 加密保存 Cookie/token/browser keys，通过一次性 Handle 给 Worker。
- [ ] 建立 domain/origin 精确 partition；子域、redirect、SSO popup 和 iframe 各自验证 scope。
- [ ] 支持建立、查看、暂停、撤销、expiry/health 与 recent use，不在 Trace/UI 显示 secret。
- [ ] session revoke/credential expiry 立即 blocked，不尝试其他身份或凭据。
- [ ] authority transfer 后全部 session 为 blocked_credentials，目标主机重新建立前不可用。

### Task 8：实现只读 session 与 prepare_action

- [ ] web.session_read 只在 allowed origins、purpose、classification 和 Grant 内导航/读取。
- [ ] prepare_action 可以填充但不提交，冻结最终页面状态、fields、uploads、recipients、price/account 和 side-effect facts。
- [ ] secret field 只显示类型/ref；页面按钮/脚本不能把 prepare 变 execute。
- [ ] 跨域、价格/字段/收件人变化、身份/权限变化使 prepared snapshot 失效。
- [ ] 对多标签/页面刷新/重启验证 snapshot identity 和不产生副作用。

### Task 9：接通 Approval 与单次 execute Handle

- [ ] 由 S4 将 prepared hash 转为 ActionIntent，按 COMMUNICATE、PURCHASE、CREDENTIAL、PUBLICATION、LEGAL 等 facts 提高风险。
- [ ] 登录状态不降低风险；资金、权限、公开发布和法律承诺保持 CRITICAL/recent re-auth。
- [ ] 批准只签发一次匹配 operation/origin/payload/expiry 的 execution Handle。
- [ ] 发送前再次读取页面和 session version；任何差异停止并生成新预览。
- [ ] 执行请求记录稳定 operation identity，不在重试层重复提交。

### Task 10：实现 bounded readback 与 reconcile

- [ ] confirmed_succeeded 必须由稳定 receipt/order/message/account state 或等价 readback 证明。
- [ ] 明确错误形成 confirmed_failed；按钮消失或单一 HTTP response 不足以确认。
- [ ] 网络发送后中断标记 unknown，保存 observation 与下一对账方法，禁止自动重发。
- [ ] web.reconcile 按 operation/idempotency identity 有界查询并提交最终 Result。
- [ ] 在发送前、发送后、响应前、readback 前后 kill process，证明不重复副作用。

### Task 11：接通控制中心

- [ ] 公共研究显示来源、获取时间、引用和披露；未打开搜索摘要有明确标记。
- [ ] Session 页面显示域、用途、身份 label、secret status、范围、expiry/revoke/health。
- [ ] 外部 action UI 展示 prepare snapshot、risk、费用、收件人、可逆性、Approval、execute 和 readback/unknown 状态。
- [ ] CAPTCHA、Owner 接管、跨域 ASK 和 session degraded 有清晰下一步。
- [ ] 多浏览器、断线和 recent re-auth 不制造 optimistic success。

### Task 12：完成双平台 conformance、安全和恢复

- [ ] 在 Mac/Hermes 对公共研究、session partition、redirect/iframe/download/upload、prepare/execute/reconcile 跑相同 suite。
- [ ] 运行 secret scan，证明 password/Cookie/token/recovery code 不进入 Payload、模型、Memory、日志、Trace、migration package 或 browser response。
- [ ] 注入 browser/Worker crash、rate limit、session revoke、authority change、storage loss 和 deletion。
- [ ] 映射 S5-A01–S5-A03 到 fresh platform/browser/security/recovery evidence。
- [ ] 与 S0 J05/J14、Architecture、README 对账后收口。

## 验收映射

| Acceptance ID | Spec 验收组 | 主要任务 | 必需证据 | 当前状态 |
| --- | --- | --- | --- | --- |
| S5-A01 | 公共研究 | Tasks 3–5、11–12 | 来源/digest、prompt injection、双平台 research | 待实施 |
| S5-A02 | 认证会话 | Tasks 6–8、11–12 | host secret、partition/revoke/migration、browser | 待实施 |
| S5-A03 | 外部副作用 | Tasks 8–12 | prepare/hash/approval、kill/reconcile、readback | 待实施 |

## 验证

- npm run check
- npm run test:unit
- npm run test:contracts
- npm run test:integration
- npm run test:e2e
- 本 Plan 新增的 web adapter、browser、security 和 recovery 入口
- python3 /Users/triggerjames/.codex/skills/document-governance/scripts/validate_docs.py --strict .
- git diff --check

受控测试站点用于确定性验证；真实认证站点、账户、消息、购买、上传和账户修改必须逐次授权并单独 readback，不能作为普通测试自动运行。

## 收口清单

- [ ] S5-A01–S5-A03 全部有 fresh 双平台 evidence。
- [ ] 公共研究的每个结论可追溯到实际打开的 resource digest/引用。
- [ ] 认证材料仅存在 host secret/session store，迁移后保持 blocked。
- [ ] 每个副作用都经过冻结预览、授权、单次 Handle 和 bounded readback/reconcile。
- [ ] S0 journey、S4 conformance、Architecture 和 README 已对账。
- [ ] strict document validation、全仓检查与相关测试通过。
- [ ] 本 Plan 与来源 Spec 只在工作真正关闭后归档。
