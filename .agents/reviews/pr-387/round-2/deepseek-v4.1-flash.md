# 复核结论

未发现会直接阻断合并的高严重度问题。第 2 轮的两处核心改动方向合理，但**都没有能区分“改前/改后”的自动检查**；另外 `evals/**/*.json` 的排除面过宽，I-55 的文档措辞也和代码不一致。

---

## 读代码证实的问题

### 1. [中] `evals/**/*.json` 排除了输入数据，不只是评测脚本生成的结果

- 文件: `biome.json:37`
- 问题: 这次新增的 formatter 豁免匹配整个 `evals/` 下的 JSON。其中至少 `evals/memory-retrieval/dataset.json` 和 `evals/memory-retrieval/candidates-qwen3-embedding-8b.json` 是手工维护/离线复算用的**输入数据**，不是评测脚本每次生成的 `result.json`。排除后 `npm run format:check` 和 pre-push 都不再检查它们。
- 证据:
  - `biome.json:34-38`：
    ```json
    "includes": [
      "test/qualification/evidence/**",
      "test/fixtures/memory-evaluation/embeddings-*.json",
      "evals/**/*.json"
    ],
    "formatter": { "enabled": false }
    ```
  - 实际匹配到的输入文件：`evals/memory-retrieval/dataset.json:3` 写明“合成数据……”，`evals/memory-retrieval/candidates-qwen3-embedding-8b.json:3` 写明“离线复算融合截断用，不调用任何模型”。
  - 真正由脚本生成的文件只有：`scripts/evals/owner-rule-live.eval.ts:23,212` 写 `evals/owner-rule/result.json`；`scripts/evals/memory-capture-live.eval.ts:19,277,305` 写 `evals/memory-capture/partial-*.json` 和 `${stamp}.json`。
- 建议: 把豁免收窄到生成物，例如 `evals/owner-rule/result.json`、`evals/memory-capture/partial-*.json`、`evals/memory-capture/*.json`；保留 `evals/memory-retrieval/dataset.json`、`candidates-*.json` 的格式检查。更好的做法是让评测脚本写文件后统一走 biome 格式化，或把生成结果放到已被忽略的 `.ci-output/`。

### 2. [中] 第 2 轮的核心改动没有能失败于改前代码的测试

- 文件: `test/tooling/layer0-hooks.test.mjs:159-165, 167-180`；`scripts/check-format.mjs:6, 11`
- 问题: 新增的两条测试都**不能证明这次 `process.execPath + @biomejs/biome/bin/biome` 的改动是必需的**。
  - “runs the same format check at push as npm run format:check” 只断言 `package.json` 的字符串；而 5056af7 里 `format:check` 已经指向 `node scripts/check-format.mjs`，所以这条在改前也通过。
  - “refuses the format check when biome is not installed” 把脚本复制到没有 `node_modules` 的临时目录；改前版本查 `node_modules/.bin/biome`，同样不存在，同样退出 1。因此这条在改前也通过。
  - 没有任何测试真正启动已安装的 biome，或断言参数是 `["format", "."]`；也没有测试验证新增的 `biome.json` 豁免确实让生成的 JSON 不再被格式化。
- 证据:
  ```js
  // test/tooling/layer0-hooks.test.mjs:163-164
  expect(scripts["format:check"]).toBe("node scripts/check-format.mjs");
  expect(scripts["check:secrets"]).toBe("node scripts/scan-machine-secrets.mjs");
  ```
  ```js
  // test/tooling/layer0-hooks.test.mjs:175-179
  const run = spawnSync(process.execPath, [path.join(root, "scripts/check-format.mjs")], ...);
  expect(run.status).toBe(1);
  expect(run.stderr).toContain("FORMAT_CHECK_UNAVAILABLE");
  ```
  ```js
  // scripts/check-format.mjs:6,11
  const biome = path.join(root, "node_modules", "@biomejs", "biome", "bin", "biome");
  const result = spawnSync(process.execPath, [biome, "format", "."], { cwd: root, stdio: "inherit" });
  ```
- 建议: 增加正向测试：在临时根目录放一个假的 `node_modules/@biomejs/biome/bin/biome`（JS，把 `process.argv.slice(2)` 写到文件并 `exit 0`），运行 `check-format.mjs`，断言退出 0 且收到 `format .`；再用一个会 `exit 1` 的假入口断言失败。这样路径和参数都真正被测到。对 `evals/**/*.json` 也应有一条用真实 biome 在临时目录跑的用例：有豁免时通过、去掉豁免时失败。

### 3. [低] I-55 文档把“推送前运行密钥扫描”写成了“biome.json 不再检查 scan-machine-secrets.mjs”

- 文件: `docs/incidents-and-gates.md:92`
- 问题: 该行现在的句子是：
  > `scripts/git-hooks/pre-push` 运行 `scripts/check-format.mjs`（`npm run format:check` 现在也用它）；`biome.json` 不再检查 `evals/` 下评测脚本生成的 JSON 的格式和 `scripts/scan-machine-secrets.mjs`，失败或脚本缺失就报……

  这会被读成“biome.json 不再检查 `scripts/scan-machine-secrets.mjs`”，但 `biome.json:4-5` 仍然是 `"**"`，并没有排除这个文件；同时这句话漏掉了 pre-push 实际还会运行 `scripts/scan-machine-secrets.mjs`。
- 证据:
  - `scripts/git-hooks/pre-push:8-14` 明确运行两个脚本：
    ```sh
    node "$root/scripts/check-format.mjs" >&2 || { echo "PUSH_FORMAT_CHECK_FAILED ..."; exit 1; }
    node "$root/scripts/scan-machine-secrets.mjs" >&2 || { echo "PUSH_SECRET_SCAN_FAILED ..."; exit 1; }
    ```
  - `biome.json:4-5` 的 `files.includes` 仍包含 `"**"`。
- 建议: 改回“`pre-push` 运行 `scripts/check-format.mjs` 和 `scripts/scan-machine-secrets.mjs`；`biome.json` 只对 `evals/**/*.json` 关闭 formatter”。

### 4. [低] `EVAL_API_KEY` 为空字符串时会发出 `Bearer `，而不是回退到占位值

- 文件: `scripts/evals/owner-rule-live.eval.ts:22, 75`
- 问题: `??` 只处理 `undefined/null`；若环境里存在 `EVAL_API_KEY=""`，请求头会变成 `Authorization: Bearer `，网关返回难以定位的 401，而不是继续用 `proxy-injected`。
- 证据:
  ```ts
  const API_KEY = process.env["EVAL_API_KEY"] ?? "proxy-injected";   // 第 22 行
  authorization: `Bearer ${API_KEY}`,                                 // 第 75 行
  ```
- 建议: 改成 `process.env["EVAL_API_KEY"]?.trim() || "proxy-injected"`，或空串时明确报错。

### 5. [低/提示] pre-push 检查的是工作区，不是本次推送的提交

- 文件: `scripts/git-hooks/pre-push:8-14`；`scripts/scan-machine-secrets.mjs:21,39-44`
- 问题: 新加的两步都读当前工作区：`check-format.mjs` 在仓库根目录跑 biome，密钥扫描用 `git ls-files --cached --others --exclude-standard` 再 `readFileSync`。如果推送的不是当前检出的提交，检查结果和实际推上去的字节可能不一致。这是既有钩子的共同限制，不是本轮引入，但新增的两步继承了它。
- 证据:
  ```js
  // scripts/scan-machine-secrets.mjs:21
  spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], ...)
  // :39-44
  for (const file of tracked.stdout...) { ... readFileSync(file) ... }
  ```
- 建议: 至少记录这一限制；若要严格，应针对推送范围（stdin 里的 `<local ref> <local sha>`）做 `git diff`/`git archive` 后检查。

---

## 推测与未核实

- **biome 入口文件本体未核实。** 本检出是稀疏检出，没有 `node_modules`，无法直接读 `node_modules/@biomejs/biome/bin/biome`。锁文件能证明路径和版本：`package-lock.json:637-639` 声明 `"bin": { "biome": "bin/biome" }`，版本 2.3.5；平台包 `package-lock.json:726-742` 没有 `bin` 字段。因此主包的 `bin/biome` 应由主包自己的启动器定位平台二进制，而不是原生 ELF/PE（推测）。若它实际是原生二进制，`node bin/biome` 会失败；建议在合并前实际运行一次 `npm run format:check` 确认。
- **审查记录是否含未遮盖的假密钥未核实。** `.agents/reviews/pr-387/round-1/*` 被工具禁止读取。这些文件在本提交新增，而 `check:secrets` 会扫描 `.agents/reviews`；若其中有未遮盖的 `[已遮盖:authorization-bearer]`、`sk-...` 等文本，pre-push/`check:secrets` 会再次变红（I-86 的同类问题）。建议在能读记录的环境实际跑一次 `node scripts/scan-machine-secrets.mjs`。
- **非 evals 的其它生成 JSON 未核实。** 我没找到其它写到 `evals/` 之外的评测结果（`scripts/memory-retrieval-eval/live.mjs:54-57` 写到 `.ci-output/`，已被 biome 排除）。`test/fixtures/memory-capture-eval/dataset.json` 当前格式是否完全符合 biome，无法在本检出运行确认。

---

## 侧重检查

- **缺 biome 的错误路径**：`scripts/check-format.mjs:7-10` 存在性检查后打印 `FORMAT_CHECK_UNAVAILABLE` 并 `exit 1`；正常。
- **spawn 启动失败**：`scripts/check-format.mjs:12` 打印 `result.error.message`，随后 `status ?? 1` 退出 1；正常。
- **子进程非零/被信号终止**：`scripts/check-format.mjs:13` 都退 1；可接受。
- **pre-push 脚本失败或缺失**：`scripts/git-hooks/pre-push:8-14` 报 `PUSH_FORMAT_CHECK_FAILED` / `PUSH_SECRET_SCAN_FAILED` 并 `exit 1`；测试 `test/tooling/layer0-hooks.test.mjs:182-203` 覆盖“失败”和“缺失”，这两条在旧钩子上确实会失败，反向用例有效。
- **密钥扫描误报**：新代码不再有字面量 `[已遮盖:authorization-bearer]`；`scripts/scan-machine-secrets.mjs:10` 的 bearer 规则要求 `Bearer ` 后直接跟 12 个以上允许字符，`${API_KEY}` 不匹配；`:17` 的赋值规则对 `API_KEY = process.env[...]` 因 `process.env` 只有 11 个字符也不匹配。读代码判断不会误报。
- **资源耗尽/不可逆操作**：新代码没有写文件、删除、网络变更；pre-push 只是在每次推送时全仓跑格式和扫描，未发现新的不可逆操作。全仓扫描未跟踪文件可能变慢，但不是本轮新增逻辑。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会。** 本次改动没有触碰任何组装模型请求的产品代码。唯一涉及模型调用的改动是 `scripts/evals/owner-rule-live.eval.ts:75` 的 `authorization` 请求头，它不在请求体里；`system`、`tools`、`messages` 仍在 `:59, :78-85` 按原样构造。改动的 `evals/**/*.json` 是评测结果/输入文件，不会发给模型。该系统提示、工具定义、历史消息、遮盖结果都没有变化；不存在“请求开头变化”的问题。评测脚本也不是多轮对话，每次请求是独立的 `[system, user]`，没有历史追加逻辑。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

**不会。** 没有新增依赖时间、顺序或前后文的字段；`owner-rule-live.eval.ts` 只增加了一个从环境读一次、放在请求头里的 `API_KEY`，不影响请求体字节。`result.json` 里本来就有每次运行变化的用量/金额，但它是输出文件，不参与模型请求，而且现在被排除在格式检查之外。

### 3. 有没有对应的自动检查，反向用例真的会失败？

**有一部分，但第 2 轮的核心改动没有。**
- `pre-push` 新增的格式/密钥两步：`test/tooling/layer0-hooks.test.mjs:182-203` 的“fails or is missing”用例在旧钩子上会失败，是有效的反向用例。
- “缺 biome 退出 1”和“package.json 指向”两条新测试：**在 5056af7 版本上也会通过**，不能证明 `process.execPath + @biomejs/biome/bin/biome` 这次改动正确。
- `biome.json` 新增豁免没有任何测试覆盖；没有用真实 biome 验证生成的 `evals/**/*.json` 现在确实不再导致 `format:check` 失败。
- 这些测试位于 `test/tooling/layer0-hooks.test.mjs`，属于 tooling 项目的完整测试集，不在 `npm run check` 的 `check:layer0-hooks`（它只运行 `scripts/check-layer0-hooks.mjs`）里。

### 4. 改动产生/修改的每个值，使用它的地方都能接受吗？

逐个核对如下：

| 值 | 产生处 | 使用处 | 结论 |
|---|---|---|---|
| `evals/**/*.json` | `biome.json:37` | `npm run format`（`package.json:74`）、`npm run format:check` → `scripts/check-format.mjs:11`、`npm run lint`（仍只跑 linter） | 语法与既有 override 一致；但语义上误伤了输入数据（问题 1） |
| `node_modules/@biomejs/biome/bin/biome` | `scripts/check-format.mjs:6` | `package.json:75`、`scripts/git-hooks/pre-push:8`、`test/tooling/layer0-hooks.test.mjs:171-173` | 锁文件 `package-lock.json:637-639` 支持该路径存在；实文件未读，未完全核实 |
| `format:check` 脚本字符串 | `package.json:75` | `check:steps` 按名字调用、`layer0-hooks.test.mjs:163` 精确等值、pre-push 直接调同一路径 | 两端一致；测试用精确字符串，略脆 |
| `EVAL_API_KEY` / 默认 `proxy-injected` | `scripts/evals/owner-rule-live.eval.ts:22` | 同一文件 `:75`；其它脚本也使用同样的 `proxy-injected` 占位值 | 语义一致；空字符串问题见问题 4 |
| `PUSH_FORMAT_CHECK_FAILED` / `PUSH_SECRET_SCAN_FAILED` | `scripts/git-hooks/pre-push:9,13` | `test/tooling/layer0-hooks.test.mjs:183-184,194,201`、I-55 文档 | 一致 |
| 重排过的 `evals/owner-rule/*.json` | 5056af7 的格式化 | ADR 0213 只引用 `result.json` 的统计结果，不依赖字节 | 语义不变；但 `before-wording-fix.json` 是“修复前”快照，重排改变了原始字节，如果它是证据快照，建议恢复原字节 |
