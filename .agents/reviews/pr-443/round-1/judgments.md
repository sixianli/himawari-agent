# PR 443 第 1 轮逐条判断

- ds-1（deepseek-v4.1-flash）「高：清除推送在撤销校验之前发出，撤销失败也会清空设备」：成立，中、高，已改。
- ds-2（deepseek-v4.1-flash）「中：其他“移除设备”入口没有清除推送，作者说法 6 只对管理接口成立」：成立，中、高，已改。
- ds-3（deepseek-v4.1-flash）「中：同一设备多个事件流时，关闭任意一个就把“正在看”清掉」：成立，中、高，已改。
- ds-4（deepseek-v4.1-flash）「中：一次性凭据消费的写事务是 deferred，不是 immediate」：成立，低，已改。判低的理由：条件更新保证不会用两次，生产只有一个写连接（SQLite 工作线程），失败方式是偶发 500 而不是越权；已改成 immediate
- ds-5（deepseek-v4.1-flash）「低：Live Activity “开始”发送失败后不会重试」：成立，低，已改。
- ds-6（deepseek-v4.1-flash）「低：APNs 负载只裁剪正文，长标题或按钮仍可能超过 4096 字节」：成立，低，已改。
- ds-7（deepseek-v4.1-flash）「中低：Live Activity 登记没有每设备/每账号上限，可能耗尽存储和列表内存」：成立，低，已改。判低的理由：只有已配对且签名通过的设备能登记，增长慢、不越权；已加每设备上限
- ds-8（deepseek-v4.1-flash）「以后若有人写入第三种动作，路由会静默当成 `denied`」：成立，低，已改。判低的理由：当前生产者只产生 approve 和 deny，存储层也只收这两种；已让路由拒绝未知动作
- ds-9（deepseek-v4.1-flash）「但 `ON CONFLICT` 时不更新 `channel`，同一来源先走 APNs 后回退 web push 时会保留旧通道值」：成立，可以更好。
- ds-10（deepseek-v4.1-flash）「说法 9（日志不含令牌/凭据/密钥）没有自动反向用例」：成立，可以更好。
- glm-1（glm-5.3-flash）「「清除推送」只发给登记过 alert 类型且配置匹配的设备，其余设备吊销前收不到清除推送」：不成立。依据：后台推送只能发给设备令牌（alert 登记），小组件令牌和实时活动令牌按苹果的规则收不了 background 类型；配置不匹配的令牌发了也会被苹果拒。清除推送本来就是尽力送达，已在计划文档写明：客户端收到 DEVICE_REVOKED 时必须自己清本地数据
- glm-2（glm-5.3-flash）「通道升级是单向的：一旦 source_key 有过任何 web_push 尝试行，之后才登记的 iPhone 永远收不到这条的 APNs 版本」：成立，可以更好。
- glm-3（glm-5.3-flash）「`#activityStarts` 集合只在内存里增、从不清理，服务长期运行会缓慢增长」：成立，低，已改。
- glm-4（glm-5.3-flash）「同一条审批通知每次重试都重新签发一对按钮凭据」：成立，低，已改。
- glm-5（glm-5.3-flash）「本 PR 顺手补了 8 条与苹果推送无关的 v2 能力表登记」：成立，可以更好。
- glm-6（glm-5.3-flash）「`companion_of` 外键没有 ON DELETE 规则」：不成立。依据：设备行从不物理删除，只置为 revoked（sqlite-paired-device-operations.ts 的 revokeDevice 只做 UPDATE）；模型自己也写了目前不会触发
- glm-7（glm-5.3-flash）「日志泄漏残余面」：不成立。依据：packages/platform-node/src/service-runtime.ts 的 stableErrorCode 只返回匹配 ^[A-Z][A-Z0-9_]{0,127}$ 的 code 或 message，否则返回固定的启动失败码；带网址的 http2 错误信息过不了这个正则

可以更好的四条怎么处理：ds-9 不改（没有逻辑读这一列做判断，回退后的通道以投递记录表为准）；ds-10 不加专门的日志反向用例（日志只经 stableErrorCode 输出错误码，见 glm-7 的依据）；glm-2 在设计文档里补了一句“反过来不改”；glm-5 在 PR 说明里补一句。
