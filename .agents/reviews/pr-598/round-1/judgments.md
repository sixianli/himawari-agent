# PR 598 第 1 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，可以更好：### 1. 高：位置旁的删除入口依赖的 `perception.records.delete` 不在能力表，也不在服务端命令表，真机上不会出现。位置删除入口按简报约定只在能力表含 perception.records.delete 时显示（SenseDetailView.swift placesRow 的 model.canDelete）；该 id 自 PR 474 起客户端单方使用，本 PR 未改。生产上只是不显示入口，不产生错误结果或丢数据；镜像的删服务器副本走 /mirror 不受影响。把该命令补进能力表和服务端是另一件要 Andy 定的事；演示服务写死该能力，截图会多出这个入口，建议单独跟进。
- 2（deepseek-v4.1-flash）成立，可以更好：### 2. 中：新增测试不在 Linux 测试目标里，且“开关已关但服务器计数为 0”没有会失败的反向用例。Mac 才能编译 HimawariSensesTests 是项目既定限制（test-and-production-hosts.md），不是代码错误；去掉 mirrorCounts>0 条件测试确实仍过，是覆盖缺口不是行为错误。已在 SensesReconcileTests.swift 新增 anEmptyServerCopyOrANonMirrorItemOffersNoRemoval，覆盖镜像项已关且计数为0、非镜像项。
- 3（deepseek-v4.1-flash）不成立：### 3. 低：`serverCopyRemovable` 用持久化的 `on` 判断，而不是界面开关实际显示的 `collecting`，两者在授权被拒等状态下可能分叉。SenseItemScreen 在授权被拒时显示 SenseDeniedView，进不到详情页；开关记录为开（用户意图仍是收集）时隐藏删服务器副本入口也不会让人做错事，没有可达的错误输入。
