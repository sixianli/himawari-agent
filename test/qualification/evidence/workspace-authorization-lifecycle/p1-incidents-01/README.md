# P1 释放后的资源矛盾事件

本批基线为 `e056890`，新增 Schema 42。实现复用原 SQLite journal、保护表、工作区冲突检查及有限 inspect/stop 恢复服务，不增加执行或模型调用权限。

## 目标与证据

| 行为 | 证据 |
| --- | --- |
| 原代码拒绝矛盾观察，却未留下保护 | [首次失败](contradiction-red.log)：真实 SQLite 两种执行方式均失败 |
| 新风险不撤销原释放事实，阻止冲突请求与原继续动作 | `sqlite-sandbox-execution-v2.test.ts`；重复证据不重置恢复状态，无关资源仍可准入 |
| 缺失、过期、错绑、早于释放或夹带结果变更的证据不能制造保护 | [初轮事件矩阵](incidents-targeted.log)，与最终标准测试一起核对 |
| 数据库重开后保护仍在；原停止证明重验不能解除，新停止证明经原恢复服务可解除 | [恢复与历史迁移回归](recovery-final-2.log) |
| 原执行许可过期仍可记录新鲜实际风险，但不能重新启动 | [期限边界](expired-authority.log) |
| 释放落盘较晚不改变资源事件先后；同毫秒矛盾证据仍保护 | [迟到接纳失败](late-acceptance-red.log)、[时间边界通过](time-boundaries-final.log) |
| Schema 41→42 保留已有释放凭据、claim、旧控制保护与迁移历史；旧 writer 被拒绝 | 有数据的旧 Schema 集成测试，及 [迁移合同回归](migrations.log) |
| 只读核查报告事件计数与安全原因，不输出受保护验证正文 | `workspace-lifecycle-audit.test.ts`，包含数据库字节不变与输出不披露断言 |

资源风险只接受绑定原环境、policy/scope、监管者及原进程身份的宿主验证。普通 unknown 不建立新保护。原 released 观察、永久释放回执与物理 claim 的 `released_at` 不改变；事件及解除证明另行保存。新事件记录当前恢复 owner 和明确的 unresolved 原因，旧回调受 revision 检查限制。新停止证明须晚于风险观察、匹配同一进程身份，并在本次写入时有效。

## 命令与验证范围

沿用仓库入口：

```sh
node node_modules/vitest/vitest.mjs run --config vitest.workspace.ts --project integration test/integration/sqlite-sandbox-execution-v2.test.ts test/integration/workspace-lifecycle-audit.test.ts test/integration/sandbox-v2-payload-broker.test.ts test/integration/sandbox-control-evidence.test.ts test/integration/sandbox-execution-v2.test.ts
node scripts/ci/local.mjs --check test --tools .ci-output/tools --output .ci-output/p1-incidents-02
npm run typecheck
python3 /Users/triggerjames/.codex/skills/document-governance/scripts/validate_docs.py --strict .
```

这里的数据库、迁移、端口、只读 CLI 子进程及恢复服务真实执行；宿主验证凭据和时间为受控测试输入。本批没有制造真实逃逸进程来触发矛盾事件，也没有部署或迁移生产数据库。既有 Mac/Linux 后代写入证据见 [p1-platform-01](../p1-platform-01/README.md)，不能将它当作本批 Schema 42 的生产资格。

## 失败与执行记录

- `consumers.log` 中两项扩展测试先执行无关目录请求，耗尽夹具的调用额度，导致冲突断言未进入工作区检查。调整测试顺序后，原冲突断言保持不变；[消费者回归](consumers-final.log)通过 236 项。之后补充的同毫秒边界由专门回归及最终标准测试覆盖。
- 初版错误地要求风险发生在释放回执接纳之后；迟到接纳测试真实失败后，改为比较资源观察发生时间。初轮标准验证的专属进程组已停止并确认退出码 143，详情见 [中断记录](standard-ci-initial-interruption.json)。该轮不算完成的构建测试结果。
- 最终标准验证使用新的 `.ci-output/p1-incidents-02`；[第二轮输入摘要](frozen-inputs-final.json)与初轮摘要分别保留，未覆盖历史证据。
- 全库 `npm run check` 被原有未跟踪的 r1/r2 原型脚本格式问题阻断，见 [原始输出](check.log)。任务范围的格式/lint、类型和文档检查分别保存，未修改这些无关文件。
- 五份受影响 Runbook 经语义核对及治理工具重新封存；封存不授权任何生产操作。

第二轮完整标准验证为 3,732 项通过、2 项旧合同断言失败，见 [结果](standard-ci-contract-mismatch-result.json)与[失败明细](legacy-contract-failures.json)。该轮 1,121 个输入未变。旧测试要求矛盾观察抛错，已按批准的 Spec 改验“保留原释放事实并建立保护”，仍检查冲突拒绝；原身份和资源变更拒绝用例保留。修改后 [journal 全文件](journal-delivery.log) 140 项通过。最终标准复测复用第二轮已通过的构建产物，通过原验证器再次核对产物摘要与当前产品输入，不修改构建或测试系统来绕过检查。

[最终标准测试](standard-ci-result.json)通过 243 个文件、3,734 项，零失败、零跳过；[构建结果](standard-ci-build-result.json)通过，复测复用了其摘要核验一致的同一产物。最终 [1,121 项输入复核](freeze-check-delivery.json)无变化。类型、任务范围格式/lint、边界、覆盖映射、不变量、秘密扫描、CI policy 和严格文档检查通过。全库格式阻断仍保持上文所述边界。

归档日志只清理行尾空白及文件末尾多余空行，以通过 Git 空白检查；保留测试命令对应的成功、失败、跳过和错误正文。
