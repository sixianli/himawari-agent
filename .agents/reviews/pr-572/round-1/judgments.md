# PR 572 第 1 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，会出错，中高：### 1. 【高】label 在主要审批路径上恒为 null，手机页显示不出“当时答应的那句话”。production-approval-display.ts:81 把 displayTitle 固定写 null，内容在 bodyPreview；改为 displayTitle 优先、否则 bodyPreview 截 300 字符加省略号（governance-gateway-adapter.ts grantLabel）；集成测试 labels a Grant with the body preview 覆盖；触发：手机端打开任何由工具审批（bash/写文件/读文件/网页）产生的授权详情；后果：label 恒为 null，手机页显示不出当时答应的那句话，功能目标落空
- 2（deepseek-v4.1-flash）成立，会出错，中高：### 2. 【中】范围项数把同一资源算两次，真实授权会显示错误数量。grant-detail-lines.ts resourceCount 原为三者相加；改为去重集合大小；单测 counts a resource once 覆盖；触发：一次性授权：governance-gateway-adapter.ts:847-849 把 resourceRef 同时放进 exactResourceRef 和 resourceIdentities；后果：范围项数偏大（1 个资源显示 2 项），正常使用即触发
- 3（deepseek-v4.1-flash）不成立：### 3. 【中】`grant.snapshot` 新增必填字段会破坏旧严格客户端。新增必填只读字段是本仓库既有做法（#566 送达时机设置返回三语名称同样新增字段，commit d5ae1fec0）；手机端随本接口一起做，模型自己也写明手机端版本无法从仓库核实，属推测，不是现有代码的错误
- 4（deepseek-v4.1-flash）成立，会出错，低：### 4. 【低】费用行硬编码美元，忽略 capability 声明的 currency。grant-detail-lines.ts:22 硬编码 $；当前生产能力和夹具全是 USD，只有人为构造非 USD 清单才触发，且 grant 记录不带 currency；触发：capability 清单声明了非 USD 的 cost.currency（合约允许任意 16 字符）；后果：费用行以 $ 显示，货币错标
- 5（deepseek-v4.1-flash）成立，可以更好：### 5. 【低】新字段只有正向用例，label 分支和范围去重没有能失败的反向用例。缺的用例对应意见 1、2；这两条已修并补了真实形状的单测和 label 集成测试，其余（非 USD、超长拒绝）属额外加强
