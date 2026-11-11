## 侧重检查

走了一条最普通的开发流程：改文件 → `git commit`（`scripts/git-hooks/commit-msg`，layer0 声明检查）→ `git push` → `scripts/git-hooks/pre-push` 依次跑 4 步（layer0 → boundaries → format → secrets）→ 远端。

结论：主路径有测试（`test/tooling/layer0-hooks.test.mjs` 用真实 git 提交+推送驱动钩子）。**没有测试覆盖的路径**：
- `scripts/check-format.mjs:11-14` 的 `FORMAT_CHECK_UNAVAILABLE`（node_modules 缺失）分支——测试只覆盖"脚本文件缺失"和"脚本 exit 1"，从不执行真脚本；
- 同文件 `process.platform === "win32"` 分支——没有任何测试在 Windows 上跑过这段；
- `scripts/scan-machine-secrets.mjs` 每次推送全量读所有未忽略文件的扫描路径，性能未测量。

---

## 发现（按严重度从高到低）

**1. 中高 ｜ scripts/check-format.mjs:8-16 ｜ Windows 上 format:check 和 pre-push 必然失败**
代码特意写了 `process.platform === "win32" ? "biome.cmd" : "biome"`（第 10 行），说明作者想支持 Windows；但 `spawnSync(biome, ["format", "."], { cwd: root, stdio: "inherit" })`（第 15-16 行）没有 `shell: true`。自 Node 18.20/20.12/21.7 修复 CVE-2024-27980 起，Windows 上不带 shell 生成 `.cmd`/`.bat` 一律返回 EINVAL，`result.status` 为 null → `process.exit(result.status ?? 1)`（第 17 行）退出 1。结果：Windows 上即使格式完全正确，`npm run format:check` 报失败、pre-push 永远报 `PUSH_FORMAT_CHECK_FAILED` 拦下推送。engines 要求 node >=22.22.3（package.json:8），该行为在 Node 22 仍然存在。
证据：scripts/check-format.mjs:8-17；scripts/git-hooks/pre-push:8-11。
（"读代码证实的"是脚本结构本身；"Node 对 .cmd 的 EINVAL 行为"是已知安全修复带来的确定行为，但我在 Linux 上无法实测，标推测成分。）
建议：改为 `spawnSync(process.execPath, [path.join(root, "node_modules", "@biomejs", "biome", "bin", "biome"), "format", "."], …)`，跨平台且不依赖 .cmd 壳；或加 `shell: true`（注意参数引号）。补一条 Windows 分支的最小测试。

**2. 低中 ｜ docs/lessons.md:664 ｜ 文档记录的 pre-push 钩子 SHA-256 已过期**
文档写着 pre-push 的 SHA-256 是 `e6f64f47d03d225185c90f1d5ca0cee3b2c44e41cdb574848d65878993264334`，本次改动直接改了钩子内容，没有更新这行。我 grep 了 `scripts/` 和测试，没有任何检查去核对文档里的钩子 SHA（check:incident-gates、check-layer0-hooks 都不管它），所以 `npm run check` 不会报。文档与代码不一致。
建议：更新该 SHA，或把这行改成"见文件 `scripts/git-hooks/pre-push`"避免每次改钩子都要改文档。

**3. 低 ｜ scripts/git-hooks/pre-push:8-15 ｜ 每次推送固定增加两步全量检查，可接受但未量化**
`biome format .` 全仓格式检查 + `scan-machine-secrets.mjs` 同步读取所有未忽略（含 untracked）文件并做正则+哈希。biome 本身很快；密钥扫描是 O(全仓文件) 同步 IO。node_modules 已被 .gitignore 排除（.gitignore:1，`--exclude-standard` 会跳过），负担可控。我无法运行命令实测耗时，标未核实。这两步不做增量、没有 fast 模式跳过（layer0 有 `DELIVERY_MODE_FAST_SKIP_LAYER0`，这两步没有）——与边界检查保持一致，设计上说得通。

**4. 低 ｜ package.json:75 ｜ format:check 换脚本后语义有一个微小收紧**
旧 `biome format .` 依赖 npm 的 PATH（本地 .bin 优先，找不到会退回全局 PATH）；新脚本强制要求 `node_modules/.bin/biome` 存在，缺失直接 `FORMAT_CHECK_UNAVAILABLE` 退出 1（scripts/check-format.mjs:11-14）。对 CI 和 `npm run check` 等价：`check:steps` 第一步仍是 `npm run format:check`（package.json:27），落到同一个 biome 命令、同一 cwd。唯一差别是全局装了 biome 而本地没装 node_modules 的环境从"能跑"变成"报错且信息明确"（提示先 npm ci）。可接受。

**5. 提示 ｜ scripts/evals/owner-rule-live.eval.ts:22 ｜ 默认令牌从 "proxy-injected" 变成 "proxy"，行为是否等价未核实**
原值 `"[已遮盖:authorization-bearer]"` 被密钥扫描认成令牌（`proxy-injected` 长度 14 ≥ 12，命中 scan-machine-secrets.mjs:10 的 `authorization-bearer` 规则，读代码证实会命中）。新值 `Bearer ${EVAL_API_KEY ?? "proxy"}` 中 `${API_KEY}` 含 `$`、`{`，不在正则字符集里，不再命中（读代码证实）。但如果请求头占位值是靠代理识别特定字面量来注入真密钥的，默认值换成 "proxy" 之后注入是否仍发生，我无法从本仓库核实（未核实，推测可能改变行为）。`EVAL_API_KEY` 在仓库内无其他引用、无文档说明，grep 证实只有这一处产生和消费，两端语义一致。

**6. 读代码证实（非问题）｜ I-55 行满足 check:incident-gates 的全部校验**
scripts/check-incident-gates.mjs 的检查逐项过：编号 `I-55` 匹配 `/^I-\d{2,}$/`（:48）；日期格式合法（:51）；各列非空（:53-58）；次数 `4` 可解析且 ≥1（:59-60）；次数 ≥3 时状态 `已落门槛` 属于 HARD_GATE_STATES（:63-64）；状态在 INCIDENT_STATES 里（:61-62）；门槛列里的仓库路径（`scripts/git-hooks/pre-push`、`test/tooling/layer0-hooks.test.mjs` 等）全部存在于磁盘（:65-70）；整行没有未转义的 `|`，`cells()` 按 `|` 切分仍得 7 列。

**7. 读代码证实（非问题）｜ 新增反向用例在旧钩子上确实会失败**
test/tooling/layer0-hooks.test.mjs:159-180 两条参数化用例各含"失败"和"缺失"两个场景；:148-157 的 passes 用例断言 stderr 含 `FORMAT_STUB_RAN`、`SECRETS_STUB_RAN`。旧钩子（git diff 可见）只跑边界检查：两条 refuses 用例里 push 不会失败 → `expect(status).not.toBe(0)` 失败；passes 用例 stderr 没有那两个字符串 → 失败。作者说的"旧钩子上这三条失败"成立。测试用例还验证了错误码逐字符匹配（`PUSH_FORMAT_CHECK_FAILED` / `PUSH_SECRET_SCAN_FAILED`，与 pre-push:9,13 输出一致）。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？——不会（读代码证实）。**
本次 diff 没有触及任何发给模型的内容：`owner-rule-live.eval.ts` 只改了 HTTP 头 `authorization`（第 75 行），请求体 `messages`/工具定义一字未动；两个 JSON 是评测结果存档，diff 只是 biome 折行风格变化，数组元素和值完全没变，且它们不是任何提示词的来源；钩子、package.json、docs 与发给模型的内容无关。"只追加"性质保持：不存在每轮会变的值被挪到前面的情况。附注：任务引用的规则文件 `.claude/rules/prompt-prefix.md` 在本仓库不存在（glob 未找到，未核实规则原文）；仓库内的对应检查是 `scripts/check-prompt-prefix.mjs`（`check:prompt-prefix`，针对 runtime-pi 提示前缀测试），与本改动无关。

**2. 会不会让同一段文字在不同请求里变成不同字节？——不会（读代码证实）。**
`API_KEY` 来自环境变量或字面量 `"proxy"`（第 22 行），同一环境下请求头字节确定；它本来就不进提示词。JSON 的格式化输出由 biome 对同一文件内容决定，确定。改动没有引入时间戳、计数器或顺序不定的集合。

**3. 有没有对应的自动检查，反向用例会不会真的失败？——有，会（读代码证实）。**
见发现 7。缺口：`check-format.mjs` 的 node_modules 缺失分支和 Windows 分支没有测试（见侧重检查）。

**4. 每个产生/使用的值两端都核对过吗？——核对如下（读代码证实为主）。**
- `scripts/check-format.mjs`：产生于新文件；使用于 package.json:75（format:check）和 pre-push:8。两端都能接受其"缺失/失败即退出 1"语义，**除了 Windows 端**（发现 1）。
- `EVAL_API_KEY` / 默认 `"proxy"`：产生于 eval.ts:22，唯一使用于 eval.ts:75；仓库内无其他引用。默认值变化对代理注入行为的影响未核实（发现 5）。
- `PUSH_FORMAT_CHECK_FAILED`、`PUSH_SECRET_SCAN_FAILED`：产生于 pre-push:9,13；使用于 layer0-hooks.test.mjs:160-171（断言）和 docs I-55 行（描述）。一致。
- `format:check` 键：值改为 `node scripts/check-format.mjs`；使用于 `check:steps`（package.json:27）——等价性见发现 4。CI 如何调用该键本仓库内看不到（无 `.github/workflows`，未核实），但 `check:steps` 清单未变，`npm run check` 路径等价。
