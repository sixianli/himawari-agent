# PR 314：周报加 Muse 差距线和案例清单（任务块 PA-4）

## 目标
每周周报新增：
- 两条 Muse 差距线：命中率差距、多余提醒率差距。只在 Himawari 与 Muse 配对的邮件上计算，带样本数和置信区间；样本不足时只列案例，不写"追平/落后"。
- "Muse 做对而 Himawari 没做到"的案例清单，每条一个归因标签（没记住 / 没取到 / 判断错 / 没读全），有"加入 Backlog"按钮，点一次标记、再点取消；只写 Himawari 自己的数据。
- 只读导出接口 `/api/gap-cases/v1/export`：沿用 Muse 推送的令牌加外层访问控制方案（独立令牌用途 `gap-export`），邮件内容先脱敏；无令牌或错令牌返回 401。
- 迁移 0082（`gap_case_marks`），ADR 0187（docs/adr/0187-weekly-gap-lines-and-cases-against-muse.md）。
- 范围外：每周开发会话生成 Backlog 文件、MCP。

## 约束
- 界面上的每个数字和判断词要有可验证的定义和门槛，没有就不显示（.claude/rules/owner-standing-rules.md）。
- 发给模型的内容只追加；本 PR 是否触及模型请求开头请自行判断。
- 三种语言界面文案，词表见 docs/glossary.md。

## 作者已核对的事实
- gap-lines、weekly-report、gap-cases（真数据库）、迁移契约测试、muse 配对测试通过；tsc -b、glossary、egress-redaction 检查通过。
- 真实网页验收尚未做（容器无 Chromium）。
- 改动范围：用 `git diff <base>...<head> --stat` 查看，约 40 个文件。

请自己读代码找问题；上面的清单只是参考，可以提出清单外的问题和更好的做法。
