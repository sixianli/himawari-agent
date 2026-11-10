## 结论

未发现会阻断合并的问题。改动只有一行：测试数据 `gpt-4o` → `wi-fi6`。我按代码核对，`looksLikeSecretToken("wi-fi6")` 仍返回 `false`，贵模型检查的两条正则也都不匹配；检查脚本本身没有放宽。当前做法比放宽检查、或把模型名拆成两段在运行时拼接，更符合规则。

## 发现（按严重度从高到低）

### 低：既有文档与代码不一致，不是本次改动引入

- 文件:行：`scripts/check-expensive-models.mjs:44`、`scripts/check-expensive-models.mjs:83`；`docs/adr/0111-no-expensive-models-anywhere.md:67`
- 问题：检查脚本会跳过自己的测试文件 `test/tooling/expensive-models.test.mjs`，但 ADR 0111 的“不扫的内容”清单没有列这条豁免。作者说“不放宽检查”在本次 diff 上成立，但这条既有豁免在文档里是空白。
- 证据：
  - `const OWN_TEST = "test/tooling/expensive-models.test.mjs";`
  - `if (file === OWN_TEST || HISTORICAL_RECORDS.some((pattern) => pattern.test(file))) continue;`
  - ADR 0111:67 只写了 `docs/`、`evals/*/history.jsonl`、`node_modules`、`evidence`、GitHub 链接和包名。
- 建议：在 ADR 0111 或案例 53 的不扫清单里补上该测试文件及理由（它必须包含贵模型名来测试检查器），或把豁免理由写进脚本注释并同步文档。不影响本次合并。

### 低：提交信息里仍出现贵模型名，属于规则边界空白

- 文件:行：提交 `407827fa` 的提交信息（无 file:line）
- 问题：`git show 407827fa` 显示 `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` 和 `Claude-Session: ...`。检查脚本只扫仓库文件，不扫 git 元数据；ADR 0111 的决定 3 列的也是文件范围。若把“任何场景都不得调用贵模型”理解为提交元数据也算，这里是一处未覆盖的边界；若只约束代码/脚本/评测/配置，则不算违规。
- 证据：
  - `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`
  - `Claude-Session: https://claude.ai/code/session_...`
- 建议：明确规则适用于哪些范围。若提交信息也要管，另加检查；若不管，在 ADR 里写明“只约束仓库文件，不约束提交元数据”。

## 读代码证实的

- Diff 只有一行：`packages/sensitive-capture/test/secret-like.unit.test.ts:28` 从 `"gpt-4o"` 改为 `"wi-fi6"`。
- `looksLikeSecretToken("wi-fi6")` 返回 `false`：
  - `TOKEN` 允许字母、数字和连字符（`secret-like.ts:3`）。
  - 不是 6 位以上纯数字；长度 6，小于 24；也小于 8，所以最后一条 `length >= 8 && LETTER && DIGIT` 不成立（`secret-like.ts:9-15`）。
- 贵模型检查不会命中 `wi-fi6`：`EXPENSIVE_MODEL_PATTERNS` 只匹配 `anthropic/…`、`openai/…`、`claude-(opus|sonnet|haiku|fable)…`、`gpt-<数字>…`（`scripts/check-expensive-models.mjs:45-48`）。
- 当前检出的扫描目录里，除 `test/tooling/expensive-models.test.mjs`（被 `OWN_TEST` 豁免）和 `evals/jarvis-test/history.jsonl`（被 `HISTORICAL_RECORDS` 豁免）外，没有其他 `gpt-<数字>` 或 `claude-*` 命中。
- 该测试文件只导入 `../src/secret-like.ts`，没有生产提示词组装路径引用这个测试文件；`wi-fi6` 在仓库里只出现在这一行。
- 作者说“共 10 条通过”与条数相符：`secret-like.unit.test.ts` 有 6 个 `it`，`test/tooling/expensive-models.test.mjs` 有 4 个 `it`。

## 推测或未核实

- 未实际运行 `node scripts/check-expensive-models.mjs` 或 vitest（本次只允许读文件和 git 命令），所以“改后通过”“10 条通过”未核实；按代码逻辑推断应通过。
- 仓库是 79% 文件的稀疏检出，未检出的 21% 文件未核实；作者“全仓库只有这一处 `gpt-4o`”在当前检出范围内成立，但不覆盖缺失文件。
- 未看到 GitHub Actions 工作流文件；单元测试和 tooling 测试是否在 CI 中实际执行未直接核实。从 `ci/policy.json:146-147`、`ci/policy.json:194` 和 `vitest.workspace.ts` 看，它们会被 `unit`/`tooling` 项目收录。

## 侧重检查

- 错误路径：本次 diff 没有 I/O、异常处理或新分支；检查脚本的 `readFileSync`、目录遍历行为未变。
- 不合规范或不可信的输入：`wi-fi6` 是编译期字面量，不是外部输入；`looksLikeSecretToken` 的纯函数路径会把它当普通词。
- 安全：没有引入密钥、凭据或敏感数据；`wi-fi6` 不会被识别成秘密。提交信息里的贵模型名是元数据问题，不是代码执行问题。
- 资源耗尽：没有新增循环、扫描或递归；检查脚本未改。
- 不可撤销操作：没有。
- 规则、文档和代码一致性：本次没有放宽检查；但发现 ADR 0111 未记录 `OWN_TEST` 豁免（见上），以及提交信息是否属于“任何场景”的边界未写明。`packages/sensitive-capture` 测试仍在 `packages/**/*.unit.test.ts` 扫描范围内，规则没有被绕过。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。改动只在测试文件里，`wi-fi6` 只传给单元测试的 `looksLikeSecretToken`；生产代码 `secret-like.ts` 未改，测试文件也不被系统提示、工具定义、历史消息或遮盖结果读取。发给模型的内容没有新增、改写或重排，仍然只在末尾追加；也没有新增每轮会变的值。
2. **会不会让同一段文字在不同请求里变成不同字节？** 不会。`wi-fi6` 是固定字面量；`looksLikeSecretToken` 是纯函数（`normalize("NFKC")` 加固定正则），不依赖前后文、时间或集合顺序。生产遮盖路径未改。
3. **有没有对应的自动检查，反向用例真的会失败吗？** 有：`secret-like.unit.test.ts:19-32` 断言 `wi-fi6` 不是秘密；`test/tooling/expensive-models.test.mjs:80-86` 对整个仓库调用 `findExpensiveModels()` 并要求零命中；`test/tooling/expensive-models.test.mjs:22-63` 是检查器的反先用例。若 `looksLikeSecretToken` 开始把 `wi-fi6` 当秘密，第 31 行会失败；若检查器开始命中 `wi-fi6`，第 81 行会失败。未实际运行，按断言逻辑会失败。
4. **改动产生或修改的每个值，使用它两端都能接受吗？** 只有一个新值 `wi-fi6`。产生处是 `secret-like.unit.test.ts:28`，使用处是同一测试第 31 行的 `looksLikeSecretToken`；该函数按 `secret-like.ts:9-15` 返回 `false`，检查脚本的正则也不匹配它。没有其他使用处，旧值 `gpt-4o` 已无引用。没有新增标识、配置键、清单项或序列化格式。

## 更好的做法

当前“换掉测试字面量、不放宽检查”的方向是对的，不建议为了一个测试数据去豁免整个测试目录，也不建议用字符串拼接绕过检查。可以再补两点防止复发：

- 在测试或贡献说明里写一句：不要拿真实贵模型名当普通测试数据；需要测试模型名时，像检查器自己的测试那样走明确的豁免。
- 若想保留原来的“连字符加数字”形态，可以选一个中性的同类词；`wi-fi6` 已经能覆盖当前实现关心的路径，不必为此改检查。
