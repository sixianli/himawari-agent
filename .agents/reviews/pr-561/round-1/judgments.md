# PR 561 第 1 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，可以更好：### 1. 中：新增的 kind/storageUnit 在当前仓库没有生产端，契约还禁止未知字段，生产路径只会走降级。降级到服务器原数值是作者有意的设计（材料：不依赖服务器 PR 574 先上线），TuningFormat.swift:38 default 走 plain；契约和服务端字段由 PR 574 改，不在本 PR 范围；客户端解码未知值也有测试（testWithoutAKindTheValueIsShownAsTheServerGaveIt）。契约用例建议留给 PR 574。
- 2（deepseek-v4.1-flash）成立，会出错，中高：### 2. 中：毫秒档的步进粒度和显示单位不一致，201–999 ms 等合法值无法通过步进到达。TuningFormat.swift:64 原来 1 秒以下也取 1 秒档，ms 的步长恒为 1000；已加 1 秒以下取 0.1 秒档（ms 为 100），测试补 250→300、300→200、1000→900、900→1000；触发：毫秒档的值在 1 秒以下（如 250）或用户在 1 秒附近按步进；后果：显示“250 毫秒”，但步进一按跳到 1000 或 200，201 到 999 毫秒的值到不了，也退不回原值
- 3（deepseek-v4.1-flash）成立，会出错，中高：### 3. 中：`declined()` 把网络错误当成用户取消，保存失败会被静默吞掉；真正的取消反而可能显示“没能保存”。TuningPages.swift:126 declined 对 URLError 返回 true；已把 URLError 排除出“取消”。Face ID 取消的具体错误类型未变，仍走静默分支；触发：保存时网络不通（URLError 原样上抛，DeviceAPIClient.swift:151 的 exchange.send 不包装）；后果：declined 把它当成用户取消，界面既不报“没能保存”也不重载，用户以为没改成
- 4（deepseek-v4.1-flash）成立，可以更好：### 4. 低：stepUp/stepDown 只夹一侧边界，未对不可信的快照值做上下界校正。只有服务端快照值越界（服务端 production-think-settings.ts 与 delivery-timing 都校验范围，正常读出不会越界）才触发，后果只是步进按了无效或保存被服务端拒；不是当前正常路径，不改。
