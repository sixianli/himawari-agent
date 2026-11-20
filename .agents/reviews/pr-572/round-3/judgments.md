# PR 572 第 3 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，会出错，低：### 1. 【低】费用明细仍写死美元，没有使用 capability 声明的 currency（上一轮第 2 条仍未修）。沿用第 1、2 轮原判：grant-detail-lines.ts 硬编码 $，当前生产能力和夹具全是 USD，grant 记录不带 currency，只有人为构造非 USD 清单才触发；代码未改，无新证据；触发：capability 清单声明了非 USD 的 cost.currency；后果：费用行以 $ 显示，货币错标
- 2（deepseek-v4.1-flash）成立，可以更好：### 2. 【低】detail 已删除到期日，但测试名和作者说明仍写着“到期”。只是测试标题 grant-detail-lines.unit.test.ts:19 仍写 expiry，断言已无到期行，不误导；作者说明属 PR 描述，非代码或仓库文档
- 3（deepseek-v4.1-flash）成立，可以更好：### 3. 【低】label 在 displayTitle 为 null 时会回退到审批正文，和“没有就是 null”的说法不一致。沿用第 2 轮第 4 条原判：说明过期，代码回退是第 1 轮修复有意为之，代码未改，无新证据
- 4（deepseek-v4.1-flash）成立，可以更好：### 4. 【低】浏览器夹具的 detail 文本与真实生成器不一致，且没有自动校验。夹具文本与生成器标点不同，但两者都能过 grantSnapshotSchema，没有输入会因此出错；防漂移测试属加固
