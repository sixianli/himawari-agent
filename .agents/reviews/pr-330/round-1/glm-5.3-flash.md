# 复核结论

本次改动是纯文档改动：`git diff` 显示 8 个文件、每处仅 1-2 行，把 `docs/adr/0192-memory-is-visible-to-the-model.md` 重命名为 `0193-…`（similarity 99%，正文只有标题行 `# ADR 0192：…` → `# ADR 0193：…` 一处变化），并在 7 个文件里同步改了指向它的链接。

## 发现的问题（按严重度）

**1. 低 · docs/adr/（多文件）· 修完 0192/0193 后 check:adr-numbers 仍会失败：0191 重复仍在**
- 证据：glob `docs/adr/019*.md` 同时返回 `0191-record-the-whole-basis-chain-of-a-memory-tidy-up.md` 和 `0191-draft-pull-requests-run-fast-checks-only.md`；`scripts/check-adr-numbers.mjs:23-27` 对共用编号报 `ADR_NUMBER_DUPLICATE` 并退出 1；`test/tooling/adr-numbers.test.mjs:80-82` 的 "passes on this repository" 用例对整个仓库跑 `checkAdrNumbers()`，现在就会失败。
- 两份 0191 分别来自 PR 318（`1fba74d2`，改号提交）和 #323（`fd283e43`），都在基准提交 db18e13 之前，本次 diff 未触及 0191 文件——作者说「0191 重复不是本改动引入」属实，但 PR 目标是「消除 check:adr-numbers 报重复」，合并后该检查仍会因 0191 报错，目标只完成了一半。
- 建议：本 PR 或后续 PR 再把两份 0191 之一改号，否则 `npm run check` 在 main 上仍是红的。

**2. 信息 · scripts/check-adr-numbers.mjs:8-27 · 标题号与文件名一致性无自动校验**
- 证据：脚本正则只查文件名格式和编号重复，不打开文件内容；这次标题行改号是人工保证的，已核实 0193 文件第 10 行标题为 `# ADR 0193：…`，与文件名一致。
- 建议：可接受；如想加固，可让脚本顺带核对首个 `# ADR NNNN` 标题与文件名编号一致。

**3. 信息 · docs/ 内部链接无自动校验**
- 证据：`.agents/instructions/document-governance.md:28` 明确「仓库没有对 docs/ 做全面校验的自动检查……`check:instruction-links` 查指令文件指向的 docs/ 文件和锚点」。即 docs→docs 的相对链接改错了不会被任何检查拦下。本次 7 处链接我已逐一在 diff 中核对，目标文件 `0193-memory-is-visible-to-the-model.md` 存在、其 `#consequences` 锚点存在（0193 文件第 72 行），且 `.claude/rules/prompt-prefix.md` 属指令文件，会被 `check:instruction-links` 覆盖。

## 「读代码证实的」vs「推测」

证实：
- 「只改链接和标题号，没有改任何决定内容」——diff 中 0193 文件 similarity 99%，仅标题行变化；front matter（status/date 等）未动。
- 「没有残留指向 0192-memory-is-visible 的链接」——grep 全仓库（.md 及代码文件）无任何 `0192-memory-is-visible` 残留。
- 「指向另一份 0192 的链接没被误改」——`docs/adr/0192-delete-unimplemented-gateway-operations-and-gate-new-ones.md` 存在、标题行仍为 `# ADR 0192：删除没人实现…`；`ci/operations-removed.json` 里 26 处「见 docs/adr/0192」指向网关 ADR，编号未变仍正确。
- 「0191 重复不是本改动引入」——见问题 1 的 git log 证据。
- 0193 确是 main 上下一个空号（现存 0190、0191×2、0192）。

推测（未核实）：
- 我未运行 `npm run check`（工具受限），「0191 重复会使当前 main 的检查变红」是从脚本退出码逻辑和测试断言推出的，不是运行结果。

## 侧重检查

普通流程走查：新建 ADR → `npm run check` → `check:adr-numbers`（package.json:34，脚本 + vitest 两步）→ `scripts/check-adr-numbers.mjs` 的文件名/重复校验 → `test/tooling/adr-numbers.test.mjs` 的重复、命名、命令行 exit code、全仓库通过等用例。这条链路测试覆盖良好，反向用例（共享编号、坏文件名、exit 1）真实存在且断言有效。
无测试覆盖的路径：① docs 内部相对链接的目标存在性（本 PR 改了 7 处，全靠人工）；② ADR 标题号与文件名一致（本 PR 靠人工）。本次我已手工核实这两处无误。
文档与代码一致性：`.claude/rules/prompt-prefix.md` 第 4条例外文字与 0193 文件第 83 行「规则文件第 4 条的例外里记了这一条」互相印证，一致。

## 必答问题

1. **不会改变模型已见请求开头。**本改动不触碰任何发请求路径的代码，只是重命名文档和改链接；不存在「每轮会变的值」，追加性不受影响。唯一边角：`.claude/rules/prompt-prefix.md` 本身是开发用 agent 的提示前缀文件，本次编辑会改变开发 agent 系统提示的字节——但这是对规则文件本身的有意编辑（记录例外、改编号），且属于该文件第 4 条允许的「有 ADR 依据」的场景，产品对话请求完全不受影响。
2. **不会。**没有代码改动，不涉及遮盖、时间戳或集合顺序；纯 Markdown 字节变化且是文档本身的目的。
3. **有，反向用例会失败。**`check:adr-numbers`（package.json:34）含脚本与测试两步；`test/tooling/adr-numbers.test.mjs:29-41` 专门断言重复编号报 `ADR_NUMBER_DUPLICATE`，:55-66 断言命令行对重复退出 1——若把旧名改回去（两份 0192），这些用例和脚本都会失败。但注意问题 1：因 0191 重复仍在，修复后该检查也并不会变绿。
4. **能接受。**本改动产生的值只有新文件名 `0193-memory-is-visible-to-the-model.md` 和标题号 0193。使用处逐一核对：8 处链接（prompt-prefix.md、ADR 0112/0158/0185、两份 spec、runbook、文件自身标题）全部同步，旧名零残留；指向另一份 0192 的 26 处 JSON 引用未受影响；`.claude/rules` → docs 链接有 `check:instruction-links` 自动校验且目标与锚点存在；docs 内部链接无自动校验但已手工核实。两端一致，无遗漏使用方。
