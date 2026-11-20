你是独立的代码复核者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
系统的真相在代码里。下面「作者的说法」可能有错，每一条都要对照代码核对；发现说法和代码不一致，要明确指出。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
你的额外侧重：错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销的操作，以及规则文件、说明文档和代码是否一致。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你查过的这类路径和结论。
输出格式：按严重度从高到低排列，每条写：严重度、文件:行、问题、证据（引用你亲自读到的那几行代码）、建议。把「读代码证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 8aeba5f58c3f5d6bf900e7f4c4cdb63b4afd5229。
对比基准是 79534150cc6266417ebfec070377af08b6267f54，先运行 git diff 79534150cc6266417ebfec070377af08b6267f54..8aeba5f58c3f5d6bf900e7f4c4cdb63b4afd5229 看改动。
作者的说法（可能有错，请核对）：
# PR 443 作者说明：苹果推送服务器部分

## 问题

iPhone、Apple Watch、Mac 客户端要收到 Himawari 的提醒，并能在通知上直接点“同意”或“不同意”。服务器此前只有网页推送（Web Push），没有苹果推送（APNs，Apple Push Notification service）。

## 目标

1. 服务器能发三种苹果推送：提醒（alert）、小组件刷新（widgets）、实时活动（liveactivity）。
2. 通知上的按钮带一次性凭据：只能用一次、绑定设备、绑定审批的编号、版本和内容摘要；凭据只存 sha256 摘要。
3. 有分量的同意（主人在场才能点的那类）必须带设备的确认钥匙签名，否则拒绝。
4. Apple Watch 归属于某台 iPhone（`paired_devices.companion_of`），手表可以用 iPhone 收到的凭据。
5. 设备正在前台看着事件流时不再推送（“正在看就不推”）。
6. 设备被移除时，推送登记作废、凭据删除，并先给它发一条清除推送。

## 约束

- 苹果开发者账号还没开通，所有代码只对本机的 HTTP/2 假 APNs 服务测试过，没有对真 APNs 发过。
- 迁移号 0095 是占位，合并前按排队顺序改号。
- 不写死：主题（topic）、环境、密钥都来自配置和密钥库；`applePush` 配置要求同时有 `webPush`。
- 复用网页推送的发件表 `web_push_outbox`（新增 `channel` 列）、尝试表和反馈表，不另起一套。
- 不改发给模型的内容：这个 PR 不碰系统提示、工具定义、历史。
- 代码里不写注释（项目规则）。
- 送达时机的判断和决策记录不在这个 PR 里，留给后面的 PR。

## 作者的说法（请逐条对着代码核）

1. `packages/persistence-sqlite/src/migrations/0095_apple_push.sql` 重建 `web_push_attempts` 和 `web_push_feedback` 时不丢已有的行。
2. `consumeActionToken` 是原子的：同一凭据并发用两次，只有一次成功。
3. 凭据过期、设备不符、审批已变（版本或内容摘要不同）时一律返回 410，不泄露是哪一种。
4. `POST /api/device/v1/approvals/respond` 只有在凭据的 `ownerPresence` 为真且动作是同意时才要求确认钥匙；“不同意”不要求。
5. `dispatchDeviceGatewayRequest` 的 `notificationAction` 选项只能由 `approvals/respond` 这条路由设置，其他入口拿不到。
6. `apple-push-sender.ts` 的令牌 50 分钟换一次；收到 `ExpiredProviderToken` 时令牌满 20 分钟才重签；410 `Unregistered` 让登记作废；负载超过 4096 字节不发。
7. 手表归属：只有 iPhone 能认领手表；手表已归属别的 iPhone 时返回 409。
8. 数据导出不包含 `apns_registrations` 和 `notification_action_tokens`，并在“没导出什么”清单里写明。
9. 日志和错误信息里不出现推送令牌、凭据原文或签名密钥。

## 实际跑过的检查

- `test/integration/push-channels.test.ts`（9）、`notification-actions.test.ts`（13）、`apple-push-sender.test.ts`（7）、`packages/persistence-sqlite/test/apple-push-migration.contract.test.ts`（1）及相关配置、导出测试通过。
- `npm run check`（51 步）和 `npm run build` 通过。
