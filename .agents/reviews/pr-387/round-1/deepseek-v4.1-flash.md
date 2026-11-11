## 发现（按严重度从高到低）

### 1. 高（可复发）— 生成 `result.json` 的代码没改，下次跑 live eval 会再次把 `format:check` 弄红
- 文件：`scripts/evals/owner-rule-live.eval.ts:210-225`；`evals/owner-rule/result.json:57-58`
- 问题：本 PR 手工把 `evals/owner-rule/result.json` 整理成 Biome 想要的格式，但写文件的仍是 `JSON.stringify(..., null, 2)`。该输出不会把短数组压成一行，和 Biome 的格式不一致；下一次按 ADR 0213 跑评测会原样重写这个文件，再次制造 `format:check` 失败。也就是说，I-55 第 4 次的根因之一没有修掉，只修了产物。
- 证据（亲自读到）：
  - 生成端：`scripts/evals/owner-rule-live.eval.ts:211-224`
    ```ts
    writeFileSync(
      path.join(OUTPUT_DIRECTORY, "result.json"),
      `${JSON.stringify(..., null, 2)}\n`,
    );
    ```
  - 提交后的文件已经是 Biome 的压缩数组格式：`evals/owner-rule/result.json:57-58`
    ```json
    "phrases": ["退款", "退钱", "返金", "払い戻し", "払戻", "返還"],
    "words": ["refund", "refunds", "refunded", "chargeback"]
    ```
  - `JSON.stringify(..., null, 2)` 对数组会逐项换行，不会产生上面的单行数组。
- 建议：让生成端输出可直接通过 `format:check` 的字节，例如写完后对 `result.json` 单独运行 Biome，或把 `evals/owner-rule/result.json` 从格式检查中排除并在文档里声明它是生成产物；再加一条测试：生成/改写后的 `result.json` 必须通过 `check-format`。
- 判定：读代码证实。

### 2. 中 — Windows 上 `check-format.mjs` 很可能起不来 Biome，所有推送都会被拦
- 文件：`scripts/check-format.mjs:10,16-17`
- 问题：Windows 分支明确指向 `biome.cmd`，但 `spawnSync` 没有 `shell: true`，也没有通过 `cmd.exe /c` 启动。Node 在 Windows 上不能直接用 `CreateProcess` 执行 `.cmd`，这类文件需要 shell 或 `cmd.exe`；结果是 `status` 为空，脚本以 1 退出，pre-push 报 `PUSH_FORMAT_CHECK_FAILED`，即使代码格式完全正确。
- 证据（亲自读到）：
  ```js
  process.platform === "win32" ? "biome.cmd" : "biome",
  ...
  const result = spawnSync(biome, ["format", "."], { cwd: root, stdio: "inherit" });
  process.exit(result.status ?? 1);
  ```
  这里也没有输出 `result.error`，所以就算子进程启动失败，开发者只看到笼统的 `PUSH_FORMAT_CHECK_FAILED`。
- 建议：Windows 下用 `shell: true`（注意参数转义）或直接 `spawnSync(process.execPath, [biomeJsEntry, "format", "."])`；失败时把 `result.error` 打到 stderr。若项目本来就不支持 Windows，则去掉 `win32` 分支并明确文档化，避免伪装成跨平台。
- 判定：`spawnSync` 无 shell、路径是 `.cmd` 是读代码证实；Windows 上实际失败是根据 Node/Windows 启动语义推测，未在 Windows 实机验证。

### 3. 中 — 默认授权值从文档约定的 `proxy-injected` 改成 `proxy`，可能让出口代理不再代填
- 文件：`scripts/evals/owner-rule-live.eval.ts:22,75`；对照 `scripts/evals/memory-capture-live.eval.ts:89`、`scripts/model-review/gateway.mjs:33`
- 问题：仓库里其他评测和复核网关仍把假凭证叫 `proxy-injected`，文档也写明容器里放的是 `proxy-injected`，由出口代理按主机换成真凭证。现在 owner-rule 默认发 `Bearer proxy`。如果出口代理靠这个固定值判断“这是假凭证，可以替换”，live eval 会 401；如果代理无条件按主机替换，则没事。仓库里没有代理代码能证明是哪一种。
- 证据（亲自读到）：
  - `scripts/evals/owner-rule-live.eval.ts:22`
    ```ts
    const API_KEY = process.env["EVAL_API_KEY"] ?? "proxy";
    ```
  - `scripts/evals/memory-capture-live.eval.ts:89`
    ```ts
    authorization: `Bearer ${process.env["AI_GATEWAY_API_KEY"] ?? "proxy-injected"}`,
    ```
  - `scripts/model-review/gateway.mjs:33`
    ```js
    export const PLACEHOLDER = "proxy-injected";
    ```
- 建议：保留 `proxy-injected` 作为默认值即可避开机器密钥规则——把它放到 `API_KEY` 常量行，`Bearer ${API_KEY}` 那一行不再直接出现 `[已遮盖:authorization-bearer]`，`authorization-bearer` 规则不会命中。这样既不弱化占位语义，也和仓库其他脚本一致。
- 判定：代码里的不一致是证实；出口代理是否在意具体值属于推测，未核实。

### 4. 低 — pre-push 现在依赖完整 `node_modules`，并且检查的是脏工作树而不是待推送提交
- 文件：`scripts/git-hooks/pre-push:8-15`；`scripts/check-format.mjs:12-14`
- 问题：`format:check` 和 `check:secrets` 被加到每次推送。缺 `node_modules` 时 `check-format.mjs` 会以 1 退出并提示 `先运行 npm ci`，这符合作者“失败或缺失拦下”的说法；但也意味着没有完整依赖的克隆连纯文档推送都推不出去。另外钩子检查当前工作树，`biome format .` 和密钥扫描都会看未提交/未跟踪文件，CI 只看提交内容，二者并不等价：本地一个临时文件就可能拦住一次与它无关的推送。
- 证据（亲自读到）：
  ```sh
  node "$root/scripts/check-format.mjs" >&2 || {
    echo "PUSH_FORMAT_CHECK_FAILED npm run format:check 失败或脚本缺失，推送被拦下" >&2
  ```
  ```js
  if (!existsSync(biome)) {
    console.error(`FORMAT_CHECK_UNAVAILABLE ... 先运行 npm ci`);
    process.exit(1);
  }
  ```
- 建议：如果这是有意的“推送前必须装好依赖”，把这一点写进 runbook/ADR；如果想降低误伤，可以让钩子只检查本次推送涉及的提交内容，或在缺少依赖时给出明确的“先安装依赖”说明而不是笼统的格式失败。
- 判定：行为读代码证实；“变慢是否可以接受”没有实测，未核实。

### 5. 低 — 新脚本本身没有自动检查，现有测试只验证钩子调用的是 stub
- 文件：`test/tooling/layer0-hooks.test.mjs:47-52,157-180`
- 问题：测试确实补了“脚本失败”“脚本缺失”“通过”三类用例，反向用例在旧钩子上会失败，这点是有效的。但 `scripts/check-format.mjs` 从未被真正执行：测试写的是 `FORMAT_STUB_RAN` stub。因此新脚本自己的错误路径（`node_modules` 缺失、Windows `.cmd`、`spawnSync` 返回 `error`）没有任何测试覆盖；“`package.json` 的 `format:check` 真的指向新脚本”也没有测试绑定。
- 证据（亲自读到）：
  ```js
  write(root, "scripts/check-format.mjs", "console.error('FORMAT_STUB_RAN');\nprocess.exit(0);\n");
  ```
- 建议：给 `check-format.mjs` 加一个小单测，至少覆盖“缺 `node_modules/.bin/biome` 时退出 1”和“成功/失败退出码透传”；再加一条断言 `package.json.scripts["format:check"]` 指向该脚本。
- 判定：读代码证实。

### 6. 低 — I-55 行能通过 `check:incident-gates`，但“21 步”已经过时
- 文件：`docs/incidents-and-gates.md:92`；`package.json:27`
- 问题：I-55 这一行本身满足 `check-incident-gates`：列数仍为 7，编号合法，日期合法，次数 `4` 是正整数，状态 `已落门槛` 属于硬门槛状态，门槛里被反引号包住的仓库路径都存在，因此不会报 `INCIDENT_*`。但同一行仍写 `check:steps` 有“21 步”，而现在的 `check:steps` 早已远多于 21 步。这是已有文档漂移，不是本 PR 引入，但本 PR 在同一行加了第 4 次说明却没顺手修正。
- 证据（亲自读到）：
  - `docs/incidents-and-gates.md:92` 中仍有“把 21 步全跑完”。
  - `package.json:27` 的 `check:steps` 从 `format:check` 一直延续到 `check:check-runner`，明显不止 21 项。
- 建议：把“21 步”改成“check:steps 里的全部步骤”，避免以后按错误数字核对。
- 判定：读代码证实。

---

## 侧重检查

- **错误路径**：确认 `check-format.mjs` 在 `node_modules/.bin/biome` 缺失时退出 1 并输出 `FORMAT_CHECK_UNAVAILABLE`；pre-push 对两个新脚本都用 `||` 捕获非零并打印专用错误码。脚本缺失时 Node 自身非零，钩子同样会打印 `PUSH_FORMAT_CHECK_FAILED` / `PUSH_SECRET_SCAN_FAILED`。这部分符合作者说法。
- **不可信输入**：新增的 `EVAL_API_KEY` 来自环境，直接拼进 Authorization 头；它只会发往 `EVAL_BASE_URL`。如果同时把 `EVAL_BASE_URL` 指到外部地址，真实密钥会被发到那里。这是“配置错误会泄密”的风险，不是本次代码注入漏洞；建议在文档里明确 `EVAL_API_KEY` 只配默认网关使用。
- **安全**：密钥扫描规则本身未改，改动只是不再在源码里写 `[已遮盖:authorization-bearer]`。`const API_KEY = process.env["EVAL_API_KEY"] ?? "proxy"` 不会被现有 `authorization-bearer` 或 `credential-assignment` 命中：前者需要 `Bearer` 后紧跟 12 个以上字符，源码里紧跟的是 `${`；后者在 `process.env[` 的 `[` 处断开。此项读代码确认。
- **资源耗尽**：pre-push 每次推送都会跑全仓 Biome 格式检查和对全部已跟踪+未跟踪非忽略文件的密钥扫描；`scan-machine-secrets.mjs` 还会整文件读入内存。没有实测耗时，但这是新增的每次推送成本，仓库变大时会继续增长。
- **不可撤销操作**：eval 每次运行都会无备份覆盖 `evals/owner-rule/result.json`，且覆盖发生在通过率断言之前；这与发现问题 1 叠加，失败运行也会重写已提交的评测结果。
- **规则/说明文档与代码一致性**：`prompt-prefix` 相关代码没有改动；I-55 行格式能过检查，但“21 步”与 `package.json` 不一致；`EVAL_API_KEY` 的默认值与仓库统一的 `proxy-injected` 约定不一致。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？
不会。这个 diff 没有改系统提示、工具定义、历史消息或遮盖逻辑。owner-rule eval 发给模型的内容仍是：

- `scripts/evals/owner-rule-live.eval.ts:59`：`system = CHAT_IDENTITY.text + CHAT_ANSWER_LANGUAGE.text`
- `scripts/evals/owner-rule-live.eval.ts:78-86`：`tools`、`system`、单条用户句，结构没变
- `scripts/evals/owner-rule-live.eval.ts:75`：只有 Authorization 头变了，头不进入模型输入

`evals/owner-rule/*.json` 是评测产物，没有被提示词组装或模型请求读取（只有 ADR 和本 incident 文档引用）。所以仍是只在末尾追加，没有把会变的值塞进请求前部。依据 `.claude/rules/prompt-prefix.md` 第 4、10 条，这个改动不触碰约束对象。

### 2. 会不会让同一段文字在不同请求里变成不同字节？
模型可见内容不会。请求体仍由固定的 `system`、固定的工具数组、固定的 `messages` 结构生成；没有新增时间字段、哈希、无序集合或依赖前后文的遮盖。

但文件字节层面有一个问题：`result.json` 的“生成格式”和“提交格式”不一致（见发现 1），下一次评测会写出不同字节。这不是模型请求内容，但会让仓库检查再次失败。

### 3. 有没有对应的自动检查，反向用例真的会失败？
有，但不完整。

- 有：`test/tooling/layer0-hooks.test.mjs` 新增了“脚本失败/缺失时拒绝推送”和“通过时三个脚本都运行”的用例。按代码核对，旧 `pre-push` 不调用这两个脚本，因此这两条反向用例在旧钩子上会失败，用例是有效的。
- 不足：新 `check-format.mjs` 本身完全没被执行，测试用的是 stub；没有覆盖 `node_modules` 缺失、Windows `.cmd`、`spawnSync` 启动失败；也没有测试 `package.json` 的 `format:check` 一定指向新脚本；没有测试 eval 生成的 `result.json` 仍能通过格式检查。发现 1 正是这个缺口的直接后果。

### 4. 改动产生/修改的每个值，使用它的地方都能接受吗？
逐个核对如下：

| 值 | 产生处 | 使用处 | 结论 |
|---|---|---|---|
| `format:check` 改指 `node scripts/check-format.mjs` | `package.json:75` | `package.json:27` 的 `check:steps` → `scripts/run-all-checks.mjs`；CI static 执行 `npm run check` | 可接受。`stepNames` 只要求 `npm run <name>`，CI 也通过 npm 脚本调用，参数仍是 `biome format .` |
| `check-format.mjs` 的退出码 0/1 | `scripts/check-format.mjs:16-17` | `pre-push:8-11`、`npm run check` | 可接受；但 Windows `.cmd` 与 `spawnSync` 的启动失败会让它错误地返回 1（发现 2） |
| `PUSH_FORMAT_CHECK_FAILED` / `PUSH_SECRET_SCAN_FAILED` | `pre-push:9,13` | 只有测试和 I-55 文档引用 | 没有下游解析器，可接受 |
| `EVAL_API_KEY` 默认 `"proxy"` | `owner-rule-live.eval.ts:22` | 唯一使用处 `owner-rule-live.eval.ts:75` 的 Authorization 头 | 代码两端能接受；但与仓库统一的 `proxy-injected` 不一致，出口代理是否接受未核实（发现 3） |
| I-55 次数 `4`、状态 `已落门槛`、门槛路径 | `docs/incidents-and-gates.md:92` | `scripts/check-incident-gates.mjs:59-63` 及路径存在性检查 | 可接受：次数是正整数，`count >= 3` 时状态属于硬门槛集合，门槛里所有反引号仓库路径都存在，I-55 行格式满足 `check:incident-gates` |
| 两个 JSON 的空白/换行 | `evals/owner-rule/*.json` | 没有代码按键值或原始字节读取它们，只有文档引用 | 可接受；但生成器会再次写出不兼容格式（发现 1） |

**未核实**：Windows 实机行为、出口代理是否只认 `proxy-injected`、真实的推送钩子耗时、live eval 在新默认授权值下对实际网关是否仍成功。
