# PR 595 第 1 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，会出错，中高：### 1. 高 新增 Swift 调用方后没有移出 `ci/operations-pending.json`，`check:operations` 会报 `OPERATION_PENDING_BUT_COMPLETE`。已核对：ci/operations-pending.json 有 search.ask.read；已删除该条，npm run check:operations 通过；触发：合并后 check:operations 扫到 Swift 调用方；后果：检查失败拦住合并
- 2（deepseek-v4.1-flash）成立，会出错，中高：### 2. 高 `SearchModel.reset()` 不清 `suggestions`，退配对/换账号后旧主人的建议仍会显示且不再刷新。已核对：reset 不清 suggestions；已修为清空，load 会重新取；触发：退配对后 SearchModel.reset 只清答案；后果：换账号后旧建议仍显示
- 3（deepseek-v4.1-flash）成立，会出错，中高：### 3. 中 提问失败时旧答案继续显示，失败提示永远到不了，输入也已被清空。已核对：content 先判 answer；已修：失败时清空 answer，failed 提示可达；触发：提问失败而之前有答案；后果：失败提示不出现，旧答案当成新答案
- 4（deepseek-v4.1-flash）成立，会出错，中高：### 4. 中 长答案分支很可能永远走不到，长答会以 24pt 截成 3 行而不是 17pt 最多 6 行（推测，需 Mac 验证）。已核对：short 自带 lineLimit(3) 使 ViewThatFits 恒选第一项；已改为先量 24pt 全文高度，超过 3 行高度改 17pt 最多 6 行（待 Mac 验证）；触发：长答案；后果：以 24pt 截成 3 行而不是 17pt 6 行
- 5（deepseek-v4.1-flash）成立，会出错，低：### 5. 低 提问后服务器若返回 `state=suggestions`，客户端忽略它的 `asks`；初次加载失败也无提示，中文文案却说“下拉”。已核对：文案写下拉；已改为稍后再试。提问后 suggestions 不显示是约定行为，不改；触发：服务器在提问后回 suggestions 或首次加载失败；后果：中文文案写下拉但没有下拉；判低理由：文字不准且不误导
- 6（deepseek-v4.1-flash）成立，会出错，低：### 6. 低 `SearchBasis.id` 不含 `at`，同线程同日多条依据可能撞 `ForEach` id（推测）。已核对：id 不含 at；已加入 at；触发：同线程同时间多条依据；后果：ForEach id 撞
- 7（deepseek-v4.1-flash）成立，可以更好：### 7. 低 查询长度没有客户端上限，超过契约 500 字符只能得到通用失败。服务器已校验长度并返回失败；客户端写死 500 违反不写死，不改
- 8（deepseek-v4.1-flash）成立，可以更好：### 8. 低 作者“逻辑在 HimawariCore 里有测试”与代码不符：状态机在 HimawariShell 且没有测试。只是作者说明措辞；解码在 HimawariCore 有测试，状态机在 Mac 才能编译的 Shell 目标
