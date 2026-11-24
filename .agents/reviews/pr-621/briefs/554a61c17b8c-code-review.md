# PR 621 收件箱地基：材料

## 问题和目标
ADR 0285（docs/adr/0285-one-main-thread-subthreads-and-one-inbox.md）和设计 docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md 的第 1 步拆成 4 个 PR，这是第 1 个。Andy 定的：
- 原“想一想收件箱”改成统一收件箱，不设排队上限、每天上限、过期；来多少收多少。
- 一次运行最多处理 20 件（可在 App 改），同一对话、同一类来源（主人的话和外部内容不混）一批。
- 写入后立刻叫醒处理循环，不靠定时轮询。
- 删掉“值不值得想”的 Jev 判断（ADR 0274）和想一想对话保留清理（ADR 0277）以及没人用的 6 个服务。
- 生产里这一步还没有处理方（delivery），循环不启动；主对话 PR 接上。

## 约束
- 迁移不改旧迁移文件；旧 think_inbox 行要搬过来（状态映射见迁移文件），think_settings 改名 inbox_settings 并删掉已去掉的设置键。
- gateway 命令名 think.settings.read/change 不变（iPhone 按名调用）。
- 不写代码注释；理解用户意思不用词表。

## 作者的说法（请核对）
1. claimBatch 挑优先级最高、最早到、所在对话没有处理中行的那条，再取同对话、同 from_owner 的最多 N 条；同毫秒到达按 rowid 排序。
2. 处理中途抛错按重试算，到 maxAttempts 记失败；服务关闭（signal aborted）时放回不记尝试。
3. 写入成功（不是重复）和恢复卡住条目后才通知 onQueued。
4. 迁移把 thinking 放回排队，proposed→done/proposed，skipped/expired→done/silent。
5. 删掉的服务和测试没有任何剩余引用；typecheck、lint 通过。
