# PR 510 第 1 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，会出错，中高：### 1. 高：敏感记忆和对话摘要并没有被隐藏，与作者“不显示敏感”的说法相反。production-search.ts 用 reviewMemoryVisible，其底层 model-visibility.ts MODEL_VISIBLE 含 sensitive；已改为只放行 public/private，答案、对话摘要、建议同一集合；触发：owner 有一条 sensitive 记忆或对话摘要，查询命中它；后果：敏感内容作为答案原文显示，违背“不显示敏感”的约束
- 2（deepseek-v4.1-flash）成立，会出错，中高：### 2. 中：过期和被取代记忆的过滤在“答案”和“建议”两条路径上不一致。原 production-search.ts 两处判断各缺一项；已抽 currentlyShown 同时检查 supersededBy、tentative、validTo、分类，两条路径共用；触发：记忆 validTo 已过期（建议路径）或 supersededBy 非空（答案路径）；后果：过期实体出现在建议问题，被取代的旧内容可作答案
- 3（deepseek-v4.1-flash）成立，可以更好：### 3. 中：现有“隐藏敏感记忆”反向用例是假绿，测不出第 1 条问题。原用例 secret 与 allergy 同时命中且 basisLimit=1，删掉敏感过滤仍通过；已新增只有 sensitive 命中的用例，去掉修复后该用例失败（已实测）
- 4（deepseek-v4.1-flash）成立，会出错，低：### 4. 低：发送的 `answer`/`asks` 可能与网关契约的长度和控制字符规则不一致。validation.ts:91-104 按 UTF-16 长度并拒控制字符，原 clip 按码点计、singleLine 不去控制字符；已改为 UTF-16 截断并把 \p{Cc} 并入空白折叠，新增测试；触发：记忆原文含大量 emoji 或控制字符，且设备端严格校验；后果：answer 超 UTF-16 2000 或含控制字符，设备端解码可能拒绝；判低理由：只有特殊原文触发，且是客户端拒收，不丢数据不泄露
- 5（deepseek-v4.1-flash）成立，会出错，低：### 5. 低：`askLimit = 0` 时仍全量扫描所有活动记忆和实体。production-search.ts #suggestions 原先无条件 listActive；已在 askLimit===0 时直接返回并加测试断言 listActive 未被调用；触发：askLimit 为默认 0 时收到空查询；后果：白白遍历全部活动记忆，只多耗 CPU，结果正确；判低理由：只影响性能，输出不错
