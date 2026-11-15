# PR 548 第 1 轮作者说明

问题：PR 547 合并后上线出包仍被拒（PACKET_MIGRATION_TOUCHES_PRESERVED_TABLES 0083）。原因：547 的复核修改把 0083 的放行绑定到迁移文件的 SHA-256，写死的摘要 a367072d… 是文件原样字节（含结尾换行）的摘要；但 make-packet.py 的 git() 读 SQL 时做了 .strip()，rebuilds_keeping_rows 对 strip 过的文本算摘要，永远对不上，放行从不生效。现有测试用 read_text() 读文件（带换行），没覆盖到。

改动：`rebuilds_keeping_rows` 对 `sql.strip()` 算摘要（带不带结尾换行结果一致），写死的摘要换成 strip 后的 f268bbd8…；新增测试用 `packet_maker.git('show', 'HEAD:…/0083…')`（和出包时读法一致）走一遍放行，改回旧写法该测试失败、改后通过。

约束：只改出包脚本和测试；不碰 deploy.sh、迁移、产品代码、发给模型的内容（不会改变模型已经见过的请求开头）。其余背景见 PR 547 的说明（.agents/reviews/pr-547/briefs/brief-round1.md）。请特别看：strip 之后“只差结尾空白就放行”是否会放过被改写的迁移（摘要仍然绑定整个文件内容，只忽略首尾空白）。
