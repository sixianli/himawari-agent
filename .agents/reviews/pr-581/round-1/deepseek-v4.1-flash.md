## 结论

改动本身很小，正常路径能拦住 I-109 那种完整冲突块。下面按严重度列出问题；「读代码证实」与「推测」分开写。**未能运行 node、vitest 或脚本本身（本次只能用读文件和 git 命令），所以凡涉及运行结果的判断都注明是读代码推断。**

### 1. 中：列举索引用 `git ls-files`、却读工作树，暂存区里的标记可能漏掉

文件：`scripts/check-conflict-markers.mjs:23-31`、`scripts/check-conflict-markers.mjs:34-44`

问题：文件清单来自索引，内容却来自工作树，门禁检查的不是「将要提交/推送的内容」。

证据（读代码证实）：

```js
const listed = execFileSync("git", ["ls-files", "-z"], { ... });
...
return listed.split("\0")...
...
export function scan(paths, read = (path) => readFileSync(join(root, path))) {
...
  const failures = scan(trackedTextFiles());
```

`git ls-files` 默认列索引中的路径，而 `scan` 读的是 `join(root, path)` 的工作树文件。

推测：冲突文件被 `git add` 进索引后，开发者又在工作树里把标记改掉却忘了重新 `git add`，此时 `npm run check` 会通过，而 `git commit` 仍提交索引里带标记的版本。这个场景正好是 I-109 的「提交里带标记」类问题，只是触发顺序不同。未暂存删除（索引有、工作树无）也属于同类。

建议：检查索引内容（例如 `git grep --cached -I -n -E '^(<<<<<<< |>>>>>>> )'`，或 `git ls-files -s -z` 配 `git cat-file`）；如果还要在合并现场尽早提示，再额外扫一遍工作树。也可以把检查同时放进 pre-commit/pre-push，检查将要落进提交的索引。

### 2. 中：读文件失败被 `catch { continue; }` 静默跳过，门禁 fail-open

文件：`scripts/check-conflict-markers.mjs:36-43`

问题：任何读取异常都不会让门禁失败，也不会出现在输出里。

证据（读代码证实）：

```js
try {
  content = read(path);
} catch {
  continue;
}
```

会被静默跳过的包括：权限不足（EACCES）、子模块 gitlink 或目录（EISDIR）、稀疏检出/未暂存删除导致的缺文件、以及可能存在的非 UTF-8 路径解码问题。

推测：CI 干净检出时影响很小；本地工作树异常、或以后引入子模块时，带标记的文件可能在「读不到」的名义下被放行。对一个阻断性门禁来说，静默跳过不合适。

建议：用 `git ls-files -s -z` 拿到 mode，显式跳过 submodule（mode `160000`）；其他读取失败应打印并让检查失败。若改成读索引 blob，也能同时解决第 1 条。

### 3. 中：只认成对标记，缺结尾、只剩 `=======` 或孤立 `>>>>>>>` 都不报，测试还固化了这一行为

文件：`scripts/check-conflict-markers.mjs:9-20`；`test/tooling/conflict-markers.test.mjs:24-26`

问题：文件里有完整的一对 `<<<<<<< ` 和 `>>>>>>> ` 才失败；只有开头、只有分隔线、只剩结尾都会通过，而这些同样会让 Swift/TS 编译失败。

证据（读代码证实）：

```js
if (lines[index].startsWith("<<<<<<< ")) open = index + 1;
else if (lines[index].startsWith(">>>>>>> ") && open !== null) { ... }
```

测试明确把缺结尾当成功：

```js
expect(findConflictMarkers("a\n=======\nb")).toEqual([]);
expect(findConflictMarkers("  <<<<<<< HEAD\n  >>>>>>> x")).toEqual([]);
expect(findConflictMarkers("<<<<<<< HEAD\nonly the start")).toEqual([]);
```

作者说测试「覆盖……缺结尾」属实，但那条用例断言的是「不报」，不是「会失败」。另外，如果在前一个 `<<<<<<< ` 还没闭合时又出现一个 `<<<<<<< `，`open` 会被覆盖，前面的起点丢失；只要最终没有任何 `>>>>>>> `，这个文件仍然放行。

建议：把三种标记任一出现都视为失败，或要求完整三段 `<<<<<<<` / `=======` / `>>>>>>>`；文档误报用路径豁免解决，而不是靠「只认成对」来降低误报。

### 4. 中：自动测试没有覆盖 CLI、`trackedTextFiles` 和真实仓库，I-109 的复现只是手工证明

文件：`test/tooling/conflict-markers.test.mjs:1-38`

问题：测试只调用两个纯函数，没有启动 `scripts/check-conflict-markers.mjs`，没有测 `git ls-files` 枚举、`.agents/reviews/` 跳过、真实文件读取，也没有针对 `6c602bbb4`/`41c899402` 的自动用例。

证据（读代码证实）：

```js
import { findConflictMarkers, scan } from "../../scripts/check-conflict-markers.mjs";
...
const failures = scan([...files.keys()], (path) => files.get(path));
```

CLI 入口、`trackedTextFiles()`、`process.exit(1)` 都没有被断言。若入口守卫、`git ls-files` 调用或工作目录出错导致脚本什么都不扫、直接 exit 0，这套测试仍然全绿；CI `static` 会跑 `npm run check`（`scripts/ci/run.mjs:269`），但那时也是「脚本没报错所以通过」。

建议：加一个临时 git 仓库的端到端用例，提交带标记的文件，断言 CLI 退出 1 且输出 `CONFLICT_MARKERS_LEFT 路径:行-行`；再加「`.agents/reviews/` 被豁免」「二进制被跳过」「CRLF 仍能识别」；并像 `incident-gates.test.mjs` 的 `checks the repository's own list` 一样，加一条对本仓库 `scan(trackedTextFiles())` 为空且文件数大于 0 的自检。历史复现最好固化成可重放的夹具，而不是只写在事故表里。

### 5. 低：合法成对标记的误报没有豁免机制（当前仓库已核实不会误报）

文件：`scripts/check-conflict-markers.mjs:7`、`scripts/check-conflict-markers.mjs:14-15`

问题：任何文件只要行首出现成对标记就失败，唯一豁免是硬编码的 `.agents/reviews/`，不区分 Markdown 代码块、文档示例、测试夹具。

证据（读代码证实）：`const SKIPPED_PREFIXES = [".agents/reviews/"];`；判断只看 `startsWith("<<<<<<< ")` / `startsWith(">>>>>>> ")`，不解析 Markdown。当前仓库全文搜索 `^(<<<<<<< |>>>>>>> )` 没有匹配（脚本和测试里的标记都在引号/缩进里），所以现在不会误报。

推测：以后在 `docs/` 或 `test/fixtures/` 的代码块里放一段真实冲突示例，就会把整个 `npm run check` 拦下，而且除了改代码没有别的豁免办法。

建议：增加可维护的路径/文件豁免（配置或显式注释标记）；或者对 Markdown 用解析器跳过代码块；至少不要把豁免写死成唯一一个前缀。

### 6. 低：`maxBuffer` 和单文件大小都没有保护，超大仓库/大文件时失败信息不可读

文件：`scripts/check-conflict-markers.mjs:24-28`、`scripts/check-conflict-markers.mjs:34-44`

问题：`maxBuffer` 只限制 `git ls-files` 的输出（64 MiB），单个文件仍整个读进内存，没有大小上限；`execFileSync` 超限会抛出未捕获异常。

证据（读代码证实）：

```js
const listed = execFileSync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
...
content = read(path);   // readFileSync，整文件
```

推测：当前仓库规模远低于 64 MiB 的路径列表上限；但超大 monorepo 会以未捕获异常退出（仍是失败，不是静默放行，所以主要是可用性问题），误跟踪的超大文件会占用大量内存。未实际测过本仓库 `git ls-files` 的字节数（本次不能运行 `git ls-files`）。

建议：给 `git ls-files` 更大的上限或改成流式；读文件前 `stat` 限制大小，或用 `git grep` 这类按需扫描；超限时打印明确的错误码。

### 7. 低：没有接入 pre-push，推送路径仍可能绕过新门禁

文件：`scripts/git-hooks/pre-push:1-23`

问题：I-109 的失败是一次推送的合并提交，但 pre-push 没有跑新检查。

证据（读代码证实）：pre-push 只跑 layer0、boundaries、format、lint、secrets、repo-hygiene，没有 `check-conflict-markers`；`docs/incidents-and-gates.md:141` 也只写它是 `npm run check` 的一步。

推测：如果线程在合并后没先跑 `npm run check` 就推送，这次改动仍拦不住。CI 的 `static` 会跑全量 `npm run check`，但按当前临时例外，合并不等 CI；所以推送钩子是更直接的一道门。

建议：把 `node "$root/scripts/check-conflict-markers.mjs"` 加进 pre-push（或 pre-commit）。注意它列索引但读工作树的问题（第 1、2 条）同样会影响钩子，最好先改成读索引。

## 侧重检查

- **错误路径**：`scan` 吞掉所有读取异常（第 2 条）；`trackedTextFiles` 和 CLI 主流程没有 `try/catch`，git 缺失、不是仓库、`maxBuffer` 超限都会以未捕获异常非零退出（fail-closed，但输出不友好）。已读 `scripts/check-conflict-markers.mjs:23-63`。
- **不合规范/不可信输入**：内容来自受版本控制的任意文件，用 NUL 字节跳过二进制；使用 `execFileSync("git", [...])` 数组参数，没有 shell 拼接，git 路径也不能含 `..`，**没有命令注入或路径穿越**。非 UTF-8 文件名会被 `encoding: "utf8"` 有损解码，可能导致读不到而静默跳过（归入第 2 条），属推测。
- **安全**：脚本只读、不联网、不输出文件内容，只打印路径，不涉及密钥。唯一低风险是：如果恶意提交一个带 ANSI 控制字符的文件名并且文件含标记，路径会被原样打印到终端/CI 日志，理论上可做日志注入；需要写权限，影响仅限日志，猜测为低风险，未单独列意见。
- **资源耗尽**：见第 6 条；`execFileSync` 的 `maxBuffer` 只作用于路径列表，文件内容是逐个整读，峰值约为单个最大文件。
- **不可撤销操作**：脚本不写文件、不删除、不推送、不联网，只以退出码影响流程；真正的不可逆动作是 push，见第 7 条。
- **规则文件/说明/代码一致性**：核对过 I-109 行与代码。`scripts/check-conflict-markers.mjs`、`test/tooling/conflict-markers.test.mjs` 都存在，`checkIncidentGates` 的 id/日期/次数/状态/路径校验都能通过（`scripts/check-incident-gates.mjs:56-78`）。我按 `6c602bbb4..41c899402` 的 diff 数过：6 个文件带标记（ManageDemo、ManageStrings、SettingsStore、TuningModels、TuningPages、SettingsRootView），其中 ManageDemo 6 块、TuningModels 3 块，合计 9 块，与事故表「报 9 处」一致；修复提交移除了这些行，所以逻辑上会报 0（未运行脚本验证）。`6 个文件`也属实（修复提交另动了一个只是重排测试的文件，本身没有标记）。事故表说「扫描所有受版本控制的文本文件」略宽：实际还跳过 `.agents/reviews/` 和读不到的文件；「一对标记才失败」的措辞与代码一致，也确实意味着缺结尾不报。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。读代码证实：本 PR 只新增 `scripts/check-conflict-markers.mjs`、`test/tooling/conflict-markers.test.mjs`、改 `package.json` 的检查步骤列表和 `docs/incidents-and-gates.md` 一行；没有改系统提示、工具定义、历史消息、资料块或出口遮盖，也没有改 `packages/prompt-catalog` 或 `.agents/instructions/model-review.md`。发给模型的内容仍只在末尾追加；本改动没有引入任何每轮会变、需要挪到末尾的值。复核流程里新增的只是本次材料中的 diff/说明，本来就在固定指令之后的尾部。依据：`.agents/instructions/prompt-prefix.md:27-29`（固定在前、会变的在最后一条用户消息）、`:36`（已发内容只能末尾追加）、`:53-54`（序列化和遮盖必须确定）、`:76`（`check:prompt-prefix` 是阻断检查，本次未触碰其覆盖范围）。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**
不会。读代码证实：没有新增模型可见字段、时间戳、哈希或集合遍历顺序；`check:conflict-markers` 的输出只进终端/CI 日志，不进模型请求。检查内部 `findConflictMarkers` 对固定字符串是确定的；`git ls-files` 的输出顺序只影响报错顺序，不进模型请求。唯一可能被关注的是 `.agents/reviews/` 下的复核记录会进复核提示词，但本改动没有修改这些文件，也没有改它们的生成方式。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**
有自动检查：`package.json:32` 的 `check:conflict-markers`，并已加入 `package.json:27` 的 `check:steps`；CI 的 `static` 作业通过 `scripts/ci/run.mjs:269` 跑完整 `npm run check`。单元层面反向用例是真的：如果 `findConflictMarkers` 不再识别成对标记，`test/tooling/conflict-markers.test.mjs:15-19` 会失败；如果 `scan` 不报告坏文件或错误地放过二进制，`:28-35` 会失败。**但**：没有端到端用例运行 CLI/`trackedTextFiles`，所以入口或 `git ls-files` 坏掉时测试仍绿；「缺结尾」用例断言的是通过而不是失败；历史复现（`6c602bbb4` 报 9 处、`41c899402` 报 0 处）只写在事故表里，没有提交成自动用例。结论：helper 级反向用例成立，门禁级反向用例不足。

**4. 改动产生或修改的每个值，使用它的一方都能接受吗？**
逐个核对：
- `check:conflict-markers` 这个 npm 脚本名：被 `check:steps` 使用，`scripts/run-all-checks.mjs:6-11` 的 `/^npm run (\S+)$/` 能接受含冒号/连字符的名字；`test/tooling/run-all-checks.test.mjs:74` 要求每个步骤名都有对应脚本，已存在。
- 新的导出 `findConflictMarkers`、`scan`：测试导入并使用；`trackedTextFiles` 只被 CLI 自己调用；没有其它使用端。
- 事故表 `I-109` 的字段：`checkIncidentGates` 的 id（`/^I-\d{2,}$/`）、日期、次数、状态、门槛路径校验都能通过；反引号里的 `scripts/check-conflict-markers.mjs` 和 `test/tooling/conflict-markers.test.mjs` 都存在，`existsSync` 成立；`npm run check:conflict-markers`、`6c602bbb4`、`ManageDemo.swift` 等不含斜杠，不会被误当成仓库路径。
- 输出串 `CONFLICT_MARKERS_LEFT` / `CONFLICT_MARKERS_NONE`：读代码和搜索都没有其它消费者按格式解析；CI 只看退出码，能接受。
- 没有序列化格式、协议字段、配置键或清单项发生变化。

**未核实**：未实际运行 `node`/`vitest`/检查脚本；未实测超大仓库 `git ls-files` 的字节数和 `maxBuffer` 边界；未查看 `.agents/reviews/` 的实际内容（该路径在本环境被拒绝读取）；未验证非 UTF-8 文件名的真实行为。
