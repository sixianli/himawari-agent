## 复核范围

本轮只按增量 `f20cf4cb5894762cb875bea4d6810bc4ee752b48..920742675773da37ec4e38094e0569ef1e80290c` 查了 21 个文件：新增检查脚本与测试、两份说明/计划文件、ADR 0021/0022/0036/0110 与 architecture、engineering-casebook、5 份 runbook；同时对照 `20800746..92074267` 全量 diff 核实删除清单、固定链接目标、runbook-contract 清单和保留文件的存在性。没有整份重读增量未触碰的旧文档。

---

### 1. 中低：新增自动检查仍然覆盖不到上一轮实际出错的两类位置（`.agents/plan-drafts` 和不带 `docs/` 前缀的路径）

**文件:行**：`scripts/check-instruction-links.mjs:7-12`、`scripts/check-docs-links.mjs:12,101-113`

**问题**：上一轮第 3 条的实际错误发生在 `.agents/plan-drafts/think-step-plan.md`，是把已删除规格当作价格来源的代码路径；这一轮把该文件改成了固定链接，但新增的自动检查仍不会覆盖同类回归。`check:instruction-links` 的扫描根不含 `.agents/plan-drafts`：

```js
export const INSTRUCTION_ROOTS = Object.freeze([
  "AGENTS.md",
  "CLAUDE.md",
  ".claude/rules",
  ".agents/instructions",
]);
```

新加的 `DOCS_PATH_MISSING` 只扫 `docs/`（`docsMarkdownFiles(root)`），且正则锚定 `^docs/`：

```js
const GOVERNED_DOCUMENT_PATH = /^docs\/(?:backlog|execution|runbooks)\/[^\s*<>…]+\.md$/;
```

所以 `docs/engineering-casebook.md:1407` 里保留的裸路径 `` `BL-20261026-006-voice-entry-hold-to-talk-and-siri-shortcut.md` `` 这类写法也不会被检查。这里目前 `006` 和 `005` 都存在，不是现有断链；问题是上一轮“现有检查拦不住”的那一类路径没有护栏。`[SOURCE: …]` 标记同样没有被任何新检查覆盖（当前仓库里已没有指向被删文件的 SOURCE，静态核对通过）。

**证据（已证实）**：上述两个扫描根/正则；`check-docs-links.mjs` 只在 `checkDocsLinks` 内遍历 `docsMarkdownFiles(root)`。

**建议**：把 `.agents/plan-drafts` 纳入 `INSTRUCTION_ROOTS`（或新增同等检查），并加“计划里写已删除路径会失败”的反向用例；若希望覆盖 `[SOURCE: …]`，可在现有脚本里补一条只校验 `prepare` 标记内路径是否存在的规则。

---

### 2. 中低：锚点检查只比较“标签原文”，不校验真正的标题 slug，测试把非 slug 锚点当作正确

**文件:行**：`scripts/check-docs-links.mjs:11,87-88`、`test/tooling/docs-links.test.mjs:161`

**问题**：新检查用链接标签里「」中的文字直接和 href 末尾比较：

```js
const DELETED_VERSION_SECTION_LABEL = /「([^」]+）」（已删除，链接指向删除前的版本）$/;
...
const section = DELETED_VERSION_SECTION_LABEL.exec(token.text)?.[1];
if (section && !decode(token.href).endsWith(`#${section}`)) targets.add(token.href);
```

同一脚本自己的 `headingSlug` 明确把空白换成 `-`（`scripts/check-docs-links.mjs:24-30`）。但新增测试把 `「启动 监督」` 配 `#%E5%90%AF%E5%8A%A8%20%E7%9B%91%E7%9D%A3`（解码后是 `#启动 监督`）当作通过：

```js
[old.md「启动 监督」（已删除，链接指向删除前的版本）](${base})
[old.md「启动 监督」（已删除，链接指向删除前的版本）](${base}#%E5%90%AF%E5%8A%A8%20%E7%9B%91%E7%9D%A3)
```

按仓库自己的 slug 规则，真实锚点应是 `启动-监督`。也就是说，这个检查既可“放行错误锚点”（只要标签文字和 URL 尾巴一致），也可能“误报正确 GitHub 锚点”（标题里有空格、全角括号等需要 slug 归一化时）。当前仓库的「」标签恰好都写成了 slug 形态（我 grep 了带空格/大小写/括号的标签，未发现），所以现在没有断链；这是检查本身的正确性缺口。

**证据（已证实）**：上面的正则、比较逻辑、`headingSlug` 及测试输入。

**建议**：用与 `anchorsOf` 相同的 `headingSlug` 归一化标签后再比较，或要求锚点必须等于 `headingSlug(section)`；测试里的空格用例应改为期望失败（或同时验证两种写法）。

---

### 3. 低：ADR 0134 表格里同一个被删规格的链接没有加“已删除”标记，与同文件另一处替换不一致

**文件:行**：`docs/adr/0134-adopt-product-vision-v2-2.md:93`（对照同一文件 `:110`）

**问题**：同一次替换里，有的标签写成“文件名（已删除，链接指向删除前的版本）”，这一处却只把路径换成 20800746 的固定链接、标签仍是代码格式的文件名，读者看不出它指向已删除文件：

```md
| 自建记忆引擎 Spec | [`2026-10-25-self-built-memory-engine-design.md`](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/execution/specs/2026-10-25-self-built-memory-engine-design.md) 第 42 行、第 58 行 | ...
```

而同一文件下方：

```md
- [2026-10-25-self-built-memory-engine-design.md（已删除，链接指向删除前的版本）](https://github.com/.../2026-10-25-self-built-memory-engine-design.md)
```

这不是断链，链接路径与 20800746 上的位置一致；问题只是与本次 PR 的统一约定不一致，且新增检查只看带「小节」的标签，发现不了它。该行属于基准提交 208..f20 的改动，不是本轮增量新加，但核对称述 2 时跟到了这里。

**证据（已证实）**：上述两行原文。

**建议**：给该表格链接补上同样的“（已删除，链接指向删除前的版本）”说明，或明确允许表格内省略并在文档规则里写清。

---

## 侧重检查

- **错误路径/不可信输入**：新检查只解析仓库内的 Markdown，`decode` 对非法百分号编码有 `try/catch`；`existsSync` 不会因文件缺失抛错，缺文件会变成 `DOCS_PATH_MISSING` 而不是崩溃。
- **资源耗尽/ReDoS**：新正则 `[^\s*<>…]+\.md$`、`「([^」]+）」...$` 都是线性匹配；每个文档多 lex 两遍，规模受仓库文档大小限制；没有新增网络、写盘或子进程。
- **安全**：没有秘密读取或外发；`DOCS_PATH_MISSING` 理论上可把仓库内写下的相对路径当存在性探针，但只作用于受版本控制的 `docs/` 且仅用于本地/CI 检查，风险低。
- **不可撤销操作**：本增量只加链接锚点、检查和测试，没有删除/移动/重命名；文件删除已在基准提交完成。
- **规则、文档、代码一致性**：`document-governance.md:29` 已同步描述两个新错误码，与 `check-docs-links.mjs` 实现一致；`document-governance.md:31` 说 `contract_sha256`/`runbook-contract` 已从技能删除、旧字段忽略，`docs/glossary.md` 和 hermes runbook 的句子改成“做完就删/对照 Authoritative Sources”，与现行规则一致。当前 12 份 runbook 仍留 `runbook-contract` 清单，但没有脚本或测试读取它（`test/integration/sandbox-reservation-administration.test.ts:253-276` 只抽取 `PYTHON` 块），不构成错误。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不涉及。增量只改 `docs/`、`.agents` 说明/计划、`scripts/check-docs-links.mjs` 和 `test/tooling/docs-links.test.mjs`，没有改系统提示、工具定义、历史消息、遮盖或请求组装代码，也没有新增任何发给模型的内容；不存在“只在末尾追加/变动值在最后一条消息”被破坏的问题。
2. **同一段文字会不会在不同请求里变成不同字节？** 不会。改动都是静态文档和确定性检查；新检查用 `Set` 但迭代顺序来自 lexer 顺序，不含时间、随机数、无序集合或依赖前后文的遮盖。`existsSync` 只依赖检出版本，符合预期。
3. **有没有对应的自动检查，反向用例真的会失败？** 有。`check:docs-links` 已接入 `npm run check`（`package.json:27,114`），新增的两个测试分别构造“缺锚点”和“路径不存在”的 fixture 并断言错误码；按代码路径这两个用例会失败。遗留缺口见意见 1、2：`.agents/plan-drafts`、不带 `docs/` 前缀的路径和 `[SOURCE: …]` 未被覆盖，锚点检查也不验证真实标题 slug。
4. **新增/修改的每个值，使用端都能接受吗？** 能。新增值只有两个错误码 `DOCS_DELETED_LINK_SECTION_MISSING`、`DOCS_PATH_MISSING` 和两个模块内正则常量；使用端是 `document-governance.md:29` 的文字和 `test/tooling/docs-links.test.mjs`，返回值形状仍是 `{checked, errors}`，没有其他消费者按封闭集合解析。被删的 runbook-contract 行没有代码/测试消费者。保留待办的 `promoted_to`/`source_idea` 指向的文件存在；未发现 `supersedes`/`superseded_by` 指向被删文件。固定链接目标路径与被删文件一致；我抽查了最难判定的 `task-9资格验证并实现隔离与-runtime-adapters`、`task-2完成-machermes-文件与执行-qualification`，在 34de855 的原文标题按 `headingSlug` 计算确为对应锚点。

上一轮四条“会出错”意见的核对结论：第 2 条（普遍丢锚点）在增量里已补上，且全仓 grep 未再发现带「小节」的已删除链接缺 `#`；第 1 条（casebook 两个已删 backlog）已改成固定链接，剩余 `005`/`006` 确实仍存在；第 3 条（plan-drafts 两处价格来源）已改成固定链接；第 5 条（自动检查）新增了两条真实会失败的检查，但仍有上面的覆盖缺口。
