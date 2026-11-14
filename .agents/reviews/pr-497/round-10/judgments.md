# PR 497 第 10 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，会出错，中高：### 1、中：临时例外说“合并不等 PR CI”，但合并队列的入口和候选推进仍强制要求 `ci/required` 成功。只改文档：例外里写明例外期间不加 merge-queue 标签、线程直接合并；按 Andy 和协调者要求本轮不改，报给 Andy；触发：例外期间线程按 owner-standing-rules 给 PR 加 merge-queue 标签；后果：队列仍等 ci/required，和“合并不等 CI”的例外矛盾，PR 卡在队列里
- 2（deepseek-v4.1-flash）成立，会出错，低：### 2、低：文档说合并后由 `Main confirmation` 跑全量测试，但队列用 `GITHUB_TOKEN` 合并不会触发 `main.yml`。和第 1 条一起改：例外期间直接合并（用户令牌），会触发 Main confirmation；触发：例外期间走合并队列合并；后果：队列用 GITHUB_TOKEN 合入的提交不触发 main.yml
- 3（deepseek-v4.1-flash）成立，会出错，低：### 3、低：`model-review.md` 仍按旧规则描述引文，未同步“同一个被引文件”和“最多 8 个位置”。文档同步一句；本轮不改；触发：读 model-review.md 的人；后果：以为跨文件拼引文能过
- 4（deepseek-v4.1-flash）成立，会出错，低：### 4、低：`REVIEW_CURRENT` 只表示复核记录链完整，不表示“没有中、高意见”。措辞改成两个独立条件；本轮不改；触发：线程把 REVIEW_CURRENT 当成没有中高；后果：带着中高意见合并
- 5（deepseek-v4.1-flash）成立，会出错，低：### 5、低：位置数上限在完整拆分 `location` 之后才检查，不能限制解析阶段的分配。答案文件由模型输出长度限制，影响很小；本轮不改；触发：一条超长的 location 字段；后果：拆分时多占一点 CPU 和内存
