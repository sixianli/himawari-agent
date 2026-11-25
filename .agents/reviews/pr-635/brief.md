# PR 635 复核材料：内部消息不推送

## 问题
PR 631 给 thread_messages 加了 internal 字段（0/1，默认 0；代码里 internal?: true），主对话和子线程之间的往来、收件箱事件、相关工具步骤都标成内部。这些消息不能推到主人手机上。

## 改动
- ProductionWebPush 的 readMessage 返回值多一个 internal?: true；“她的话”推送读到内部消息就作废（和消息已删一样）。
- service-main.ts 把仓库读到的 internal 传给推送。
- listFinishedRuns 挑一次运行“她的回话”时加 reply.internal = 0，内部消息不会被当成回话推出去。

## 作者的说法（请核对）
1. readCommittedMessagesByIds 读回的消息带 internal（sqlite-thread-operations.ts 的 messageFromRow）。
2. 一次主人消息叫起的运行如果只有内部 agent 消息，replyMessageId 为空，走原来的运行完成推送（“已完成”），不会推内部内容。

列出的说法只是参考，请从问题本身出发找问题，不要局限于这几条。

## 每次都要问的问题
1. 这个改动会不会改变模型已经见过的请求开头？（不改提示词和工具。）
2. 同一段文字会不会在不同请求里变成不同字节？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（internal、replyMessageId），每个使用它的地方都能接受吗？
