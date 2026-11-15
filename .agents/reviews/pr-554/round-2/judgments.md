# PR 554 第 2 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，会出错，低：### 1. 低：已登录分支跳过 arrayBuffer 却没取消响应体，导出流仍留在后台。test/integration/product-path-browser.test.ts 的 archive() 在 200 分支确实没有消费或取消响应体；已改为 response.body?.cancel()；触发：已登录分支 archive() 对 200 响应既不读也不取消响应体；后果：导出响应在后台继续占用连接，只影响验收测试，数据集很小
