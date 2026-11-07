## 发现的问题

### 1. 中高｜`scripts/model-review/opencode-review.mjs:182-183`（配合 `:198-208`）｜GLM 的固定侧重被改，导致 GLM 已经见过的提示词开头变化
【读代码证实】本轮的 GLM lens 文字改了：

```js
"glm-5.3-flash":
  "你的额外侧重：测试有没有覆盖这次改动、文档和规则与代码是否一致；……有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题……"
```

`buildPrompt` 把 lens 放进 `fixed`，并且 `fixed` 在 `---- 本次材料 ----` 之前：

```js
const fixed = [
  ...
  ...(lens ? [lens] : []),
  text.output,
].join("\n");
const material = ["---- 本次材料 ----", ...];
return `${fixed}\n\n${material}\n`;
```

这不是只追加末尾：它改了一个模型固定段的字节。`e4e11d13` 提交已经新增了 `.agents/reviews/pr-263/round-1/glm-5.3-flash.prompt.md`，而 `git diff e4e11d13..HEAD -- scripts/model-review/opencode-review.mjs` 显示当时的 GLM lens 仍是旧文本。也就是说，PR #263 第 1 轮的 GLM 已经看过旧开头；如果之后 DeepSeek 失败、由 GLM 替补，GLM 会看到新开头。规则文件第 68 行明确写“侧重写在‘本次材料’之前、同一个模型每轮都一样”，本次任务约束也要求“同一个模型每轮提示词在‘本次材料’之前必须逐字节相同”。

【推测】这会让 GLM 后续轮次的公共前缀缓存失效，增加费用；不会改变 DeepSeek 的开头。

建议：本 PR 先不要改 GLM lens，等本次复核结束后再改；或者在 `roundForRun`/开跑前加跨轮检查：对每个模型读取历史 `round-*/<model>.prompt.md`，比较“本次材料”之前的部分，不同就拒绝并提示需要显式换新。测试要加这个反向用例，而不是只断言新词句存在。

### 2. 中｜`scripts/model-review/opencode-review.mjs:1263-1281`｜`--report` 列出所有 low-fix 记录，但不检查它是否在复核链上
【读代码证实】报告只按类型筛选：

```js
const lowFixLines = records
  .filter((record) => record.mode === "low-fix")
  .flatMap((record) => { ... });
```

而 `coveragePoints` 只给有通过复核点的轮次追加 low-fix：

```js
for (const round of rounds) {
  ...
  if (covering.length === 0) continue;
  ...
  for (const record of records.filter((fix) => fix.mode === "low-fix" && fix.round === round))
    points.push({ ... by: "low-fix" });
}
```

因此手写一条 `round: 99` 的 low-fix（只要 `parseUsage` 的形状检查能过）不会进入复核链、不会被 `lowFixProblems` 重核，但 `--report` 仍会把它打印成“低严重度已改、未复核”。它不能绕过合并门槛对代码覆盖的检查（门槛仍会检查 `complete.head..HEAD` 的非记录文件改动），但可以让报告里出现一条从未真正被 `--accept-low` 验证过的记录。

【推测】Andy 若只抽查报告这一节，可能把它当成已放行的 low-fix。

建议：`--report` 至少把 low-fix 记录分成“在 `gate.accepted` 链上”和“不在链上/未验证”两类，不要无标记地混在一起；或者只对链上记录展示原话，其余显示 `not-in-chain`。加一个“手写一条无复核点轮次的 low-fix，报告不能把它显示成已放行”的反向测试。

### 3. 低｜`scripts/model-review/opencode-review.mjs:892-896`、`:989-995`｜测试文件判定对 `.md` 大小写敏感，可用 `test/README.MD` 充当“测试改动”
【读代码证实】排除 Markdown 只检查小写后缀：

```js
export function isTestFile(path) {
  if (path.endsWith(".md")) return false;
  return (
    /(?:^|\/)(?:test|tests|__tests__)\//.test(path) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)
  );
}
```

`test/README.MD` 不满足 `endsWith(".md")`，但满足 `test/` 目录规则，因此会被当成测试文件；只要 `added > 0`，就能满足：

```js
!changes.some((change) => isTestFile(change.file) && change.added > 0)
```

【推测】实际利用需要有人用大写扩展名命名文档文件，概率低，但它确实能绕过“低档修改必须带测试文件新增行”的意图。

另外，文档第 35 行说“名字带 `.test.`、`.spec.` 的非 `.md` 文件”，代码的正则只认 JS/TS 扩展名（`.test.py` 等不认）。建议统一：用 `/\.md$/i`，并让文档和正则对 `.test.`/`.spec.` 的适用范围一致。

### 4. 低｜`scripts/model-review/opencode-review.mjs:1267-1278`｜`verdict-missing` 分支没有自动检查
【读代码证实】报告从记录自己的提交读 verdicts，读坏或缺失时走 `verdict-missing`：

```js
const text = gitStatus(["show", `${record.head}:${path}`], repo);
let verdicts = [];
try {
  if (text.status === 0) verdicts = parseVerdicts(text.stdout, path);
} catch {
  verdicts = [];
}
...
return `  ${printable(id)} ${verdict ? `...` : "verdict-missing"}`;
```

但在 `test/tooling/opencode-review.test.mjs` 里只看到“后续提交改了合法原话”的测试，没有“record.head 处 verdicts 格式坏/文件缺失，报告显示 verdict-missing”的用例。建议补两个反向用例：一是 `record.head` 有坏 JSON，二是 `record.head` 没有 verdicts 文件。

### 5. 低｜文档和实现没有完全同步
【读代码证实】
- `docs/adr/0174-cheaper-code-review-rounds.md:67` 仍写“并且带测试改动（只改文档的除外）”，没有写本轮的“测试文件必须非 `.md` 且有新增行、文件名不含换行”。
- `docs/engineering-casebook.md:5299` 写“每个文件不超过 30 行”，代码实际是 `added + deleted` 合计不超过 30 行；也没有写“非 `.md`、有新增行、文件名不含换行”。
- `.agents/handoffs/2026-11-06-review-cost-plan-v2.md:62` 仍把 `lastCompleteRound` 当作现行实现引用，但该函数本轮已删除。

建议：至少同步 ADR 0174 第 5 条和案例库的措辞；方案文件若定位为历史记录，可以不改，但最好标明“已被后续提交取代”。

---

## 侧重检查

- **错误路径**：`parseUsage`/`parseVerdicts` 对坏 JSON、重复 id、空字段会抛 `USAGE_LEDGER_INVALID`/`VERDICTS_INVALID`；`lowFixProblems` 对缺失 verdicts、缺失模型答案、坏原话分别返回 `verdicts-not-committed`、`quote-not-found`。主要残留问题是报告会列出不在链上的 low-fix（见发现 2）。另外，`coveragePoints` 遇到同一轮两个 `ok` 记录但 `head` 不同会抛 `REVIEW_ROUND_HEADS_DIFFER`，`--assert-reviewed`/`--report` 会以退出码 2 结束而不是干净的 `REVIEW_NOT_CURRENT`；这是上一轮已有的代码，但属于损坏账本时的错误路径。
- **不可信输入**：账本里的 `head`/`from` 用 40/64 位十六进制校验，不能注入 git 选项；`round` 要求正整数；`files`/`findings` 要求非空字符串；`singleLine` 拒绝所有换行。文件名换行在 low-fix 路径被 `file-name-has-line-break` 拒绝，报告用 `printable` 转义其他控制字符。发现 3 的 `.MD` 大小写是残留缺口。
- **安全**：本次改动没有放宽复核模型的只读权限；新字段不含密钥。账本本身没有签名，手写完整复核记录仍然是信任边界（规则也写明“防误操作，不防恶意 PR”）；本轮只对 low-fix 做了重核。
- **资源耗尽**：`gitStatus` 的 `maxBuffer` 是 `1 << 28`（256MB），`lowFixProblems` 会在 `from..to` 上跑 `git diff --numstat`；如果复核后产生超大改动，可能占用较多内存，但会被规模检查拒绝。`--report` 每个 low-fix 记录各跑一次 `git show`，数量受账本行数限制。
- **不可撤销操作**：`--accept-low` 直接 `appendFileSync` 写账本，没有自动撤销；不过记录在提交前只存在于工作区，且本轮新增“每轮最多一条”，误写后要改账本或回退，不能直接再接受一条。建议在规则或帮助里写明恢复方式。

---

## 作者说法逐条核对

- ✅ `summarizeEvents` 认 `type: "error"`、`outcome` 记 `api-error`；`apiErrorOf` 去控制字符并截到 300；`isRetryable` 为 true 或可解析的 `retry-after`（有限且 ≥0）算可重试。
- ✅ `reviewModel` 可重试服务错误后等 60 秒再跑一次 `reviewOnce`；两次费用相加；第二次 `ownLimit = costLimit - first.cost`；剩余钱不足 0.07 或时间不足时记 `no-budget`/`no-time`/`cost-unknown`，不重试。
- ⚠️ `substituteFor` 还要满足 `run.review.retry === "retried"`。也就是说，“DeepSeek 结果是可重试的 api-error”还不够，必须是脚本真的重跑过一次后才替补；钱/时间不够没重跑时不会替补。作者这句概括不完整，代码和详细规则一致。
- ✅ `parseArgs`：code-review 不传 `--previous` 且不传 `--round` 时必须两个模型；传 `--previous` 且不写 `--models` 时只跑 DeepSeek。
- ⚠️ “`coveragePoints` 从 `lastCompleteRound` 起”不准确：`lastCompleteRound` 已在本轮删除；现在 `coveragePoints` 生成所有轮次的点，由 `walkChain` 在“`both` 且 `previous === null`”处重置起点。对正常账本效果相同，但作者引用的函数已不存在。
- ✅ `assertReviewed` 要求每一点的提交是前一点的后续；low-fix 的 `from` 必须等于前一点提交，并重新跑 `lowFixProblems`，还比较 `files`/`findings`。普通轮次还要求 `previous` 不晚于前一点。
- ✅ `lowFixProblems` 核对 verdicts 已提交、格式、逐字原话、成立的 error 全是 low 且至少一条、规模和测试改动；本轮新增 `file-name-has-line-break` 和“测试文件必须有新增行”。
- ✅ `parseUsage` 对 low-fix 有额外校验；`nextRound`/`roundForRun` 通过 `NOTE_MODES` 排除 low-fix；`--report` 单列 low-fix。
- ⚠️ “测试 140 条全过、`npm run check`/`npm run build` 通过”未核实：本环境只允许 git 只读命令，不能运行测试或构建。
- ✅ 代码里已删除 `lastCompleteRound`；但方案文件仍有残留引用（见发现 5）。
- ⚠️ “规则文件和 ADR 0174 措辞同步”只部分成立：ADR 没有写本轮新增的测试文件/文件名细节，且 `--report` 原话来源的变化也没写进 ADR。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   - 对 **GLM**：会。lens 是 `buildPrompt` 固定段的一部分，本轮改了 GLM lens 文字，而 PR #263 第 1 轮 GLM 已经用旧文本跑过。若后续 GLM 替补，开头不再逐字节相同。
   - 对 **DeepSeek**：不会，DeepSeek lens 本轮没改。
   - 对**单次 prompt 内部**：仍然是“固定段 + `---- 本次材料 ----`”；`head`、`base`、`previous`、`brief` 都在材料之后，仍只在末尾追加。问题不是把会变的值挪到了开头，而是改了固定段的内容本身。
   - 依据：`scripts/model-review/opencode-review.mjs:182-183`、`:198-208`，`.agents/instructions/model-review.md:68`。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   新增逻辑没有引入按上下文变化的序列化、遮盖、时间字段或无序集合：lens 和 questions 是常量，材料值按固定顺序拼接，`new Date().toISOString()` 只写账本、不发给模型，`apiErrorOf` 的处理是确定性的。GLM 的问题是一次性的固定文本变更（问题 1），不是同一文本在不同请求里渲染成不同字节。

3. **有没有对应的自动检查，反向用例真的会失败？**
   - 有：`--accept-low` 的 `already-low-fixed`、`second-low-fix`、测试文件必须有新增行、`.md` 排除、文件名换行、报告从 `record.head` 读原话，都有正/反测试；按代码推演，这些反向用例在旧实现上确实会失败。
   - 缺：没有“新轮次 prompt 的固定段必须和历史轮次逐字节相同”的测试；新增的 lens 测试只是断言新词句存在。也没有 `verdict-missing` 的坏输入测试。
   - 未核实：测试实际运行结果和 140 条全过，因为本环境不能运行测试。

4. **每个新值的使用方都能接受吗？逐个核对结果：**
   - `low-fix` 的 `round`：`--accept-low` 写入正整数，`parseUsage` 校验正整数，`coveragePoints`/`report`/`nextRound`/`roundForRun` 都接受或正确排除。
   - `head`/`from`：写入 `git rev-parse HEAD`/前一点 head，`parseUsage` 校验 40/64 位十六进制；`walkChain` 用 `from === covered` 和 `isAncestor`，`lowFixProblems`/`report` 用作 `git show`/`git diff` 参数，不会注入 git 选项。
   - `files`/`findings`：由 `lowFixProblems` 重算后写入，`parseUsage` 要求非空字符串且无换行；gate 用 `sameList` 比对重算结果，report 用 `printable` 输出。两端能对上。
   - `cost: 0`、`mode: "low-fix"`、`at`：`spentOf`、`NOTE_MODES`、`parseUsage` 均接受。
   - `substitute: true`/`substituteFor`：`substituteFor` 写入完整模型名，`coveragePoints` 要求 `substituteFor === REVIEW_MODELS[0]` 且 `model === SUBSTITUTES[...]`，两端一致。
   - `apiError`/`retry`/`retriedAfter`：`apiErrorOf` 已去控制字符并截断，`parseUsage` 的 `singleLine` 再保证无换行；报告/账本不会因此坏掉。
   - `already-low-fixed`、`second-low-fix`、`file-name-has-line-break`：分别由 `assertReviewed`、`walkChain`、`lowFixProblems` 产生，由退出码/`low-fix-invalid`/拒绝原因消费，文档也列了这些名字。
   - 发现的两处端到端缺口：`--report` 不限制 low-fix 必须在 `gate.accepted` 链上（发现 2）；`.md` 判定大小写敏感（发现 3）。
