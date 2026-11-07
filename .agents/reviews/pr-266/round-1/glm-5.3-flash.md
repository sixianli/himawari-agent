Regex vs 实际 bootstrap 格式核对完毕（三行都带尾逗号、名字都是 `[a-z-]+\.js`，当前能匹配）。下面核对 I-79 的门槛和 incident-gates 检查。
## 复核发现（按严重度从高到低）

1. **中** · `scripts/check-probe-sources.mjs:16` · 正则确实会静默漏掉 bootstrap 里实际被认的文件（作者自查问题 1 成立）
   - 证据：正则 `/^\s+"([a-z-]+\.js)": "([0-9a-f]{64})",$/gm` 只认「小写字母/连字符 + `.js` + 带尾逗号」的缩进行。`bootstrap.mjs:10-14` 目前 3 项恰好都长这样，所以现在能对上；但若将来产物名含数字/大写/下划线（`sdk2.js`）或最后一条丢了尾逗号（对象字面量末项的自然写法），该键就从 `recorded` 里消失。
   - 后果分两支：这条目**在记录里** → 报 `PROBE_BUILT_DATAMISMATCH`（实际是 `PROBE_BUILT_DIGEST_MISMATCH`，响亮但提示"absent”，有误导）；**不在记录里** → 两个检查都不报，静默通过。上线包生成端的 `check-packet-consistency.py:98` 用的是一模一样的正则，所以同样漏掉，真正拦截要等到 S6 验收运行时探针自己的 `basename in originals`（`bootstrap.mjs:36`，这个判断不依赖正则）在真实构建产物上抛 `PROBE_ORIGINAL_RUNTIME_CHANGED`——比 PROBE_DIGEST_STALE 还晚，正是这次想避免的“发现太晚”。
   - 建议：加一条数量核对——bootstrap 中 64 位摘要行数必须等于 `record.files` 数量，正则匹配数不符即报 `PROBE_ORIGINALS_PARSE_INCOMPLETE`（可参考包端已有的 `PROBE_ORIGINALS_NOT_FOUND`）；或放宽字符类并允许末行无逗号，再以数量核对兜底。
   - （读代码证实）

2. **低** · `scripts/check-probe-sources.mjs:15,23,27` · 记录损坏时失败“响亮但不清楚”，且全无测试
   - 证据：`JSON.parse` 遇坏文件抛 SyntaxError；`record.files` 缺失/不是数组时 `.map` 抛 TypeError。都让门以非零退出（方向安全，不会误判通过），但输出是堆栈而非 `PROBE_SOURCES_*` 编号。
   - 测试缺口：`PROBE_SOURCES_RECORD_MISSING`、`PROBE_BOOTSTRAP_MISSING`、`PROBE_SOURCE_MISSING` 三个分支和畸形记录，测试夹具（`test/tooling/probe-sources.test.mjs:23-46`）总是写全记录文件，一个都没覆盖到。
   - 建议：显式 catch/类型检查后报 `PROBE_SOURCES_RECORD_MALFORMED`；补缺失文件与畸形记录两条用例。（代码事实证实“部分成立”；不误判通过是读代码推实，异常消息不清楚也是读代码推实）

3. **低** · `scripts/check-probe-sources.mjs:46-52` · CLI 半边（主模块判定、提示输出、退出码）零测试
   - 证据：主判定 `import.meta.url === \`file://${process.argv[1]}\`` 与既有脚本 `check-srt-version.mjs:143`、`check-real-admission-tests.mjs:102` 同模式（推测能跑，未亲自运行核实 Node 对 argv[1] 的解析形态）；`REFRESH_HINT`、`PROBE_SOURCES passed/failed` 输出、exit 1 都没有任何用例钉住。
   - 缓解：`check:probe-sources` 用 `&&` 串联的两半里，vitest 首个用例直接对真实仓库调 `probeSourceProblems(repository)`，即使 node 半边变成静默 no-op 空过，门仍能拦住真实源码漂移。风险低。
   - 建议：加一条真实子进程用例确认 CLI 对损坏记录非零退出、对当前仓库零退出。（读代码证实测试缺失；判定模式是否可用为推测）

4. **低** · `scripts/delivery-mode/hermes/run-release-walkthrough.sh:22` · I-79 门槛对「目录整个被删」有效，但对「工作树被清空、.git 还在」无效
   - 证据：preflight 对 source 的核对只有 `git -C "$source" rev-parse HEAD`；工作树文件被删而 `.git` 完好时此检查通过。node/python/browsers/fd/rg 五项（17-21 行）与事故描述一致，`make-packet.py:574-577` 在构建前调用并以 `PACKET_HERMES_PREFLIGHT_FAILED` 拒绝，与事故原文一致；顺序在 build 之前由既有用例 `test_make_packet.py:787-793` 守着。
   - 建议：preflight 对 source 加一个代表性文件的存在性检查（如 `[[ -f "$source/package.json" ]]`）。（读代码证实；事故「谁删的没查出来」无法核实，作者已如实标注）

5. **信息** · 与代码一致的作者说法
   - 三个错误名 `PROBE_SOURCE_CHANGED` / `PROBE_BUILT_DIGEST_MISMATCH` / `PROBE_SOURCE_UNLISTED` 与代码一一对应（脚本 24、33-35、40 行）。
   - “只比源码摘要、偏严”的取舍如实：代码确实不构建、不碰 dist（`sourceSha256` 是唯一动态比对项）。
   - `check:probe-sources` 接线被既有通配用例覆盖：`test/tooling/run-all-checks.test.mjs:50-55` 要求 check:steps 里每个名字都是真实 npm script。
   - I-78/I-79 两条表行会被 `scripts/check-incident-gates.mjs` 的通用检查覆盖（列名、编号、日期、gate 引用路径存在性）；表里引用的 `probe-sources.json`、两个脚本/测试路径、`run-release-walkthrough.sh` 都存在。
   - `test/tooling/probe-sources.test.mjs` 属于 tooling project（`ci/policy.json:243` include `test/tooling/**/*.test.mjs`），`check:probe-sources` 的 vitest 命令能选到它。
   - 三条 `builtSha256` 与 bootstrap 12-13 行的三条摘要逐字一致。

**注意（未核实项）**：所有 vitest 用例和 `node scripts/check-probe-sources.mjs` 都没有运行过（本复核不能跑测试）；“记录/摘要与当前源文件逐字节一致”这一点只能由 `probeSourceProblems(repository)` 的用例在真实 CI 里证实。I-78 的复现细节（Hermes 上三项报错）属作者叙述，未核实。

## 侧重检查

走的流程（最普通使用流程）：开发者改 `packages/runtime-sandbox/src/job-host-main.ts` → 提交前跑 `npm run check` → `run-all-checks.mjs` 按 `check:steps` 顺序执行 → `check:probe-sources`：(a) node 脚本读记录 → 正则抽 bootstrap → 三向比对，(b) vitest 对真实仓库全量比对。门失败时 run-all-checks 逐项报告（有既有测试）。

无测试覆盖的代码路径（同一流程内）：
- CLI 块（脚本 46-52 行）：主模块判定、REFRESH_HINT 输出、退出码；
- `PROBE_SOURCES_RECORD_MISSING`、`PROBE_BOOTSTRAP_MISSING`、`PROBE_SOURCE_MISSING`（脚本 11、17、30-32 行）；
- 畸形记录的异常分支（15、23 行）。

文档与代码一致性：I-78「未覆盖：TS 版本或编译设置变了」与代码相符（记录里没有任何 dist 实测）；I-79「删除本身没有防护」相符（门槛只在出包/上线时核对存在性）。

## 必答问题

1. **不改变请求开头。** 改动只碰 `package.json` 的脚本清单、`scripts/`、`docs/`、`test/`，没有触碰任何组装模型请求的代码（apps/packages），探针脚本是上线包内 S6 验收工具，与模型请求无关。作者「改动不涉及发给模型的内容」与代码一致。（此外本改动也不新增任何会发给模型的文字。）
2. **不会。** 新值（`probe-sources.json`、三条错误码、hint 文本）都是确定性输出：读取顺序固定（记录数组顺序、bootstrap 行序），JSON 手写定序，无时间戳、无依赖遍历序的集合。该值也不进入任何请求。
3. **有自动检查且接进了 `npm run check`**（`check:probe-sources` 在 check:steps 里），三条反向用例按代码逻辑推断确实会失败（`[probe-digest-stale]`、bootstrap 改指纹不改记录、多认未记录文件），但未实际运行。两处折扣：(a) 主模块判定/退出码链路无用例（见发现 3， Harbor 失明有 vitest 半边兜底）；(b) 记录缺失/损坏分支无用例（发现 2）。注意 `[probe-digest-stale]` 复现的是「有记录但过期」的新世界；真回 I-78 现场（无记录）报的是 `PROBE_SOURCES_RECORD_MISSING`——事故表把复现写为“构造过期记录”，与代码一致，不算错。
4. **逐值核对：**
   - `check:probe-sources`：唯一使用处 check:steps，`run-all-checks.test.mjs:50-55` 校验其为真实 npm script。✅
   - `probe-sources.json` 三字段：唯一消费者是新脚本；`built` 名 ←→ bootstrap 键（UNLISTED/MISMATCH 双向互验）、`source` 路径存在性与摘要比对、`bootstrap` 路径存在性——提交端两端都有核对；类型/缺失校验弱但只会失败不会误过。与包端 `check-packet-consistency.py:98` 共用同一正则，两端标准不会漂移。唯一无法在提交端证实的是 `builtSha256` 是否等于真实构建产物（Mac 不能构建），由包端 `PROBE_DIGEST_STALE` 收口，事故表已如实写明。⚠️ 正则本身的静默漏检见发现 1。
   - I-78/I-79 表行：被 incident-gates 通用检查覆盖，引用路径全部存在。✅
