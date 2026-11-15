# PR 572 第 2 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，会出错，中高：### 1. 【中高】浏览器 e2e 的 grant 快照缺少新增必填字段，授权详情页会被契约校验拒绝。test/e2e/fixtures/control-center-browser-server.mjs 原 grant-active 无这两个键（contracts-v2.ts:3362-3363 必填）；已补 label 和三语 detail，提交 911c79fce，node --check 通过；触发：浏览器验收或控制中心连到该夹具后打开授权详情页（/authorizations/grant-active）；后果：夹具的 grant-active 缺 label 和 detail，响应被契约校验以 missing required field 拒绝，详情页显示错误，浏览器验收的撤销流程卡住
- 2（deepseek-v4.1-flash）成立，会出错，低：### 2. 【低】费用明细硬编码美元，没有使用 capability 声明的 currency（上一轮第 4 条未修）。沿用第 1 轮第 4 条原判：grant-detail-lines.ts:22 硬编码 $，当前生产能力和夹具全是 USD，grant 记录不带 currency，只有人为构造非 USD 清单才触发；代码未改，无新证据；触发：capability 清单声明了非 USD 的 cost.currency；后果：费用行以 $ 显示，货币错标
- 3（deepseek-v4.1-flash）成立，可以更好：### 3. 【低】读取来源审批卡时没有校验归属，跨 scope 的审批显示可能被带入 Grant 快照。模型自己写明没有找到可达路径：Grant 的 sourceApprovalRequestId 都由本 Owner 的审批生成，没有外部输入能制造跨 Owner 引用；属加固，不是现有错误
- 4（deepseek-v4.1-flash）成立，可以更好：### 4. 【低】作者说法与代码不一致：displayTitle 为空时不是 null，而是二次遮盖/截断后的正文。不符的是作者说明，不是代码或仓库文档；代码 grantLabel 的回退是第 1 轮修复有意为之，默认正文上限同为 300，二次截断只在调大上限时才有差别
