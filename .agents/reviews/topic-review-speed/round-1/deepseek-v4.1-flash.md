# 结论

根因不是“DeepSeek 太慢”，而是四件事叠在一起：

1. **增量轮没有真正增量**：模型拿不到上一轮的判断，提示还要求每次查“调用方、被调用方、每个使用端”，所以增量轮步数≈首轮（中位 53 vs 57）。
2. **实际请求头每轮都在变**：OpenCode 1.19.5 的系统提示里带 `Working directory`/`Workspace root folder`，而脚本每轮用随机 `mkdtemp` 目录；固定用户提示前缀再稳，服务端也命不中跨轮缓存。文档里“DeepSeek 的提示词开头每轮逐字节相同”的说法只对脚本拼的那段用户提示成立，对真实请求不成立。
3. **低意见的机械放行门槛卡住约 15% 的轮次**：`--accept-low` 写死 5 文件/30 行，测试文件只认 JS/TS 和 `test/` 目录，`.agents/test_opencode_models.py` 这种 Python 测试直接不认。
4. **plan-claims 让模型自己穷举“现状说法”**：条数 21–63 波动、约 70% 被判 model-wrong、只认 HEAD，导致“本 PR 删掉的旧代码原来如何”永远找不到。

我建议的方案是：**先冻结请求头，再做有状态的定向增量；低意见门槛动态化；plan-claims 改成“线程给清单、模型只核对”**。第一轮全量复核的拦截面不变；增量轮只验证“上一轮意见是否修好 + 本次修改直接产生/修改的值的直接使用端”。按给出的数据估算，常规 PR 可以从 3.7 轮/约 78 分钟降到约 2 轮/40–50 分钟，Claude 侧费用约减半；这是推算，需要用 5–10 个 PR 实测。

---

# 一、方案依赖的前提

| # | 前提 | 来源与原话 | 状态 |
|---|---|---|---|
| P1 | 每轮是新的 opencode 会话，只有 wrap-up 续用 `--session` | `scripts/model-review/opencode-review.mjs:834-847`：`...(session ? ["--session", session] : [])`；`:1076`：`const session = wrapUp ? sessionOf(first.stdout) : null;` | 读代码证实 |
| P2 | 用户提示分“固定前缀”和“本次材料”，材料在最后 | `:354-365` `const fixed = [...]`；`:366-377` `const material = [...]`；`:378` ``return `${fixed}\n\n${material}\n`;`` | 读代码证实 |
| P3 | 当前增量提示要求查调用方、被调用方、每个使用端 | `:371`：“复核增量和它直接影响的代码：调用它的地方、它调用的地方、它产生或修改的值的每个使用端。” | 读代码证实 |
| P4 | 增量轮步数≈首轮；79% 增量中高落在刚改过的行 | `docs/assets/review-cost/2026-11-13-data.txt:14-15`：“带 `--previous` 的增量轮 312 轮，中位 53 步……第 1 轮 122 轮，中位 57 步”；“增量轮的步数和费用与第 1 轮几乎一样”。79% 来自本次材料 | 账本数据来自本次材料；ADR 数据已读 |
| P5 | `--accept-low` 写死 5 文件/30 行；测试文件只认 JS/TS 与 test 目录 | `:1162-1163` `LOW_FIX_MAX_FILES = 5`、`LOW_FIX_MAX_LINES_PER_FILE = 30`；`:1169-1174` `isTestFile` 正则只匹配 `.test/.spec.[cm]?[jt]sx?` 和 `test/tests/__tests__` 目录 | 读代码证实；`.agents/test_opencode_models.py` 存在但不被认 |
| P6 | plan-claims 只认 HEAD，且让模型自己列说法 | `:3422-3432` `claimsBlobAt(..., commits.head, ...)`；`plan-claims.mjs:161-170` `blobAt(repo, head, place.path)`；`plan-claims.mjs:173-192` 只处理新增 ADR | 读代码证实；21–63/70% 来自本次材料 |
| P7 | 每次真实运行前跑自检，约 70 秒 | `:3507-3523` `selfCheck`；本次材料：“开跑前自检每轮约 70 秒” | 读代码证实 |
| P8 | OpenCode 1.19.5 的系统提示含工作目录、工作区根、日期；脚本用随机目录当 cwd | OpenCode v1.19.5 `packages/opencode/src/session/system.ts`：`Working directory: ${ctx.directory}`、`Workspace root folder: ${ctx.worktree}`、`Today's date: ${new Date().toDateString()}`（https://raw.githubusercontent.com/sst/opencode/v1.19.5/packages/opencode/src/session/system.ts ）；脚本 `:849` `cwd: copy`，`:3486-3487` `mkdtempSync(...)`、`copy = join(workRoot, "repo")` | 读源码证实 |
| P9 | KV 缓存按请求开头逐字节匹配 | DeepSeek 文档：“If subsequent requests have overlapping prefixes with previous requests, the overlapping part will only be fetched from the cache”（https://api-docs.deepseek.com/guides/kv_cache ）；`.claude/rules/prompt-prefix.md:27-28,35,51` | 读来源证实 |
| P10 | 业界把复核聚焦在改动上、用置信度过滤、拆小改动 | Anthropic 官方 code-review 插件：“Bug detection focused on changes (not pre-existing issues)”“Filters out issues below 80 confidence threshold”（https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/plugins/code-review/README.md ）；Google Small CLs：“Reviewed more quickly”“Less likely to introduce bugs”（https://google.github.io/eng-practices/review/developer/small-cls.html ） | 读来源证实 |

补充一个文档与代码不一致的点：`.agents/instructions/model-review.md:108` 和 `docs/adr/0175-cheaper-code-review-rounds.md:62` 都写“DeepSeek 的提示词开头每轮逐字节相同”，但这只是 `buildPrompt` 拼的用户提示；真实请求的系统提示含随机 cwd，因此跨轮缓存并不成立。

---

# 二、方案

## 0. 先冻结真实请求头（P0，不改变任何复核判断）

**做法**

- 给每个 PR/topic 一个固定的复核工作目录，例如：
  `~/.cache/himawari-review-workspaces/<repo-hash-12>/<pr-编号或 topic>/repo`
- 每次仍然做干净克隆，但克隆到同一个路径；用完删除内容，路径字符串不变。`workRoot` 继续用随机目录放 gateway/probe/guard，只有 `copy` 固定。
- 目录权限 0700，先 `rmSync` 再 `mkdir`，拒绝符号链接；同一路径加锁（`openSync(lock, "wx")`），并发跑同一个 PR 时明确报 `REVIEW_WORKSPACE_BUSY`，不要静默换路径。
- 日期每天变一次是 OpenCode 系统提示的固有字段，跨午夜会失效一次；这点先接受，或在升级 OpenCode 时再处理。

**为什么**

- `ctx.directory`/`ctx.worktree` 来自 `cwd: copy`，`copy` 之前是随机 `mkdtemp` 路径。路径一变，系统提示第一段就变，后面全部按全价重算。固定路径后，同一 PR 的各轮系统提示逐字节相同（除日期），用户提示的固定前缀也相同，跨轮缓存才真正可用。
- 这一步不改变模型看到的复核内容，也不改变合并门槛，风险最低。

**自动检查**

- 用现有的假模型服务器抓请求：跑两次不同 `head`/`brief` 的复核，断言系统消息和工具定义逐字节相同，用户提示在 `---- 本次材料 ----` 之前逐字节相同。
- 反向用例：故意让两次 `cwd` 不同，断言检查失败（证明这个门槛真的能失败）。
- 在 `REVIEW_RESULT` 或新增 `REVIEW_CACHE` 输出 `cacheRead`、`input`、命中率、`gatewayTiming.cacheMisses`/`missTokens`，让缓存是否真的改善可见。

## 1. 有状态的定向增量轮（P0）

**做法**

1. **把上一轮判断回灌给模型**，放在 `material` 里（`previous` 行之后、`text.materialTitle` 之前），不动 `fixed`：
   - 从 `git show <head>:<ledger>/round-<上一轮>/verdicts.jsonl` 读已提交的判断，而不是读工作区；
   - 找出 `usage.jsonl` 里 `head === previous` 的那个 code-review 轮次；找不到就只写一行固定说明“上一轮判断文件不可读，未纳入”；
   - 每条一行：`id | 模型 | class | severity | quote`，`valid:false`/`better` 再加 `why`；按 `id` 排序；长度截断固定；用固定规则遮盖，避免依赖会移动的 `origin/main` 登记值。
2. **改增量提示**（仍然只改 `material`，不改固定前缀）：
   - “先看 `git diff previous..head`；只复核这段增量、上一轮每条中高意见是否修好、以及本次修改产生/修改的值在增量范围内的直接使用端。不要重读增量外、行为没被改变的代码；证据指向增量外时再跟过去。上一轮已判不成立或可以更好的意见，除非这段增量改了相关代码或给了新证据，不要再报。”
   - 这把当前 `:371` 的“每个使用端”收窄为“本次修改产生/修改的值的直接使用端”，直接针对 79% 的新中高落在刚改过的行。
3. **给 `verdicts.jsonl` 增加可选的 `file`/`line`**，由子代理填写，脚本校验：
   - `--judge-skeleton` 先写空值；
   - `parseVerdicts` 只在字段存在时校验：非绝对路径、无 `..`、无换行/控制字符、行号为正整数；
   - `finishRound` 用 `showAt(repo, head, file)` 检查文件存在、行号不越界，否则 `FINISH_ROUND_REFUSED location-invalid <id>`；
   - 老记录没有这两个字段仍然合法，保持向后兼容。
4. **不做的事**：不复用同一个 opencode 会话。会话复用会把上一轮几十次工具结果全部重读，上下文膨胀、成本更高，还会让模型锚定在上轮结论上。

**收益**

- 模型从“重新发现整个 PR”变成“验证上一轮意见 + 检查本次修改”，步数应明显下降；
- 子代理不用再手工从 `judgments.md` 里回忆上一轮判过什么，判断成本也下降；
- 第一轮仍然是全量复核，拦截面不变。

## 2. 修 `--accept-low` 的机械阻塞（P0）

**做法**

- **动态识别测试文件**，不再写死 JS/TS：
  - 读仓库的 `vitest.workspace.ts`、`vitest.config.*`、`package.json` 的 test 脚本、`pyproject.toml`/`pytest.ini`/`tox.ini`/`setup.cfg` 里的 test globs；
  - 兜底规则至少包含 `test_*.py`、`*_test.py`、`test/`、`tests/`、`__tests__/`、`*.test.*`、`*.spec.*`，这样 `.agents/test_opencode_models.py` 能被认出来；
  - `.md` 仍然不算测试。
- **低意见规模上限不要直接放宽**。先保持 5 文件/30 行，但把它从代码常量移到 `review-models.json`（或单独的 `review-policy.json`）并校验，方便 Andy 调整；更精确的做法是要求 low-fix 只改被 low verdict 的 `file:line` 所指的文件/行，超出就要求再复核一轮。后者依赖第 1 步新增的 `file`/`line`，可以作为一个可选的下一步。
- **不改**“每轮最多一条 low-fix”和“第二次 low-fix 拒绝”的规则，这两条防的是把多次修改合在一起逃避复核。

**收益**

- 直接消掉“Python 测试不被认”这一类误拒；按材料中 15% 的轮次估算，约 97 轮可以不再跑，单 PR 平均省约 10 分钟。

## 3. 收敛规则：旧代码意见不再自动触发下一轮（P1，需 Andy 拍板）

**做法**

- 第 2 轮起，新出现的中高意见只有在**落在 `previous..head` 的实际改动行**，或者属于**安全/凭据/不可逆/文档与代码不符**这几类时，才自动触发下一轮。
- 只落在未改动旧代码的中高，列入报告“前几轮漏掉的旧问题”，交给 Andy 决定是否修、是否合并，不自动再跑一轮。
- 判断用的是真实的 `git diff -U0 previous..head` 行区间，不是写死的 ±8；没有 `file`/`line` 的意见按“中高”处理，保持“拿不准按中高”。
- 如果 Andy 同意，可给 `--finish-round` 增加 `SCOPE new-on-changed=N old-code=M`，并在 `N==0 && M>0` 时打印 `NEXT stop-andy`（新的 NEXT 值，不是 `--report` 的 stop reason），流程卡按这个值交回主线程。

**为什么**

- 79% 的增量中高本来就在刚改过的行，定向验证能拦住；剩下 21% 在旧代码，是前几轮漏掉的，继续用全量重审去追，回报低、轮数不收敛。
- 这不是降低严重度标准，而是改变“哪些意见自动再跑一轮”的停止规则；需要 Andy 明确同意。

## 4. plan-claims：线程给清单，模型只核对（P1，需 Andy 拍板）

**做法**

- 线程在写 ADR 时同时提交一份 claims 清单，放在 `.agents/reviews/topic-<短名>/claims/<adr-slug>.jsonl`（在 reviews 目录下，不进入复核副本、不算 PR 未复核文件）：
  `{"id":"C1","file":"packages/x/src/y.ts","line":42,"sentence":"…","ref":"<可选提交>"}`
- 脚本从 `head` 读清单，嵌入 `material`；模型只对清单里的 `id` 逐条给“一致/不一致/找不到”，不再自己穷举。这样条数固定，21–63 的波动消失。
- 账本记录增加 `claimsIndex` 路径和 `claimsIndexSha256`；`parseUsage` 的 `claimsValid` 校验两者；`claimsProblems` 要求 ADR 哈希和清单哈希都匹配，否则 `claims-stale`。
- `ref` 用于“本 PR 删掉的旧代码原来如何”：脚本用 `blobAt(repo, ref, file)` 核对，要求 `ref` 是 40/64 位提交哈希且是 `head` 的祖先；没有 `ref` 时退回 `head`。这直接解决 PR 423/481/485/491 那类“只认 HEAD 永远找不到”的问题。
- 模型答案里的 `CLAIM` id 必须与清单完全对应：缺 `claims-missing`、多 `claims-unknown`。这比现在“只能验证列出的，不能验证漏列”强，脚本第一次能检查漏列。
- 现有 ADR 的旧记录没有清单仍然可读；新 ADR 是否强制清单，由 Andy 决定。

## 5. 自检缓存与观测（P2）

- 自检的静态探针套件按“opencode 版本 + 锁文件摘要 + `reviewConfig(mode)` + 平台 + `realGit`/`realBash` 的 stat + gateway 安装摘要”缓存到 `~/.cache/himawari-review-selfcheck/`，权限 0700；
- 每次仍然跑最小 canary：一条允许的 git 命令、一条写文件拒绝、一条读仓库外拒绝、项目指令不加载；
- 缓存文件有 schema/version，键不匹配或文件损坏就重跑全套；反向用例：改配置或换二进制 stat 必须 miss；
- 这样省掉每轮约 70 秒，同时保留“环境变了会重跑”的安全边界。

---

# 三、考虑过但不选的做法

- **复用同一个 opencode 会话跑多轮**：上一轮几十次工具结果会全部重读，上下文膨胀；模型还会锚定上一轮结论。省下的文件读取不值得。
- **降推理强度**：ADR 0175 已明确不选，会漏错误路径。
- **每轮都跑两个模型**：默认一个 DeepSeek 是 Andy 2026-11-12 定的；两个模型只增加成本，不解决轮数和步数。
- **直接删掉低意见、不判断**：会漏掉被判错的中高，ADR 0263 已否决。
- **写死“最多 N 轮”或“±N 行”**：违反“不写死数量和阈值”；改用真实 diff 行区间和动态配置。
- **把改动范围外的意见自动删掉**：会漏掉跨模块影响；改为只改变“是否自动再跑一轮”，意见仍进报告。
- **只按模型自评置信度过滤**（Anthropic 插件的 80 分阈值）：思路对，但本项目的“低/中高”已经是可解释的严重度，再叠一层未校准分数会多一处误杀，而且改输出格式会动固定前缀；先不做。
- **让模型输出机器可读清单**：会增加输出、改输出格式；改为让 Claude 在 `verdicts.jsonl` 里填 `file`/`line`，不碰提示前缀。
- **手工改 OpenCode 去掉日期/环境块**：升级或打补丁成本高；固定 cwd 已能解决主要变量，日期每天一次可接受。

---

# 四、风险与反例

1. **锚定和范围收窄**：修一个共享 helper 时，真正的后果可能在增量外的旧调用方。
   - 缓解：定向范围必须包含“本次修改产生/修改的值的直接使用端”；涉及导出符号、配置 schema、序列化格式时，用 `git grep` 把全部使用端纳入；安全/凭据/不可逆/文档不符永远阻塞，不看位置。
2. **边缘输入被误降级**：材料里的 `https:/user:token@host`、`//user:tok@/p`、手写账本只有替补记录、启发式假阴性。
   - 如果 Claude 把它们判为中高，但引用行不在本次改动，规则 3 会把它们转成“旧代码意见”交给 Andy，而不是自动再跑。
   - 缓解：安全/凭据类强制阻塞；保留“拿不准按中高”；Andy 抽查报告。
3. **去重误匹配**：同一句话在不同代码位置重复出现。
   - 缓解：只有 `file`/`line` 所指的行在 `head` 逐字节相同、且 `file` 路径相同，才允许沿用旧判；否则重新判断。
4. **`--accept-low` 认出了测试文件，但测试没覆盖修复**：
   - 现有规则本来也只检查“测试文件有新增行”，已经是一个弱保证；不要把它宣传成强保证。缓解：保留 `trigger`/`consequence`/`why` 字段，`--report` 列出，Andy 抽查。
5. **plan-claims 清单漏列**：脚本现在能检查“列出的都有”，仍不能保证“没漏”。
   - 缓解：加一条确定性检查，把 ADR 里所有 `path:line` 形式和反引号里的标识符抽出来，要求清单覆盖；模型可以另给一节“未列入的可疑说法”，只作提示、不阻塞。最终完整性仍由 Andy 负责。
6. **自检缓存过期**：环境变了但键没变。
   - 缓解：键包含二进制 stat、配置、平台、gateway 安装摘要；每次跑最小 canary；缓存文件损坏就重跑。
7. **固定工作目录的路径安全**：路径可预测，理论上可被预放符号链接。
   - 缓解：0700、先删再建、拒绝符号链接、加锁、每次仍是干净克隆、用完删除；威胁模型是防误操作，不防本机恶意用户。
8. **收敛规则放走真问题**：这是最大的风险。
   - 需要 Andy 拍板；如果他不接受，就只做 0/1/2/5，不改停止规则。

---

# 五、需要人拍板的取舍

1. **是否采用“旧代码意见不自动再跑一轮”**（第 3 节）。这是提速最大、风险也最大的一项；不采用的话，预计只能省 30–40% 而不是接近一半。
2. **`--accept-low` 的规模上限和测试要求**：只修 Python 测试识别，还是同时把 5 文件/30 行改成动态/可配置？后者会改变放行边界。
3. **plan-claims 是否改成“线程给清单”**：这会改变写 ADR 的流程；是否只对新增 ADR 强制、旧 ADR 保持现状。
4. **是否接受固定工作目录**：路径可预测带来的本机安全取舍；以及是否顺手升级 OpenCode 把日期/环境块挪到末尾。
5. **是否先花 5–10 个 PR 做 A/B 实测**（对比 `cacheRead`、步数、轮数、费用），再决定是否扩大。复核预算仍在每个 PR 的先问线内，但需要 Andy 同意这个试验范围。

---

# 六、已证实 vs 推测/未核实

**读代码或来源证实的**

- 每轮新会话、固定/材料分离、增量提示原话、`--accept-low` 限制、`isTestFile` 正则、plan-claims 只认 HEAD、自检位置：都在上面给了文件:行。
- OpenCode 1.19.5 系统提示含随机 cwd/worktree/日期：读了 v1.19.5 的 `system.ts` 源码。
- DeepSeek 前缀缓存规则、Anthropic 插件置信度/只看改动、Google 小 CL 的做法：给了一手网址和原话。
- 文档里“提示词开头每轮逐字节相同”与真实请求不符：文档行和源码行都在上面。

**来自本次材料、我未在仓库账本复核的**

- 178 个 PR、665 轮、3.7 轮/中位 3、21 分钟/轮、8–12 分钟 DeepSeek、97 轮 accept-low 失败、79% 落在 ±8 行、21–63 条、64 model-wrong/27 plan-fixed。
  原因：`.agents/reviews` 没有检出，`git show` 对 records 路径被 guard 拒绝（`REVIEW_GIT_REFUSED records-path`），我无法直接读账本。

**推测/需要实测的**

- 定向增量能把增量轮步数从 47/53 降到多少；估计 25–35，未实测。
- 固定 cwd 后 DeepSeek 经 Magpie 的缓存命中率能到多少；源码证明请求头会稳定，但服务端缓存行为要实测。
- 15% 的 accept-low 失败里，规模超限、没测试、Python 测试各占多少；材料没有拆开，我只确认了 Python 测试确实不被认。
- 预计的时间/费用降幅是外推，不是实测。
- 跨午夜日期变化的影响没有实测。

---

# 七、逐条回答必答问题

## 1. 这个改动会不会改变模型已经见过的请求开头？

**我的改动本身：不会。** 新增的上一轮判断、`previous`、`head`、`base`、`brief` 全部放在 `buildPrompt` 的 `material` 里（`:366-377`），固定前缀（角色、工具、任务、`FOCUS_SENTENCE`、必答问题、侧重、输出格式，`:354-365`）一字不动；`file`/`line` 只写进 `verdicts.jsonl`，不进提示。每轮会变的值都在本轮唯一的初始用户消息（最后那条 user 消息）里。

**但现状已经不满足这条规则。** OpenCode 1.19.5 的系统提示包含 `Working directory: ${ctx.directory}` 和 `Workspace root folder: ${ctx.worktree}`，脚本又每轮把 `cwd` 设成随机 `mkdtemp` 目录（`:849`、`:3486-3487`）。所以真实请求的开头每轮都在变，文档里的“每轮逐字节相同”只对脚本拼的用户提示成立。方案第 0 节把工作目录固定后，才真正满足“只在末尾追加、会变的值在最后一条消息”；日期每天变一次是残余，跨午夜会失效一次。

## 2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？

**按方案做，不会；但实现时要守住几条：**

- 上一轮判断从 `head` 的已提交文件读，不读工作区；排序按 `id`，字段顺序固定；不写时间、随机数、绝对临时路径。
- 遮盖用固定规则；不要依赖会随 `origin/main` 移动的“已登记测试假值”，否则同一段文字在不同轮次可能遮成不同字节。可以只用 `base` 提交的登记值，或对这一块不做登记值遮盖。
- 列表不用 `Set`/对象遍历顺序；文件列表、模型列表都显式排序。
- `parseVerdicts` 已经拒绝任何含换行的 verdict，新增 `file`/`line` 也要保持单行、无控制字符。
- 固定工作目录消除每轮随机 cwd 的字节变化；日期仍是每天一次的变化，已知且可接受。

## 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

现有检查只有 `test/tooling/opencode-review.test.mjs:163-188`（固定前缀 vs 材料）和 `opencode-review-merge-gate.test.mjs:2401-2409`（有无 `--previous` 固定前缀相同），都是正向用例，且只测 `buildPrompt`，不测真实请求的系统消息。方案要补：

- **请求头门**：用假模型服务器抓两次不同 `head`/`brief` 的真实请求，断言系统消息 + 工具定义 + 用户提示在材料分隔线之前逐字节相同；反向用例故意换 `cwd`，必须失败。
- **回灌确定性**：同一份已提交 `verdicts.jsonl` 两次生成相同字节；行序打乱后输出相同；verdict 里带换行时 `parseVerdicts` 必须抛 `VERDICTS_INVALID`；文件缺失时走固定兜底行。
- **`--accept-low`**：`test_*.py` / `*_test.py` 必须被认；把测试改动删掉必须报 `REVIEW_LOW_FIX_REFUSED no-test-change`；`test/README.md` 仍然不算。
- **plan-claims**：模型给出清单里没有的 id 必须 `claims-unknown`，漏给必须 `claims-missing`；`ref=base` 的“已删除代码”必须通过；`ref` 不是 `head` 祖先必须失败；清单哈希不匹配必须 `claims-stale`；没有清单的新 ADR 必须 `claims-index-unchecked`。
- **`finishRound`**：`file`/`line` 指向 HEAD 不存在的文件或越界行必须 `FINISH_ROUND_REFUSED location-invalid`。
- **自检缓存**：同键命中；改配置/换二进制 stat 必须 miss；冷缓存必须跑完整套；最小 canary 每次都必须跑。

反向用例要真的放在测试里并能在旧实现上失败，不能只写正向断言。

## 4. 改动产生或修改的每个值，每个使用它的地方都能接受吗？

逐个核对两端：

| 值 | 产生处 | 使用处 | 两端校验 |
|---|---|---|---|
| 上一轮 `priorFindings` 块 | 脚本从 `head` 的 `round-<n>/verdicts.jsonl` 读 | `buildPrompt` 的 `material`；模型 | 只读已提交文件；`parseVerdicts` 校验格式；缺失时固定兜底；不新增账本字段 |
| `verdicts.jsonl` 的 `file`/`line` | `--judge-skeleton` 写空值，子代理填 | `parseVerdicts`、`finishRound`、`lowFixProblems`、`deferredLowLines`、`judgments.md` | `parseVerdicts` 允许缺省；`finishRound` 校验文件存在、行号范围；老记录不受影响；`delegate.mjs` 不解析 verdicts |
| `review-models.json` 新键（如 low-fix 上限、test globs） | 配置文件 | `readReviewModels`、`reviewModelsProblems`、`LOW_FIX_*` 导出、`lowFixProblems`、测试 | 新键必须在 `reviewModelsProblems` 里校验，否则坏配置会静默生效；`delegate.mjs` 只导入模型列表，不受影响；若新增 CLI 参数，必须同时改 `parseArgs`、`delegate.reviewArgv`、`validateTask`、`COMMAND_OPTIONS`，否则交接会被 `ARG_UNKNOWN`/`DELEGATE_UNKNOWN` 拒 |
| `claimsIndex` 路径 + `claimsIndexSha256` | 线程提交清单；脚本读 `head` | `parseUsage.claimsValid`、`claimsProblems`、`assertReviewed` 的 `claims.files`/`claimsOwned`、`recordSecretProblems` | 路径必须在 `.agents/reviews/` 下（`validClaimsFile` 明确拒绝 `.agents/reviews/`，所以需要单独的 index 校验）；必须在 `head` 存在；哈希 64 位且与记录一致；在 topic 目录下会被 `recordSecretProblems` 递归扫到；旧记录没有这两个字段仍可解析 |
| claim 的 `ref` | 线程写清单 | `claimEvidenceProblem` | 必须是 40/64 位提交哈希，且 `merge-base --is-ancestor ref head`；`file`/`line` 在 `ref` 的树里存在；没有 `ref` 退回 `head`；这与 I-73 的“清单 id 能不能过后端校验”是同一类检查 |
| `selfCheck` 缓存键/文件 | 脚本 | 主流程 | 键包含版本、锁摘要、配置、平台、二进制 stat、gateway 安装摘要；schema 不匹配就重跑；缓存不在仓库里 |
| `REVIEW_CACHE` 输出 | `resultLine`/`report` | 子代理、主线程、测试 | 只从现有 `summary.usage` 和 `gatewayTiming` 派生，不改账本 schema；`--report` 读账本时仍能算 |

**I-73 的直接回答**：不能只看“产生处”。例如新增 `claimsIndex` 路径，如果只改 `parseArgs` 而不把它加进 `claimsProblems` 返回的 `files`，`--assert-reviewed` 可能把它当未复核文件；如果只改 `parseUsage` 不校验哈希，改清单不会触发 `claims-stale`；如果新增 `NEXT stop-andy` 而 `code-review-round.md` 和 `reviewReport` 不认，线程会停在无指令状态。这些都要在测试里覆盖。

---

**一句话建议**：先做第 0、1、2、5 节（不改停止规则、不改 plan-claims 流程），它们风险低、能拿到大部分时间和费用收益；第 3、4 节等 Andy 拍板后再上。
