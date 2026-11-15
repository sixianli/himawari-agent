# PR 552 第 1 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，会出错，低：### 1. 中：读接口没有用“生效规则”过滤已存的 overrides，快照可能把已被忽略的旧值当成当前生效值。production-delivery-timing-control.ts:52-62 的读接口直接用 settings.overrides[key]，与 delivery-timing.ts applyDeliveryTimingOverrides 的范围过滤不一致；正常写入路径有范围校验，所以只有怪输入才触发且只显示不准、不丢数据；触发：库里已存的值超出现行范围（范围收紧后的旧数据、绕过 control 直写持久层）；后果：读接口把被服务忽略的旧值显示为现在生效的值且 overridden 为真；判低理由：正常 change 路径已校验范围，只有范围收紧后的旧数据或手改库才触发，后果只是显示不准，不丢数据也不误发
- 2（deepseek-v4.1-flash）成立，会出错，低：### 2. 低：设置改变不会清 `DeliveryTimingJudge` 的已判定缓存，“改后马上生效”对判忙门槛、超时、每分钟次数并不完全成立。delivery-timing.ts:241-254 判定缓存键不含配置；apply 不清缓存。最多延迟一个复查间隔，且只是判断沿用，没有错发或丢失；触发：改判忙门槛、超时或每分钟次数后，对同一组事实在复查间隔内再判定；后果：沿用旧判定，说明“改后马上生效”不准确
- 3（deepseek-v4.1-flash）成立，会出错，低：### 3. 低：代码创建 holder/安装操作的条件比 ADR 和作者说法更窄——还需要 webPush 配置、webPush secret 和 episodeProtector。service-main.ts:2774 holder 创建在 webPush 条件块内，ADR 0273 该条与代码不符；代码行为合理（送达时机只服务网页推送），改文档；触发：只配置了 deliveryTiming 而没有网页推送配置、密钥或 episode 保护；后果：两个操作不装进网关，ADR 写的条件不全
- 4（deepseek-v4.1-flash）成立，可以更好：### 4. 低：作者说“不涉及发给模型的内容”不准确——新鲜度窗口会改变送达时机判断请求里的 facts。作者说法只在材料文件里，ADR 和代码都没有“不涉及发给模型的内容”这句；改动没有动固定指令、没有新增模型调用，新鲜度窗口只改变原有判断请求末尾可变部分的事实集合，不改变陈述真假或行为，只需收窄材料措辞
