## 复核范围

- 已按 `8731c77..6e4ed67` 看全量，并按 `208e995..6e4ed67` 看第 3 轮增量。
- PR 387 实际是 3 个提交（`5056af7`、`208e995`、`6e4ed67`）；`8731c77` 与 `5056af7^` 之间还夹着 PR 380 合并带来的大量无关改动，我没有把它们当作本 PR 的内容。
- 受 sparse checkout 和复核记录保护限制，`.agents/reviews/pr-387/round-2/judgments.md` 读不到，标「未核实」。
- 环境里没有 `node_modules`，且只允许 git 命令，所以没有实际运行 `npm test` 或 biome；下面关于测试会失败/通过的说法来自读代码推断，标「未核实运行结果」。

## 发现：读代码证实的

### 低 1：I-55 的事故记录删掉了本次真正的修复内容

- 位置：`docs/incidents-and-gates.md:92`
- 问题：第 3 轮把 I-55“方案”列里唯一一句关于 biome 豁免的话改没了，也没有在任何地方记下 `owner-rule-live.eval.ts` 的 Authorization 改动。代码实际有两处修复：`biome.json` 豁免生成 JSON、评测脚本改成运行时拼 `Bearer`，但事故记录现在只写了 pre-push 跑两个检查。以后的人照 I-55 看不到为什么 `evals/owner-rule`、`evals/memory-capture` 要豁免，也不知道 `check:secrets` 误报是怎么消掉的。
- 证据（当前文件第 92 行）：
  > “第 4 次后推送钩子再加两步：`scripts/git-hooks/pre-push` 运行 `scripts/check-format.mjs`（`npm run format:check` 现在也用它）和 `scripts/scan-machine-secrets.mjs`，失败或脚本缺失就报 `PUSH_FORMAT_CHECK_FAILED`、`PUSH_SECRET_SCAN_FAILED` 并拦下推送”

  同文件别处没有提豁免；代码里是 `biome.json:37-38` 的 `"evals/owner-rule/*.json"`、`"evals/memory-capture/*.json"`，以及 `scripts/evals/owner-rule-live.eval.ts:22` 的 `const API_KEY = process.env["EVAL_API_KEY"]?.trim() || "proxy-injected";`。
- 建议：在 I-55“方案”列补回：biome 仅豁免这两个目录下评测脚本用 `JSON.stringify` 写出的 JSON，其余 `evals/` 仍检查；`owner-rule-live.eval.ts` 的 Authorization 改为运行时拼装，源码中不再静态出现 `Bearer` 加假值；门槛补上 `test/tooling/layer0-hooks.test.mjs` 本次新增的两条用例。

### 低 2：EVAL_OUT 可改到别处，但豁免只覆盖两个固定目录

- 位置：`scripts/evals/owner-rule-live.eval.ts:23`、`scripts/evals/memory-capture-live.eval.ts:19`、`biome.json:37-38`
- 问题：两个评测脚本都允许 `EVAL_OUT` 改输出目录，而 biome 只豁免 `evals/owner-rule/*.json` 和 `evals/memory-capture/*.json`。默认路径正好覆盖，但如果有人把 `EVAL_OUT` 指到 `evals/owner-rule/latest`、`evals/memory-retrieval` 之类的位置，生成的 JSON 就不再被豁免，下一次 `format:check` 会重新变红。这正是 I-73 那类“产生方和使用方各校验一半”的缺口。
- 证据：
  - `owner-rule-live.eval.ts:23`：`const OUTPUT_DIRECTORY = process.env["EVAL_OUT"] ?? "evals/owner-rule";`
  - `memory-capture-live.eval.ts:19`：`const OUTPUT_DIRECTORY = process.env["EVAL_OUT"] ?? "evals/memory-capture";`
  - `biome.json:37-38` 只列这两个固定目录的 `*.json`。
- 建议：把生成结果固定写到专门的、被忽略或明确豁免的子目录（例如 `evals/*/generated/**`），或者让评测脚本自己输出 biome 兼容格式后删掉豁免；至少要在文档里写清 `EVAL_OUT` 只能指向已豁免目录，并在测试里覆盖一次非默认输出路径。

### 低 3：新测试没有覆盖评测脚本的真实输出文件名

- 位置：`test/tooling/layer0-hooks.test.mjs:193-212`
- 问题：测试名说“formats hand-kept eval data but not the JSON the eval scripts write”，但 `evals/memory-capture` 用的是 `run.json`，这个文件名评测脚本根本不会写。真实输出是 `partial-A-0.json` 和 `<时间戳>.json`。如果以后有人把豁免改成只匹配 `result.json`、`run.json` 之类的文件名，这个测试仍会通过，而真实评测跑完后 `format:check` 会红。另外豁免是按目录的，未来放进这两个目录的手写 JSON 也会被静默跳过格式检查，测试名表达的“手写数据会格式化”并不成立。
- 证据（第 197-199 行）：
  > `const loose = '{"a":[1,\n2]}\n';`
  > `write(root, "evals/owner-rule/result.json", loose);`
  > `write(root, "evals/memory-capture/run.json", loose);`

  真实输出见 `scripts/evals/memory-capture-live.eval.ts:277` 的 `partial-${arm}-${run}.json` 和 `:305` 的 `${stamp}.json`。
- 建议：测试改用真实文件名，例如 `evals/memory-capture/partial-A-0.json` 和一个形如 `2026-11-11T02-36-25-792Z.json` 的文件；如果确实只想豁免生成文件，考虑按文件名而不是整个目录豁免。

### 低 4：`EVAL_API_KEY` 空串回退没有自动检查

- 位置：`scripts/evals/owner-rule-live.eval.ts:22`
- 问题：本次行为变化是“空串或全空白回退到 `proxy-injected`”，但没有对应测试。以后有人把它改回 `??`，所有现有检查都不会红。
- 证据：
  > `const API_KEY = process.env["EVAL_API_KEY"]?.trim() || "proxy-injected";`
- 建议：把读取逻辑抽成可单测的小函数（输入 `undefined`、`""`、`"   "`、`" key "`），补 4 条断言；不必真的发请求。

## 推测 / 未核实

- **pre-push 会把本地未提交的评测结果也扫进密钥检查（推测）。** `scripts/scan-machine-secrets.mjs:21` 用的是 `git ls-files -z --cached --others --exclude-standard`，会包含未跟踪文件；`evals/memory-capture` 没有被 `.gitignore` 忽略，而 `test/fixtures/memory-capture-eval/dataset.json` 里有假 `ghp_...` 且 baseline 只按该文件的路径登记。如果 memory-capture 评测的模型输出把假令牌带进候选结果，生成的未跟踪结果 JSON 会被当成新命中并拦下推送。是否真会触发取决于模型输出，我没有实际运行，标推测；建议考虑 pre-push 只扫即将推送的提交或忽略评测生成目录。
- **真 biome 测试的上层配置/Git 忽略影响（已检查，当前不构成问题）。** 测试把仓库根 `biome.json` 复制到临时根目录，并以临时根目录为 `cwd` 运行，因此即使 biome 向上找配置也会先命中临时根；仓库配置没有开启 `vcs`，临时目录也没有 `.git`，所以当前不会受上层 `.gitignore` 影响。未核实的是 `BIOME_CONFIG_PATH` / `BIOME_*` 这类外部环境变量，仓库和 CI 配置里没搜到，测试也没有隔离它们。
- **真 biome 测试依赖已安装的 `@biomejs/biome`。** 缺 `node_modules` 时它会因 `spawnSync` 失败而红，而不是 skip；测试套件本身需要依赖，所以我认为这不是缺陷，但属于环境依赖。

## 侧重检查

- **错误路径**：`scripts/check-format.mjs:7-9` 在缺 biome 时打印 `FORMAT_CHECK_UNAVAILABLE` 并退出 1；`:11-13` 把 biome 的退出码原样传出，`spawnSync` 出错时退 1。`scripts/git-hooks/pre-push:8-15` 对 format/secret 两步都用 `|| { echo PUSH_…; exit 1; }`，脚本缺失时 node 自身退非零也会被拦下，且测试分别覆盖“失败”和“缺失”两种反向路径。
- **不可信输入/安全**：`EVAL_API_KEY` 只用于请求头，`trim()` 只会去掉首尾空白，空或全空白回退到原来的 `proxy-injected`；没有日志输出密钥。改动后的源码静态文本不再出现“Bearer + 12 字符以上假值”的形状，`authorization-bearer` 和 `credential-assignment` 两条正则不会命中（我按 `scan-machine-secrets.mjs` 的规则逐条套过）。
- **资源耗尽**：pre-push 每次对整个工作树跑一次 `biome format .`，这是本次设计接受的成本；`format .` 不带 `--write`，是只读检查。`scan-machine-secrets.mjs` 逐文件整读并跑正则，是原有行为，本次只是把它接到 pre-push。
- **不可撤销操作**：没有。format 检查不写文件；新测试只写 `os.tmpdir()` 下的临时目录，`afterEach` 用 `rmSync` 清理。
- **规则与文档一致性**：`.claude/rules/prompt-prefix.md` 不受影响；I-55 记录和代码的偏差见“低 1”。
- **排除范围**：默认输出覆盖是正确的，见下面必答问题 4；其他评测脚本没有往 `evals/` 写 `.json`（`memory-retrieval-eval/live.mjs` 写 `.ci-output` 和 `evals/memory-retrieval/history.jsonl`；`calibration-report/report.mjs` 写 `.md` 和 `.jsonl`；`jarvis-test/live.mjs` 写 `.ci-output`）。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 本 PR 的 3 个提交没有碰生产侧的系统提示、工具定义、历史消息或遮盖逻辑；`owner-rule-live.eval.ts` 只改了 `Authorization` 头的取值方式（`owner-rule-live.eval.ts:22`），请求体的 `messages` 仍是原来的固定 system + 当前用例 user，且每个用例是独立请求。生产侧“只在末尾追加、每轮变化的值在最后一条消息”的现状没有被这次改动移动或改写。

2. **不会让同一段文字在不同请求里变成不同字节。** 没有新增依赖前后文的遮盖，也没有把时间、随机值、无序集合放进模型请求。`EVAL_API_KEY` 在进程启动时读一次，只进请求头；评测结果文件里的 `spentUsd`、时间戳文件名会变化，但那些是本地证据文件，不会发给模型，也不进对话历史。

3. **biome/check-format/pre-push 部分有自动检查，反向用例结构上会失败；`EVAL_API_KEY` 部分没有。**
   - 豁免测试：去掉两条 override，`generated.status` 会变成非零，第一次断言失败；把豁免改回 `evals/**/*.json`，`kept.status` 会变成 0，第二次断言失败。两个方向都卡住了。
   - check-format 测试：假 biome 会核对参数 `format .` 和退出码 3；缺 biome 用例核对 `FORMAT_CHECK_UNAVAILABLE`。
   - pre-push 测试：分别覆盖 format/secret 脚本失败和缺失，旧钩子上这些用例会失败。
   - 没有测试的是 `EVAL_API_KEY` 空串回退，见“低 4”。实际运行结果未核实（环境无法跑测试）。

4. **逐项核对产生方与使用方：**
   - `evals/owner-rule/*.json`：产生方 `owner-rule-live.eval.ts:23` 默认目录 + `:212` 写 `result.json`；使用方 `biome.json:37`。匹配。
   - `evals/memory-capture/*.json`：产生方 `memory-capture-live.eval.ts:19` 默认目录 + `:277` 写 `partial-<arm>-<run>.json`、`:305` 写 `<stamp>.json`；使用方 `biome.json:38`。匹配。
   - 其他 `evals/` 下的 JSON（`evals/memory-retrieval/*.json`）仍被格式检查；我读了 `candidates-qwen3-embedding-8b.json`，它看起来是 biome 风格（短对象/数组内联），但我没有实际跑 biome，最终是否通过标「未核实」。
   - `FORMAT_CHECK_UNAVAILABLE`：产生方 `check-format.mjs:8`，使用方测试 `layer0-hooks.test.mjs:214-218`，匹配。
   - `format:check` 命令：产生方 `package.json:75`，使用方 `check:steps`（`package.json:27`）和 pre-push `:8`；两者只关心退出码，匹配。
   - `PUSH_FORMAT_CHECK_FAILED` / `PUSH_SECRET_SCAN_FAILED`：产生方 pre-push `:9`、`:13`，使用方测试和 I-55 文档，匹配。
   - 唯一没有两端对齐的是 `EVAL_OUT` 可改目录（产生方可写任意位置，豁免只认两个固定目录），见“低 2”。
