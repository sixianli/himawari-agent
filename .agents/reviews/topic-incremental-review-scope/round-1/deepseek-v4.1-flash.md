# 方案：把“增量范围”从提示词里的口头要求变成脚本算好、可核对的材料

一句话：增量轮不再让模型自己先跑 `git diff base..head` 找增量；脚本用与 `--assert-reviewed` 相同的口径算出“PR 自己、上一轮之后改了什么”，把这份小 diff、上一轮意见、main 合入说明和模型看不了的文件清单放到材料末尾；必答问题仍逐条回答，但“这个改动”明确指本轮增量。全量轮不变。

---

## 一、方案依赖的前提

| # | 前提 | 来源与原话 |
|---|------|-----------|
| P1 | 复核每轮是独立的新对话，固定前缀应逐字节不变，会变的内容只能放在最后的材料里 | `.agents/instructions/prompt-prefix.md:28`：“每轮都会变的内容只放在最后一条用户消息里。”；`:36`：“已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。”；`docs/adr/0270-faster-review-rounds.md:54`：“固定前缀和必答问题一字不改，所以所有轮次的前缀仍然逐字节相同” |
| P2 | 当前增量轮提示 **同时** 要求先看整个 PR 的 diff，再看增量 | `scripts/model-review/opencode-review.mjs:382`：`对比基准是 ${base}，先运行 git diff ${base}..${head} 看改动。`；`:387`：`上一轮复核到 ${previous}，这一轮先看 git diff ${previous}..${head} 的增量，只做三件事……` |
| P3 | `previous..head` 会把合入的 main 算进来；PR 自己的改动要用与 main 的合并基线来算 | `.agents/instructions/model-review.md:74`：“对每个文件，分别取该提交相对它与 `--main-ref` 的合并基线的 `git diff -U0 --binary --no-renames`……只是合入 main 带进来的文件差异不算改动”；脚本 `ownChangePrints` 在 `scripts/model-review/opencode-review.mjs:1604-1640` |
| P4 | 必答问题是从 `--base` 提交里读的，问的是“这次改动”整体 | `scripts/model-review/opencode-review.mjs:3110-3114` 从 `base ?? head` 读；`.agents/instructions/model-review.md:82-85` 四条问题原文 |
| P5 | 合并门禁的“复核过”判定也是按 PR 自己的改动逐文件比较，main 单独带进来的不算 | `.agents/instructions/model-review.md:74` 同上；脚本 `unreviewedFiles` 在 `scripts/model-review/opencode-review.mjs:1642-1650` |
| P6 | 业界增量复核确实只复核上次之后的新提交 | CodeRabbit：“Reviews the commits pushed since CodeRabbit's last review of the pull request.”、“focusing on the commits added since the last review. This keeps feedback timely without re-analyzing unchanged code.”（https://docs.coderabbit.ai/reference/review-commands、https://docs.coderabbit.ai/configuration/auto-review）；Anthropic：“Reviews scale with the PR. Large or complex changes get more agents and a deeper read; trivial ones get a lightweight pass.”（https://claude.com/blog/code-review） |
| P7 | 截图等生成文件已不随 main 走，改为一次性引用 | `docs/adr/0276-generated-files-stay-out-of-git-and-local-artifacts-expire.md:87`：“这类引用不在 `refs/heads/` 下，普通克隆、`git fetch` 和 CI 签出默认都不会下载它；它也不在任何分支的历史里，所以合并 PR 时不会带进 main。” |
| P8 | 模型只能读文件、搜索、用五条 git 命令，不能运行别的命令，也不能读图片内容 | `.agents/instructions/model-review.md:102`：“只开读文件、按内容搜索、按文件名找文件，以及 `git diff`、`git log`、`git show`、`git blame`、`git status`；改文件、别的命令、派子代理、仓库外的路径全部禁止。” |
| P9 | 本次材料给出的数据：16 个增量轮混进 main，`previous..head` 中位 4106 行而 PR 自己只有 41 行；PR 521 第 5 轮只改 1 行过滤和 1 句文档，仍调用 67 次、读大文件 19 次 | 本次材料“已核对的事实”（不是我从代码重新算的，标为外部事实） |

---

## 二、方案本身

### 2.1 改哪里

1. `scripts/model-review/opencode-review.mjs`
   - 新增 `incrementScope()`：算出本轮增量文件集合，口径直接复用 `unreviewedFiles(repo, previous, head, ledgerPath, mainRef)`，与 `--assert-reviewed` 完全一致。
   - 新增 `incrementBlock()`：生成材料里的增量段落，包含文件清单、PR 自己的 diff、main 重叠文件的 diff、二进制文件清单、统计。
   - `buildPrompt()` 增加一个 `increment` 参数，只在 `previous` 存在时把它放在 `---- 本次材料 ----` 之后。
   - 增量轮不再输出“先运行 `git diff base..head`”；改成“本轮范围就是下面的增量，不要先取整个 PR 的 diff”。
   - `previous && scope 为空` 时打印 `REVIEW_INCREMENT_EMPTY`，不花钱直接退出，提示线程去跑 `--assert-reviewed`（只合入 main、PR 自己没改的情况本来就不该再复核）。
   - 在 `usage.jsonl` 记录增量统计；失败/回退也记录原因。
2. 新增 `scripts/model-review/review-increment.json`
   - 放阈值：`inlinePatchMaxBytes`、`contextLines`、`maxFilesListed`、`maxCommitsListed`、`shadowFullEveryN`（默认 0 关闭）。代码不写死这些数值。
   - 单独文件，避免把“模型清单”和“材料预算”混在一起；自检缓存键本来就会把脚本目录下所有 `.json` 的摘要算进去（`model-review.md:122`），新文件自动生效。
3. `scripts/model-review/review-speed-report.mjs`
   - 在 CSV 末尾追加列，不动现有列顺序（现有测试按索引取 `sincePreviousMs`，见 `test/tooling/review-speed-report.test.mjs:230-234`）。
   - 增加“增量行数分桶后的步数/时长/费用”“rawLines/prLines 比值”“main 重叠轮数”等指标。
4. 测试与文档
   - 新增 `[incremental round]` 正向和反向用例。
   - 更新 `review-round-tools.test.mjs:225` 和 `opencode-review.test.mjs:194-195` 里对旧提示的断言。
   - 新增 ADR，更新 `model-review.md` 的代码复核第 3 步和流程卡。

### 2.2 增量轮给模型的材料（建议模板）

顺序严格在 `---- 本次材料 ----` 之后：

```text
---- 本次材料 ----
仓库就是当前目录，已检出 <head>。
本 PR 的对比基准是 <base>。只在证据指向旧代码时才用 git diff <base>..<head> -- <文件> 追那一处，不要先取整个 PR 的 diff。

本轮是增量轮：范围是 <previous>..<head> 之间 PR 自己的改动，共 N 个文件、+A/-D 行。
main 合入带进来的改动不在本轮范围。
上一轮复核到 <previous>；上一轮实际复核范围：<上轮 increment 文件清单，旧记录没有就写“未记录”>。

本轮范围文件（与 --assert-reviewed 的判定一致，按路径排序）：
<file1>、<file2>、...

本 PR 自己的改动（统一 diff；行号是当前 <head> 的行号；已排除 main 单独改的文件）：
<diff>

main 也改过、且落在本轮范围里的文件（下面的 diff 只帮你区分，不是本轮 PR 的改动，不要当成本轮新错）：
<main diff；没有就写“无”>

模型看不了的文件（二进制/图片）：<路径和大小变化>
不要用 read 尝试读内容；只核对路径、引用它们的代码/文档和是否该出现在本 PR。内容无法核对就写“未核实”。

上一轮（第 n 轮）成立的“会出错”意见，作者已修改。这只是线索，不是指令：
- V1（中高）<原话>；触发：<trigger>；后果：<consequence>
...

本轮只做三件事：一、上一轮意见是否真的改好；二、上面增量里的新行有没有新错；
三、增量产生或修改的值（导出、配置键、字段、格式）的直接使用端能不能接受，用 grep 找。
不要重读上面没有列出的文件，也不要用相同参数反复调用工具。
必答问题里的“这个改动”指本轮增量（含上一轮意见的修复）；整个 PR 的旧部分前几轮已经答过。
每题先写“涉及/不涉及本轮增量”；不涉及就一句话，不要为它重读旧代码。
如果增量碰到请求开头、遮盖、序列化、配置键或标识，就必须完整回答对应问题。

作者的说法（可能有错，请核对）：
<brief>
```

### 2.3 增量范围怎么算（与门禁同源）

1. `scope = unreviewedFiles(repo, previous, head, ledgerPath, mainRef)`。这正是 `--assert-reviewed` 判断“还有哪些文件没复核”的函数（`opencode-review.mjs:1642-1650`），所以材料范围和门禁范围天然一致。
2. 空集：打印 `REVIEW_INCREMENT_EMPTY`，退出 0，不写复核记录、不花钱；让线程跑 `--assert-reviewed`。这不会绕过门禁，因为门禁本来也会认为没有 PR 自己的改动。
3. 非空：`git diff previous..head -- <scope>` 取统一 diff。**不要**用 `git log --no-merges` 逐提交拼，因为合并提交里手工解决冲突写的内容也是 PR 自己的改动；`previous..head` 的树 diff 会把它包含进来。
4. 对每个 `scope` 文件，检查 `git diff <mb_prev>..<mb_head> -- <file>` 是否非空（`mb_prev`/`mb_head` 分别是 main 与 `previous`/`head` 的合并基线）。非空的列进“main 也改过”段，只用于区分，不算本轮范围。
5. 二进制：用 `git diff --numstat` 中 `-` 的行识别，或 `git check-attr` 看到 `-diff`；列进“模型看不了的文件”，不把二进制内容塞进文本 diff。
6. 预算：`available = 100000 - 固定前缀和其余材料的字节数`；`inlineBudget = min(config.inlinePatchMaxBytes, available)`。超预算时按路径排序逐文件加入，超出部分只列文件名和精确的 `git diff previous..head -- <file>` 命令，让模型按需取；不截断到半个 hunk。
7. 无法计算（`origin/main` 不存在、文件名含无效 UTF-8、`unreviewedFiles` 返回 null）：回退到当前“整个 `previous..head`”的行为并打印 `REVIEW_INCREMENT_FALLBACK <原因>`，记录到账本。宁可慢，不静默漏。
8. 材料生成后，用 `scopeSha256` 把“本轮范围文件 + 各自的 PR 自己 diff”摘要记进账本，供事后审计；门禁不依赖它，避免 main 前进后误报。

### 2.4 必答问题怎么处理

- **不改** `model-review.md` 里的四条问题原文（前缀逐字节不变，P1/P4）。
- 在材料里把“这个改动”重新定界为“本轮增量 + 上一轮意见的修复”，并明确旧部分前几轮已经答过。
- 每题要求先写“涉及/不涉及本轮增量”。涉及就给证据；不涉及就一句话，不重读旧代码。
- 第四问仍然强制：增量里新出现或修改的导出、配置键、字段、格式，必须用 grep 找直接使用端。这里仍然把判断交给模型，不提供关键词表；只是把“范围”缩小到增量。
- 如果增量碰到请求开头、遮盖、序列化、配置或标识，四问必须完整回答，不能以“不涉及”带过。

### 2.5 合并 main 怎么处理

- 用 `ownChangePrints`/`unreviewedFiles` 的口径，main 单独改的文件直接不在 `scope` 里，不进入材料。
- main 和 PR 都改过的文件才进入 `scope`；这些文件的 `previous..head` diff 会混入 main 的改动，所以额外给一段“main 也改过”的 diff，并明确“这不是本轮 PR 的改动”。
- 合并提交里手工解决冲突写的内容会出现在 `previous..head` 的树 diff 里，属于 PR 自己的改动，保留在范围内，不需要 `--remerge-diff`。
- 只合入 main、PR 自己没改：`scope` 为空，直接 `REVIEW_INCREMENT_EMPTY`，不复核。
- 如果 `origin/main` 不在分支里或取不到，回退到整个 `previous..head` 并记录原因；合并门前本来也要求 main 已合入。

### 2.6 截图等模型看不了的文件怎么处理

- 新流程下截图按 ADR 0276 走 `refs/review-artifacts/...`，不进入 main，所以正常 PR 不会再因为截图触发代码复核轮（P7）。
- 如果 PR 里仍然出现二进制/图片文件：材料只列路径、大小变化和“模型看不了”；明确要求不要用 `read` 尝试读内容，只核对引用它的代码、文档、alt 文本、路径是否合理；内容未核实就写“未核实”。
- 二进制内容是否正确的最终判断仍由线程/Andy 的设计验收负责，不由复核模型冒充。若一轮里**只有**二进制改动、没有任何可读文本改动，是否还花钱跑模型，见“需要人拍板”第 2 项。

### 2.7 配置与账本字段

配置 `scripts/model-review/review-increment.json` 建议：

```json
{
  "inlinePatchMaxBytes": 48000,
  "contextLines": 3,
  "maxFilesListed": 80,
  "maxCommitsListed": 40,
  "shadowFullEveryN": 0
}
```

账本新增可选字段（只在 `mode: "code-review"` 且 `previous` 存在时写）：

```json
"increment": {
  "files": 3, "added": 12, "deleted": 4,
  "commits": 2, "merges": 1, "binary": 0,
  "rawFiles": 120, "rawLines": 4106,
  "mainOverlapFiles": 1,
  "inlineBytes": 1800, "truncated": false,
  "fallback": null,
  "scopeSha256": "<64 hex>"
}
```

所有值都是单行、无控制字符；数值为非负安全整数；`scopeSha256` 为 64 位十六进制。

### 2.8 怎样测量效果和防止漏检

**测量（用现有 `review-speed-report.mjs`，加 `--cut` 对比）：**
- 增量轮步数、`runMs`、费用按“增量行数”分桶：0–10、11–50、51–200、201+ 行；看是否随行数增长，而不是固定在 37 步/580 秒。
- `rawLines / (added+deleted)`：衡量 main 污染被排除了多少。目标是接近 1，而不是 4106/41。
- `mainOverlapFiles`、`merges` 的轮次占比。
- 增量轮成立的中高意见数、其中落在增量改动行附近的比例；用于确认没有为了快而少报。
- `REVIEW_NOT_CURRENT`、`chain-broken`、`REVIEW_INCREMENT_FALLBACK` 的次数。
- 落地后按 ADR 0270 的做法，用接下来至少 5 个从头到尾走新流程的 PR 对比轮数、步数、时长、费用。

**防漏检：**
- 材料范围 = 门禁范围（同一个 `unreviewedFiles`）。再加一道自检：如果 `scope` 非空但材料没有覆盖某个 scope 文件，直接 `REVIEW_INCREMENT_SCOPE_MISMATCH` 拒绝开跑，不花钱。
- 保留“直接使用端”检查和四条必答问题；增量碰到接口/配置/格式时强制完整回答。
- 抽样“影子全量复核”：按 `shadowFullEveryN`（配置，默认 0）对少量增量轮在同一个 head 上另跑一次全量复核，记录在单独的审计账本，不进入本 PR 的复核链；比较两次找到的中高意见，衡量漏检。前 5–10 个 PR 建议开启一次。
- 每轮要求模型写“查过哪些范围”；线程判断时如果发现中高意见落在增量之外，记录下来，作为跨模块影响的证据。
- 对“上一轮意见是否改好”，把 `trigger`/`consequence` 一并放进材料，减少模型为了理解意见而重新探索。

---

## 三、考虑过但不选的做法及原因

| 做法 | 不选原因 |
|------|----------|
| 只把提示里“先运行 `git diff base..head`”删掉，其他不动 | 能减轻，但模型仍要自己找 `previous..head`，仍会把 main 合入算进来；16 个污染轮次不会消失（P2/P3、本次材料事实）。 |
| 只改提示词，让模型“不要重读旧代码” | 数据说明已经这样要求过（`opencode-review.mjs:387`），但 30 行增量仍 37 步；模型没有可靠的“范围”边界。 |
| 沿用 `git diff previous..head` 原样给模型，让它自己忽略 main | 本次材料显示 16 轮里 `previous..head` 中位 4106 行、PR 自己 41 行；模型分不清，必答问题又把范围拉回整个 PR。 |
| 复用同一个 opencode 会话跑多轮 | ADR 0270 已否决：上一轮几十次读文件都进上下文，更贵，还会锚定旧结论（`0270:83`）。 |
| 降低推理强度 | ADR 0175 已否决，会漏错误路径；且约束要求只用 DeepSeek V4.1 Flash 高推理。 |
| 增量轮不回答必答问题 | 直接降低发现能力，违反“必答问题照样回答”的既定要求。 |
| 用关键词表/正则自动找使用端 | 约束明确“理解意思交给模型，不写关键词表”；误报漏报都难控制。 |
| 写死“最多 N 步/N 轮” | 违反“不写死数值”；且会把合法的跨模块检查截断。 |
| 只用 `--accept-low` 放行小改动 | 会绕过中高问题的复核，降低检出；现有 `--accept-low` 也有规模和测试文件限制。 |
| 每次增量都重跑全量 | 回到问题本身，且与业界增量复核做法相反（P6）。 |
| 把截图转成 base64/视觉输入 | 只用 DeepSeek V4.1 Flash，当前复核工具链没有视觉输入；且会大幅增加 token。 |

---

## 四、风险和反例

1. **跨模块影响漏看**：增量只改了一行，但 main 同时改了一个使用端，合并后才出错。缓解：保留第四问和 grep 检查；材料给出“main 也改过、且在本轮范围里”的文件；模型怀疑时允许用 `git diff base..head -- <文件>` 追旧代码。反例：如果 main 改的是另一个文件里的使用端，且不在 scope 里，模型看不到；这是本方案最大的风险，需要影子全量复核抽样确认。
2. **main 重叠文件的 diff 仍混入 main 改动**：材料里同时给 PR diff 和 main diff，靠模型区分。反例：两边改同一段代码，模型可能把 main 的 hunk 误报成 PR 的新错。缓解：明确标注“main diff 只用于区分”，并在 `increment.mainOverlapFiles` 记录，供线程抽查。
3. **范围计算回退**：`origin/main` 缺失、文件名无效 UTF-8、`unreviewedFiles` 返回 null 时回退到整个 `previous..head`，可能又慢又混入 main。反例：回退时正好 main 合入很大，本轮仍接近全量。缓解：打印 `REVIEW_INCREMENT_FALLBACK`，线程知道原因；合并前先 fetch main。
4. **模型过度信任材料里的 diff，不打开文件**：材料里的 diff 是 git 生成的，但上下文只有几行；复杂的消费者可能藏在文件其他位置。缓解：材料要求“证据指向旧代码时跟下去”，第四问要求 grep；输出格式仍要求引用代码。
5. **提示预算**：diff + brief + 上一轮意见超过 100000 字节会 `PROMPT_TOO_LARGE`。缓解：按配置预算截断，超出部分只给文件名和精确命令；不静默丢。
6. **旧分支没有新配置**：在途 PR 的分支里没有 `review-increment.json`。缓解：缺失时回退到当前行为并打印 `INCREMENT_CONFIG_MISSING`，下次合入 main 后自动生效；不阻塞现有 PR。
7. **二进制/截图轮次**：如果只有截图改动，模型只能写“未核实”，这一轮可能仍要花几分钟。是否干脆不跑模型，见拍板项 2。
8. **确定性**：`git diff` 受用户 git 配置、locale、路径排序影响。缓解：脚本侧用固定 `-c` 覆盖、`LC_ALL=C`、显式 `--no-color --no-ext-diff --no-textconv --no-renames`、路径排序；同一轮重跑用 `promptSha256` 校验。
9. **配置/账本字段的使用端**：新增字段如果被 `parseUsage`、`delegate.mjs check`、`review-speed-report` 的某一端拒绝，会导致账本整体不可读。下面第 4 问逐项核对。

---

## 五、需要人拍板的取舍

1. **增量 diff 是内联进提示，还是只给文件清单让模型自己取？** 建议内联，阈值放配置；超过预算才回退到文件清单 + 精确命令。内联省工具调用和时间，代价是输入 token。
2. **只有截图/二进制改动时，是否还跑模型？** 方案 A：照跑一个很小的轮次，模型只核对引用并写“内容未核实”，门禁照常算这一轮；方案 B：不跑模型，由线程/Andy 做人工视觉验收并记录，门禁需要新增一种“人工验收记录”。方案 B 更快，但改动合并门禁语义，需要 Andy 定。
3. **要不要做“影子全量复核”抽样？** 建议前 5–10 个 PR 开一次，用单独审计账本，不进入复核链；这会多花约一次全量轮的钱和时间。
4. **必答问题是改原文，还是在材料里重新定界？** 建议不改原文（前缀稳定、无需改门禁和测试），只在材料里定界。
5. **增量极小时是否加“步数上限”？** 建议先不加；靠精确材料自然减少步数。若实测仍高，再把上限放进配置，作为下一轮优化。
6. **main 重叠文件很多时**：是继续逐文件给 main diff，还是直接建议平安夜跑一次全量？建议设一个配置上限，超过就只列文件并提示线程考虑全量轮。

---

## 六、必答问题逐条回答

### 1. 会不会改变模型已经见过的请求开头？

**不会。** 本方案不改系统提示、工具定义、历史消息和遮盖结果。所有新增内容（增量文件清单、PR diff、main 重叠 diff、二进制清单、上一轮意见的触发/后果）都放在 `---- 本次材料 ----` 之后，即本次请求的最后一条用户消息里；同一轮内后续只有工具结果追加，符合 `prompt-prefix.md:28` 和 `:36`。同一 PR 的各轮固定前缀（角色、工具、任务、四条必答问题、模型侧重、输出格式）逐字节不变；会变的 `head`、`previous`、增量、意见都只在材料里。会加一条测试：全量轮和增量轮在 `---- 本次材料 ----` 之前的字节完全相同，且增量块只出现在标记之后（现有同类测试在 `test/tooling/opencode-review-merge-gate.test.mjs:1487-1510`）。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**按下面的实现不会；不这样实现就会。** 关键规则：
- 文件清单、main 重叠文件、二进制文件都按路径排序；提交列表用固定拓扑顺序；上一轮意见按现有“中高优先、再按 id”的确定顺序（`opencode-review.mjs:421-443`）。
- 不写时间、日期、绝对路径、临时目录、随机数到材料里。
- 脚本侧 git 调用固定 `-c core.quotepath=... -c diff.noprefix=false -c diff.mnemonicPrefix=false`，并设 `LC_ALL=C`、`--no-color --no-ext-diff --no-textconv --no-renames`；去掉 `index` 行，保留 `@@` 行号。
- 同一段文字不依赖它后面的消息做遮盖：发给模型的材料本来就不遮盖；写进仓库的存档才遮盖（`model-review.md:124`“发给模型的材料不遮，只遮写进仓库的记录”），所以发送字节不受后续消息影响。
- 同一轮重跑时，`promptSha256` 必须相同；新增测试会对同一个 fixture 连算两次、并打乱输入文件集合的插入顺序，要求摘要一致。

### 3. 有没有对应的自动检查，反向用例会不会真的失败？

会，计划加这些：

| 检查 | 正向 | 反向用例（必须失败） |
|------|------|----------------------|
| 增量提示只给增量 | fixture：main 合入 500 行、PR 自己改 1 行；提示含这 1 行、不含 main 的 500 行、不含 `先运行 git diff base..head` | 去掉 scope 过滤、退回 `git diff previous..head`，测试必须报出 main 的行 |
| 材料范围 = 门禁范围 | 对 fixture 比较 `unreviewedFiles(previous, head)` 与提示里的文件清单 | 手工从清单删一个文件，必须触发 `REVIEW_INCREMENT_SCOPE_MISMATCH` |
| 固定前缀不变 | 全量提示与增量提示在材料标记前逐字节相同 | 把增量说明塞进固定前缀，测试必须失败 |
| 确定性 | 同一输入两次生成摘要相同；文件集合换插入顺序仍相同 | 注入时间戳或依赖 `readdir` 顺序，测试必须失败 |
| main 重叠区分 | 文件同时被 main 和 PR 改过时，材料同时有 PR diff 和 main diff，并标注“main 不是本轮” | 只给合并后的 diff 而不标 main，测试必须失败 |
| 二进制处理 | 图片文件只出现在“模型看不了”清单一节，不被当作文本 diff | 把二进制内容塞进文本 diff，测试必须失败 |
| 空增量 | 只合入 main 时打印 `REVIEW_INCREMENT_EMPTY`、不写记录、不花钱 | 仍然开跑或写一条假复核记录，测试必须失败 |
| 配置校验 | 合法 `review-increment.json` 通过；缺失时回退并打印 `INCREMENT_CONFIG_MISSING` | 类型错误、负数、超大预算必须 `INCREMENT_CONFIG_INVALID` |
| 账本字段 | 新 `increment` 字段能被 `parseUsage`、`ledgerLine`、`delegate check`、`review-speed-report` 接受 | 字段带换行、负数、非十六进制 `scopeSha256` 必须被拒 |
| 现有链/门禁 | 增量轮仍能接上 `--previous` 链；`--assert-reviewed` 仍按 PR 自己的改动判断 | 制造冲突解决或 main 重叠改动，门禁必须报 `unreviewed`，不能因为材料变快而放行 |

现有测试要同步改：`test/tooling/review-round-tools.test.mjs:225-238`、`test/tooling/opencode-review.test.mjs:172-197`、`test/tooling/opencode-review-merge-gate.test.mjs:1487-1510`。

### 4. 每个新值，产生处和使用处两端都能接受吗？

| 新值 | 产生处 | 使用处 | 两端核对 |
|------|--------|--------|----------|
| `review-increment.json` 的键 | 新文件 | 新 loader、`incrementBlock`、自检缓存 | loader 校验类型/上下限；缺失时回退旧行为；自检缓存键按现有规则包含脚本目录所有 `.json`（`model-review.md:122`） |
| `increment.files/added/deleted/commits/merges/binary/rawFiles/rawLines/mainOverlapFiles/inlineBytes` | `incrementScope`/`incrementBlock` | `parseUsage`、`ledgerLine`、`delegate.mjs check`、`review-speed-report`、`--report` | 全部非负安全整数；`parseUsage` 加可选校验；`delegate check` 只读已知字段、忽略新增字段；报表在 CSV 末尾加列，不破坏现有索引 |
| `increment.truncated/fallback` | 同上 | 同上、线程排错 | `truncated` 布尔；`fallback` 为短字符串或 null；`ledgerLine` 先遮盖再序列化，嵌套字符串也能处理（`opencode-review.mjs:3269-3285`） |
| `increment.scopeSha256` | `incrementScope` | 账本、审计、测试 | 只允许 64 位十六进制；不被门禁依赖，避免 main 前进后误报 |
| `REVIEW_INCREMENT_EMPTY` / `REVIEW_INCREMENT_SCOPE_MISMATCH` / `REVIEW_INCREMENT_FALLBACK` / `INCREMENT_CONFIG_INVALID` | `incrementScope`/loader | 脚本退出码、流程卡错误表、测试 | 每个错误码都有对应反向用例；`REVIEW_INCREMENT_EMPTY` 不写记录，门禁仍按原规则判断 |
| 增量材料块 | `buildPrompt` | OpenCode 请求、`promptSha256`、`promptFileSha256`、`delegate.mjs check` | 同一轮重跑摘要一致；`delegate check` 用 `promptFileSha256` 核对存档（`delegate.mjs:337`）；新增测试覆盖 |
| CSV 新列 | `review-speed-report.mjs` | 测试、数据文档、人工分析 | 只追加在末尾；现有测试 `review-speed-report.test.mjs:90-97,230-234` 的索引不变；数据文档写明新列 |
| 上一轮意见的 `trigger`/`consequence` | 已提交的 `verdicts.jsonl` | `priorFindingsBlock`、材料 | 只读已有字段；缺失时退回只写原话；长度仍受 6000 字节/20 条/160 字上限（`opencode-review.mjs:398-444`） |

I-73 的教训是“值只在一端认”：这里最危险的是把 `increment` 字段写进账本，但 `parseUsage` 或 `delegate check` 不认；所以新字段必须同时改生产者、解析器、报表和测试，并用一个 malformed 账本用例证明坏字段真的会被拒。

---

## 七、哪些是读代码/来源证实的，哪些是推测

**证实：**
- 当前增量提示确实先要求 `git diff base..head`（`opencode-review.mjs:382`），再要求看增量（`:387`）。
- `unreviewedFiles`/`ownChangePrints` 已实现“按 PR 自己相对 main 的逐文件改动”判断，且 `--assert-reviewed` 用它（`opencode-review.mjs:1604-1650`、`model-review.md:74`）。
- 必答问题从 `base` 读，且是四条整体问题（`opencode-review.mjs:3110-3114`、`model-review.md:82-85`）。
- 账本解析允许未知字段，但会拒绝换行、负数、坏格式（`opencode-review.mjs:2120-2196`）；`ledgerLine` 会递归遮盖（`:3269-3285`）。
- CodeRabbit 和 Anthropic 的增量/按规模复核做法（P6 两个网址的原文）。
- 截图已按 ADR 0276 改走一次性引用（P7）。

**推测（未实测）：**
- 采用本方案后增量轮能从约 37 步/580 秒降到约 10–15 步/2–4 分钟；这是按“减少重复取 diff 和重读大文件”推算的，必须用落地后的 `review-speed-report.mjs` 实测。
- 模型看到精确增量后不会再去取整个 PR diff；仍需用归档提示词和 `toolCalls` 实测确认。
- main 重叠文件和冲突解决在实际 PR 中占比不高；如果很高，方案会退化成“接近全量”，需要影子抽样确认。
- 二进制-only 轮次的比例和截图是否仍会进 PR，取决于 ADR 0276 的落地范围；未核实所有在途 PR。
