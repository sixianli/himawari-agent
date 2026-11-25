# PR 628 复核材料

## 问题
PR 617 合并时留下的低严重度问题：网页推送读推送内容（例如“她的话”的消息原文）出错时，把这条推送对这个订阅记成永久失败，以后不再推；iPhone 推送同样的错误会抛出整个 deliver，这一批后面的推送全部停下；结算接口 settled 一条读不出整批 500。

## 目标和约束
- 读内容出错时按本文件发送失败已有的重试节奏（RETRY_DELAYS_MS：1、5、15 分钟）重试，三次后记 failed；不挡后面的推送。
- 结算接口一条读不出只跳过这一条（不算已结算）。
- rule_set 工具说明加一句：写了 run_result 的安静时段同时管 her_words；对应更新 prompt-manifest 的 sha256、两组工具定义摘要测试。
- 规格第 347 行附近关于旧规则类别的那句改准。

## 作者的说法（请核对）
1. 网页和 iPhone 两条路径的 #retryLater 与原来发送失败的分支行为完全一致（rate_limited 仍用原来的延迟，其他 retry 用 RETRY_DELAYS_MS）。
2. 新测试在去掉修复时失败。
3. 内容读出错时 attempts 从 entry.attempt 累加，listDue 会在 nextAttemptAt 到点后重新取出。

列出的说法只是参考，请从问题本身出发找问题，不要局限于这几条。

## 每次都要问的问题
1. 这个改动会不会改变模型已经见过的请求开头？（改了 rule_set 工具的说明文字；参数结构不变；按 .agents/instructions/prompt-prefix.md，说明文字变了会怎样请核对。）
2. 同一段文字会不会在不同请求里变成不同字节？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（pending 状态、attempts、lastCode PUSH_CONTENT_UNREADABLE / WEB_PUSH_CONTENT_UNREADABLE），每个使用它的地方都能接受吗？
