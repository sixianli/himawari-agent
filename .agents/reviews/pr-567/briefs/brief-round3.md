# PR 567 复核材料

## 问题
Andy 要求把 CI 提速过程中的数据、失败、经验和每项优化前后的实测数据记成一份文档，给以后重启的 CI 开源工具线程学。

## 改法
新增 .agents/evidence/ci-speedup-lessons.md（经验记录）和 .agents/evidence/ci-runs-2026-11-15.md（两次 main 运行的作业时间、runner 忙闲比例），以及本 PR 的复核记录；不改代码。

## 请重点核对
文档里每个数字、运行号、文件行号、ADR 编号是否和仓库里的证据文件（.agents/evidence/ci-*.md）、ADR（docs/adr/0256、0266、0267、0275）、事故清单（docs/incidents-and-gates.md 的 I-93、I-95、I-99、I-100、I-102）和 .github/workflows/ci.yml、.github/workflows/main.yml 一致；有没有说错因果。

## 作者的说法
- 这个改动不涉及发给模型的请求。
- 运行号 43675431801、43678751781 的作业时间已归档在 .agents/evidence/ci-runs-2026-11-15.md；43680214152、43671620922 的少量数字只出自 GitHub 接口和作业日志。
- 经验记录开头写明只是参考、不是开源工具线程必须遵守的规则（Andy 要求），请核对全文没有写成“应该/必须”的语气。
