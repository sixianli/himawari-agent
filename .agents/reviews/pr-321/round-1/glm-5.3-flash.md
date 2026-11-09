# PR 321 复核报告（第 1 轮，独立复核）

## 侧重检查（流程与覆盖）

我走的流程：
- **流程 A（合并闸门）**：线程完成一轮双模型复核 → 记账 → 合入 main → `--assert-reviewed`。入口 `assertReviewed`（opencode-review.mjs:1309）→ `walkChain` → `unreviewedFiles`（:1356）→ `ownChangePrints`（:1269）。主干由三条新测试覆盖（opencode-review.test.mjs:2790、2805、2819）。
- **流程 B（low-fix）**：`--accept-low` → `assertReviewed:1398` → `lowFixProblems:1119`，其中 `mainRef` 过滤是新加的（:1149-1153）。**没有任何测试覆盖「low-fix 范围内夹了一次 main 合入」的组合**。
- **流程 C（override 记录匹配）**：assertReviewed:1389 改用 `unreviewedFiles`，沿用旧测试（:3302 附近）。
- **无测试覆盖的路径**：`ownChangePrints` 返回 null 的三个退路（merge-base 失败 :1271、name-only 失败 :1274、单文件 diff 失败 :1282）、`tree:` 兜底分支（:1289-1294）、二进制/纯空白/删除/改名文件、无效 UTF-8 文件名。

## 发现（按严重度）

### 1.【中】二进制文件的改动会被判成“没变”（漏报）
- 文件：scripts/model-review/opencode-review.mjs:1278-1294
- **读代码证实的**：对每个文件跑 `git diff -U0` 再喂给 `git patch-id --stable`（:1278-1289），脚本没有对二进制文件做任何特殊处理。git 对二进制文件的文本 diff 只输出固定的一行 `Binary files a/f and b/f differ`，不含任何文件内容。
- **推测（依据 git patch-id 的文档与实现行为，本次未能运行验证）**：stable patch-id 对 patch 文本（含 `diff --git a/f b/f` 与 Binary 标记行）哈希、忽略空白与行号。若标记行参与哈希，则**同一路径的任何二进制内容变化都得到同一个指纹**——复核后再改二进制文件（手改、换构建产物）闸门静默放行。若标记行不参与哈希，则 patch-id 为空、走 `tree:` 兜底，反而安全。
- 建议：diff 输出不含任何 `+`/`-` 内容行时不使用 patch-id，直接用 `ls-tree` 比较两端 blob；并补一条“复核后改二进制必须报 unreviewed”的反向测试定论。

### 2.【中】纯空白/缩进的手改漏报，且规则文字与实际行为不一致
- 文件：scripts/model-review/opencode-review.mjs:1283-1289；.agents/instructions/model-review.md:44
- **读代码证实的**：`git patch-id --stable` 是唯一指纹。规则文档只声明“行号和上下文不参与”。
- **推测（git 文档行为）**：`--stable` 还忽略空白量——合并时只改缩进、去尾随空格、tab↔空格的手改会得到相同指纹，被判“没变”。文档承诺“PR 自己的改动变了仍要求复核”，这里不成立，且文档没披露。
- 建议：文档补“空白量也不参与”；若要防，自拼指纹（对 `+`/`-` 行原文逐行哈希，仅去掉 `@@` 行号）。

### 3.【中低】文件名含无效 UTF-8 字节时，指纹退化为常量 `tree:`（漏报）
- 文件：scripts/model-review/opencode-review.mjs:1250-1252、1273-1279、1289-1294
- **读代码证实的**：`spawnSync(..., encoding: "utf8")`（:1251）把 `--name-only -z` 的字节流解码成字符串，无效字节被替换；替换后的字符串被当作 `:(literal)` pathspec（:1279）再交给 git，字节对不上 → diff 输出为空 → patch-id 为空（:1289）→ `ls-tree` 同样匹配不到、输出为空 → 指纹是常量 `tree:`（:1293）。两端同样退化 → 相等 → 报“没变”。
- 这条是代码路径推演，未用真实文件验证。建议：`ls-tree` 输出为空时按“算不出指纹”处理，退回旧的全量比较（保守方向）；或 name-only 改用 Buffer。

### 4.【低】旧账本的 low-fix 记录可能新报 `low-fix-invalid files-differ`
- 文件：scripts/model-review/opencode-review.mjs:1317-1338（重算）、1149-1153（过滤）、1342-1348（判链断）
- **读代码证实的**：`lowFixCheck` 用新口径重算 `check.files`，与记录里的 `files` 逐一比较。若历史 low-fix 范围内夹过一次小的 main 合入，旧口径记录的 `files` 含 main 带入的文件，重算后不含 → `files-differ` → 链断、闸门拒绝。
- 影响：只影响“夹过 main 合入且当时通过了旧规模核对”的既有记录，是否存在需查真实账本（**未核实**，本 PR 夹具里无此形状）。建议排查现有账本，或在文档标注。

### 5.【低】low-fix 的行数上限仍按 from→to 全量 numstat 计
- 文件：scripts/model-review/opencode-review.mjs:1145-1155
- **读代码证实的**：文件级过滤用了 `ownFiles`（:1153），但每文件行数仍来自 `diff --numstat from to` 的全量计数。PR 与 main 都动过的文件会把 main 的行也算进 30 行上限 → 误拒（安全方向）。文档第 3 步只写“只合入 main 带进来的文件不计”，没说共享文件的行数含 main 的改动。建议文档补一句，或改用相对合并基线的 numstat。

### 6.【信息】误报：main 抢先合入了与 PR 相同的改动
- 文件：scripts/model-review/opencode-review.mjs:1305-1306
- **读代码证实的**：`unreviewedFiles` 取两侧指纹 Map 的并集，键缺失视为不同。若 main 在合并前已带上 PR 的同一改动（无冲突“吞掉”），current 侧该文件不在 names 里 → 键缺失 → 报 `unreviewed`，要求多复核一轮。方向安全，但与“只是合入 main 不再复核”的目标有出入，可接受；作者清单里问的“被 main 吞掉会不会漏报”——结论是**不会漏，反而会误报**。

### 7.【信息】测试覆盖缺口与小的代码卫生问题
- **读代码证实的**：新增测试只覆盖干净合入放行、手改拦截、冲突拦截三例；二进制、纯空白、删除/改名、无效文件名、low-fix×main 组合均无反向用例。`unreviewedFiles`（:1299）被导出但测试没有直接引用。`unreviewedFiles` 早退路径返回未排序数组（:1301）、正常路径排序（:1306），无实际危害。

## 作者说法核对
- “指纹不同的文件才报 unreviewed / 算不出基线退回全量差异”——**证实**（:1271、:1274、:1282、:1301、:1304）。
- "lowFixProblems 和覆盖记录的新旧判断改用 unreviewedFiles 口径”——**证实**（:1149、:1389）。
- “规则文字已同步”——**大体证实**（model-review.md:44 与代码一致），但漏了“空白也不参与”（发现 2），且文档只写了“算不出合并基线”一种退路，代码还有“单文件 diff 失败”的退路（文档略窄）。

## 必答问题

1. **不会改变请求开头。** 本次改动全部位于合并闸门逻辑（assertReviewed/lowFixProblems/unreviewedFiles/ownChangePrints，opencode-review.mjs:1119-1440）与规则文字，未触碰任何组装系统提示、工具定义、历史消息的代码；`--assert-reviewed` 本身不调用模型。发给模型的内容仍只在末尾追加（新增的 `.agents/reviews/pr-321/briefs/round1-code-review.md` 属记录目录材料，是新文件），每轮会变的值（时间戳等）不涉及。
2. **不会。** 新逻辑只在本地跑 git 命令，结果进终端输出与退出码；`patch-id --stable` 对同一提交对确定；未新增带时间字段（low-fix 记录的 `new Date().toISOString()` 在 ：1425，是原有代码未改）；没有把无序集合序列化给模型。
3. **有自动检查，主千反向用例会失败。** 3 条新测试 + 2 处期望更新；“合后手改”（:2812-2813）与“冲突异解”（:2825-2826）两个反向用例确实会被拦。但漏报类反向用例缺失：按发现 1、2 的分析，二进制/纯空白改动今天会被放行——即反向用例若补上，现在会“失败”（闸门拦不住），说明检查本身没盖住。low-fix 的 `mainRef` 过滤完全没有测试。
4. **逐值核对通过，有两处文档偏差。** 新参数 `mainRef`：三个调用点都传（:1324、:1413，默认 `origin/main` 保持），`lowFixProblems` 在 `mainRef` 缺省时退回旧口径（:1149），两端校验一致；`unreviewedFiles` 导出但无外部使用方（无危害）；指纹格式（patch-id 十六进制 / `tree:` 前缀）仅在脚本内部比较；无新配置键/清单项。规则文字与代码基本一致，例外见发现 2 与“作者说法核对”最后一条。**未核实**：真实仓库现有账本中是否存在发现 4 的记录形状。
