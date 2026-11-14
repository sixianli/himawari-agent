# PR 426 第 2 轮逐条判断

- ds-1（deepseek-v4.1-flash）「“执行后审计写入失败不改变返回结果”这条新行为没有自动测试」：成立，低（只是缺测试，现有行为正确），已改：新增 packages/platform-node/test/device-gateway.unit.test.ts，覆盖完成审计写失败仍返回结果、执行失败且记失败也失败时抛执行的错误、受理写失败时不执行；去掉 .catch 后用例失败已手动验证。
- ds-2（deepseek-v4.1-flash）「`setEnabled` 写观测事件没有被直接测试」：成立，低，已改：暂停测试连发两次 proactive.pause，断言只新增一条 proactive_disabled。
- ds-3（deepseek-v4.1-flash）「`accepted` 审计用随机 UUID 和当前时间，重试会重复记“受理”」：部分成立，低，已改：同一次请求的几条审计共用一个随机值，id 为 `audit:device-gateway:<随机值>:<结果>`，同一毫秒内按 id 排序受理也在完成和失败之前。重试多记一条受理是有意的：审计记的是每一次请求。
- ds-4（deepseek-v4.1-flash）「生成的 Swift 引用字段目前没有客户端消费者」：不成立。依据：消费者在第 11 批手机端（叠在本 PR 后另开 PR）：ManageGateway.withPlaceholders 只替换正文里已有的这两个键，ManageGatewayTests 有占位值用例；服务端已有 delete_permanently 带 device 占位值的集成测试。
