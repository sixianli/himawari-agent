# 复核结论

## 发现的问题（按严重度排序）

### 1. 高：ADR 之间的“裸文件名”链接完全没被检查，正好漏掉改号后最容易断的链接
**文件：** `scripts/check-adr-numbers.mjs:34`、`:89`；测试 `test/tooling/adr-numbers.test.mjs:91-105`
**证实：** 目标路径必须包含 `adr/` 这一段才进入检查：
```js
34: const ADR_LINK_TARGET = /(?:^|\/)adr\/\d{4}-[a-z0-9][a-z0-9-]*\.md$/;
89: if (!relative || /^[a-z][a-z0-9+.-]*:/i.test(relative) || !ADR_LINK_TARGET.test(relative)) continue;
```
但 `docs/adr/` 内部大量使用“裸文件名”互链，这些都不含 `adr/`，会被直接 `continue`：
- `docs/adr/0041-test-hosts-and-production-server.md:30`：`[ADR 0038](0038-test-layer-trigger-timing.md)`
- `docs/adr/0131-read-lane-separate-readonly-connection.md:91`：`[ADR 0128：…](0128-record-cache-usage-of-every-model-request.md)`
- `docs/adr/0050-hermes-root-disk-cleanup-without-floor.md:86`：`[ADR0047的对照结果](0047-test-checkout-on-hermes-nvme.md#nvme-comparison)`

我用 grep 在 `docs/adr/*.md` 找到 **100+ 条裸 ADR 链接**，其中 **61 条还带 `#锚点`**。它们既不被检查文件是否存在，也不被检查锚点。也就是说：把 ADR 0193 改成 0195 后，其它 ADR 正文里的 `[...](0193-...)` 断链不会被这道门拦住——这正是本 PR 声称要防的场景。测试里只有 `../../adr/...` 形式，没有裸文件名反向用例，所以这个缺口也不会有测试报警。

**建议：** 不要用字符串形状判断，改为解析出 `destination` 后判断“落点目录是否为 `docs/adr` 且 basename 匹配 `ADR_FILE`”，这样 `docs/adr` 内的裸文件名、`docs/execution/...` 的 `../../adr/...` 都能覆盖；并补一条反向用例：在 `docs/adr/0002-b.md` 里写 `[旧](0003-old.md)`，必须报 `ADR_LINK_MISSING`。

### 2. 中：规则/说明文档仍在描述旧行为，和代码不一致
**文件：** `.agents/instructions/document-governance.md:28`、`docs/lessons.md:733`
**证实：** 两处都只写检查“文件名格式”和“重复编号”：
```md
document-governance.md:28: `npm run check:adr-numbers` 查 `docs/adr/` 下每个 `.md` 文件的名字都是“四位编号-小写短名.md”…并且没有两份 ADR 共用一个编号。
lessons.md:733: …并且没有两份 ADR 共用一个编号；有就报 `ADR_NUMBER_DUPLICATE` 并以 1 退出。
```
但代码现在还会报 `ADR_NUMBER_TITLE`、`ADR_LINK_MISSING`、`ADR_LINK_ANCHOR_MISSING`。`document-governance.md` 自己第 21 条要求“改动让反映当前事实的文档明显出错时，在同一提交里改正”。
**建议：** 同步更新这两处，列出三项检查和新的错误码。

### 3. 低：标题错误输出顺序依赖文件系统 `readdir` 顺序
**文件：** `scripts/check-adr-numbers.mjs:113`
**证实：**
```js
113: const names = readdirSync(directory).filter((name) => name.endsWith(".md"));
```
链接检查用的 `markdownFiles` 做了 `.sort()`（`:57`），但标题检查的 `names` 没有排序，多份 ADR 同时标题错时，stderr 顺序可能随文件系统变化。
**建议：** 这里补 `.sort()`，保持输出字节确定（也符合确定性检查的一般习惯）。

### 4. 低：错误路径缺少保护，异常输入会让检查以未捕获异常崩溃
**文件：** `scripts/check-adr-numbers.mjs:57-62`、`:96`
**证实：** `markdownFiles` 对每个条目直接 `statSync`，`findAdrLinkProblems` 对锚点命中的目标直接 `readFileSync`，没有 `try/catch`。`docs` 下若有断掉的符号链接，`statSync` 抛 `ENOENT`；若有符号链接环，递归可能不终止；若 ADR 链接目标存在但是目录，`:96` 抛 `EISDIR`。检查不会给出结构化错误码，而是堆栈退出。
**推测：** 当前仓库未发现这类条目，所以不是现存失败，只是健壮性/资源耗尽风险。
**建议：** 用 `lstatSync`/`realpath` 防环，或对每个文件读写做 `try/catch` 并输出 `ADR_LINK_READ_FAILED` 一类结构错误。

### 5. 低：`所有 Markdown 链接` 的说法比实现宽
**文件：** `scripts/check-adr-numbers.mjs:33`
**证实：** 只匹配内联链接 `](...)`：
```js
33: const MARKDOWN_LINK = /\]\(([^)\s]+)\)/g;
```
引用式定义（`[x]: ../../adr/...`）和 HTML `<a href>` 不会被检查。我在 `docs/` 里 grep 未发现现存的引用式/HTML ADR 链接，所以目前只是潜在缺口，不是当前断链。
**建议：** 要么改标题为“内联链接”，要么补上引用式链接解析。

## 作者说法核对
- “不改发给模型的内容”：**属实**。diff 只有 `scripts/check-adr-numbers.mjs`、`test/tooling/adr-numbers.test.mjs` 和一个 `docs/execution/specs/*.md` 文档；没有系统提示、工具定义、历史或遮盖代码。
- “锚点规则抄自 `check-instruction-links.mjs`”：**属实**，`headingSlug`/`EXPLICIT_ANCHOR`/`HEADING` 两边一致。
- “两处断链改为 `../../adr/`”：**属实**；`docs/adr/0004-*.md` 与 `0053-*.md` 都存在。
- “193 份 ADR”：**属实**，目录里正好 193 个条目。
- “9 条测试”：**属实**，测试文件里 9 个 `it`。
- “ADR 链接除 `docs/archive` 外只有两处断链”：**未核实**。新脚本跳过了裸链接（见问题 1），所以它不能证明这个结论；我抽查的裸链接目标编号都在目录里，但没有逐条核对全部。

## 侧重检查
- **错误路径：** 见问题 4。另外 `target.split("#")` 对多个 `#` 会静默丢弃后面部分；`%` 编码的锚点（如 `#%E7%BB%93...`）会被当成不存在（当前未发现此类 ADR 链接，未核实未来是否会出现）。
- **不可信输入：** 链接目标可以带 `../` 甚至绝对路径逃出仓库，但检查只读取并回显链接字符串，不回显文件内容，也不写文件；没有秘密泄漏或破坏性操作。标题正则只看第一个 `^# ` 行，若代码块里出现行首 `# ` 会误判；我用 grep 确认当前 `docs/adr` 下所有 `^# ` 行都以 `# ADR` 开头，所以当前不会误报（推测未来可能）。
- **资源耗尽：** 递归遍历整个 `docs/` 并逐个完整读文件，且跟随符号链接；没有大小/深度限制。对仓库检查可接受，异常树可能放大（见问题 4）。
- **不可撤销操作：** 无。整个检查只读。
- **文档/规则与代码一致性：** 见问题 2。另外本次改动的 `docs/execution/specs/2026-09-16-workspace-authorization-lifecycle-design.md` 的 SHA-256 被记录在多个 `test/qualification/evidence/.../frozen-inputs*.json` 里；我 grep 后没有发现任何代码校验这些 `frozen-inputs`，所以不会自动失败，但这些历史证据记录的是改动前的摘要。是否有仓库外的核对流程要求摘要一致 —— **未核实**。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。改动只在检查脚本、测试和一份说明文档；没有改系统提示、工具定义、历史消息或遮盖规则，也没有新增每轮变化的值。发给模型的内容仍然只在末尾追加，每轮会变的值仍应放在最后一条消息里。我 grep 了 spec 文件名，未发现运行时导入/拼装它的代码。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
不会涉及模型内容。检查器本身：链接错误按 `.sort()` 顺序输出，是确定的；但标题错误顺序依赖 `readdirSync`（问题 3），若有人把 stderr 字节当输出比对，可能不稳定。无时间字段、无随机值。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**
有。`package.json:27` 的 `check:steps` 含 `check:adr-numbers`，`package.json:34` 会先跑脚本再跑 `test/tooling/adr-numbers.test.mjs`。标题号错、旧文件名链接、锚点不存在、archive 不检查这几个反向用例，删掉对应逻辑后都会因断言数量/内容不符而失败。**但**裸文件名 ADR 链接没有任何用例（问题 1），`passes on this repository` 也暴露不了它，因为这类链接根本不会进入检查。

**4. 新产生的每个值，使用它的地方都能接受吗？**
新值是三个错误码 `ADR_NUMBER_TITLE`、`ADR_LINK_MISSING`、`ADR_LINK_ANCHOR_MISSING` 和一行 `ADR_NUMBERS passed/failed ...`。
- `scripts/run-all-checks.mjs:18-19` 只看进程退出码，接受任意 stderr 文本；
- 测试按前缀/精确字符串断言，接受这些格式；
- 没有后端、schema 或机器解析器消费这些错误码。
因此格式本身各处都能接受。唯一不一致的是 `.agents/instructions/document-governance.md:28` 和 `docs/lessons.md:733` 没有登记这些新错误码/新检查（问题 2）。
