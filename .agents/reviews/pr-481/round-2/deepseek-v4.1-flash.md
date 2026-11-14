我按要求先看了 `ba27d1f50..9bf0cb918` 的全量，再看 `f7d626d6f..9bf0cb918` 的增量。增量只动了三处：

- `scripts/model-review/gateway.mjs`：`gatewayTiming` 增加 2xx/`session` 过滤；`readGatewayRests` 区分 ENOENT、读失败、坏 JSON、非 map，并清理控制字符、截长。
- `scripts/model-review/delegate.mjs:165`：委托线程最后回复增加 `REVIEW_TIMING`、全部 `GATEWAY_REST`。
- `test/tooling/review-gateway.test.mjs`：新增反向用例和 rests 用例。

`.agents/reviews/pr-481/round-1/judgments.md` 在当前 sparse checkout 里不存在，`git show` 对该路径返回 `REVIEW_GIT_REFUSED records-path`，所以第 1 轮意见 1–5 的原文**未核实**；下面按作者说法与代码逐项核对。

## 读代码证实的问题

### 1. 低 — `GATEWAY_REST` 的 “unreadable” 输出不符合文档规定的四段格式

- 文件:行：`scripts/model-review/gateway.mjs:580`、`scripts/model-review/gateway.mjs:586`、`scripts/model-review/gateway.mjs:588`、`scripts/model-review/opencode-review.mjs:3451`、`.agents/instructions/model-review.md:193`
- 问题：正常行是四段，读不出时只有两段，且把 `unreadable` 放在了“服务方”位置。
- 证据：
  ```js
  return [`unreadable ${error?.code ?? "read-failed"}`];
  ...
  return ["unreadable bad-json"];
  ...
  if (!rests || typeof rests !== "object" || Array.isArray(rests)) return ["unreadable not-a-map"];
  ```
  调用方原样加前缀：
  ```js
  for (const rest of liveGateway?.live.rests() ?? []) console.log(`GATEWAY_REST ${rest}`);
  ```
  文档规定：
  ```
  GATEWAY_REST <服务方> <原因> <状态码> <恢复时间>
  ```
- 影响：现在仓库里没有自动解析 `GATEWAY_REST` 的代码（grep 只找到委托提示），所以不会崩溃；但按文档解析或人工阅读时，`unreadable` 会被当成服务方名，状态码和恢复时间缺失。作者声称“停用原因读不出时说明”，说明做到了，但输出格式与文档不一致。
- 建议：保留四段，例如 `unreadable - - <原因>`；或改成独立标记 `GATEWAY_REST_UNREADABLE <原因>`。同时更新 `.agents/instructions/model-review.md` 和测试断言。

### 2. 低 — “读不出（非 ENOENT）”分支没有自动测试覆盖

- 文件:行：`scripts/model-review/gateway.mjs:578-580`、`test/tooling/review-gateway.test.mjs:1367-1375`
- 问题：作者说区分“文件不存在和读不出”，但测试只覆盖了不存在、坏 JSON、非 map、控制字符，没有覆盖 `EACCES/EISDIR` 等读失败分支。
- 证据：新增分支：
  ```js
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    return [`unreadable ${error?.code ?? "read-failed"}`];
  }
  ```
  测试只有：
  ```js
  writeFileSync(join(root, "config", "magpie", "rests.json"), '{"half');
  expect(readGatewayRests(root)).toEqual(["unreadable bad-json"]);
  writeFileSync(join(root, "config", "magpie", "rests.json"), "[]");
  expect(readGatewayRests(root)).toEqual(["unreadable not-a-map"]);
  ```
- 建议：把 `rests.json` 建成目录（Linux 下 `readFileSync` 会返回 `EISDIR`），或 mock `readFileSync`，断言走 `unreadable <code>` 分支。

### 3. 低 — 截断按 UTF-16 code unit 做，可能切断代理对

- 文件:行：`scripts/model-review/gateway.mjs:593-596`
- 问题：先替换控制字符，再 `.slice(0, 80)`；如果第 80 个 code unit 落在 emoji 等代理对中间，会产生孤立代理项。
- 证据：
  ```js
  String(part)
    .replace(/[\s\p{Cc}\p{Cf}]+/gu, "_")
    .slice(0, 80),
  ```
- 影响：`console.log` 通常会输出替换字符，委托线程再把该行写进最终回复；不会造成注入，但会让报告里出现损坏字符。属于低严重度。
- 建议：按 code point 截断，例如 `Array.from(text).slice(0, 80).join("")`，或先截断再清理。

### 4. 低 — `REVIEW_TIMING` / `GATEWAY_REST` 不在 `--report` 输出里，规则文档与实现只有部分一致

- 文件:行：`scripts/model-review/opencode-review.mjs:3449-3451`、`scripts/model-review/opencode-review.mjs:1686-1695`、`.agents/instructions/model-review.md:71`、`.agents/instructions/model-review.md:193`、`scripts/model-review/delegate.mjs:165`
- 问题：新值只在实时运行的标准输出和委托线程的最终回复里；`--report` 只生成 `REVIEW_RESULT`、`REVIEW_SPENT_TOTAL` 等固定行，不含 timing/rest。规则又要求“给 Andy 的复核汇报，复核部分照贴 `--report` 的输出，不手写”。
- 证据：`--report` 的返回数组：
  ```js
  return [
    `REVIEW_REPORT pr=${pr}`,
    ...reviews.map(resultLine),
    `REVIEW_SPENT_TOTAL ${spentOf(records).toFixed(4)}`,
    ...
  ];
  ```
  而 timing/rest 只在这里打印：
  ```js
  for (const record of results) {
    console.log(resultLine(record));
    if (record.gateway) console.log(gatewayUsageLine(record));
    console.log(timingLine(record));
  }
  for (const rest of liveGateway?.live.rests() ?? []) console.log(`GATEWAY_REST ${rest}`);
  ```
- 影响：如果目标是让 timing/rest 进入正式报告或事后可查，这条链路不完整：临时目录删除后，rests 已不存在；`--report` 也不会输出。如果目标只是委托线程向 Mac 线程口头汇报，那只是文档描述问题，不影响运行。
- 建议：明确这两行只用于委托线程的过程汇报并写进文档；或者把 `gatewayTiming`、rests 快照写进账本，让 `--report` 也能输出。注意休息时间 `until` 是每轮变化的值，放进模型提示词会破坏缓存，只能放报告/账本，不能放进请求开头。

## 推测 / 未核实

### 5. 低（未核实）— `session`、`status` 的 Magpie 日志格式依赖没有真实样本作证

- 文件:行：`scripts/model-review/gateway.mjs:553-554`、`test/tooling/review-gateway.test.mjs:1297-1301`、`test/tooling/review-gateway.test.mjs:1320-1325`
- 问题：新过滤要求 `line.status` 是整数且 `line.session` 是非空字符串。测试里的 usage 记录全部是合成的，仓库中没有一条真实的 Magpie `usage.jsonl` 样本或 schema 说明来证明成功请求一定带字符串 `session`、`status` 一定是数字。
- 证据：
  ```js
  const answered = Number.isInteger(line.status) && line.status >= 200 && line.status < 300;
  if (!answered || typeof line.session !== "string" || line.session === "") continue;
  ```
  测试里：
  ```js
  const at = (fields) => ({ req, provider: "opencode-go", status: 200, ...fields });
  ```
- 影响（推测）：如果真实 Magpie 记录里成功请求没有 `session` 字段，或 `session` 是数字，这次修复会让 `cacheMisses` 静默恒为 0，而不是报错。这不会影响费用或安全，但会让新加的缓存指标失去意义。
- 建议：在测试或自检里放一条脱敏的真实 Magpie usage 记录；或至少在 `gatewayTiming` 过滤后记录“成功行数/带 session 行数”，当成功行存在但全部被跳过时打印警告，而不是静默返回 0。

### 6. 低（未核实）— `answered` 的两处定义不一致

- 文件:行：`scripts/model-review/gateway.mjs:508` 与 `scripts/model-review/gateway.mjs:553`
- 问题：费用汇总用宽松比较 `line.status >= 200 && line.status < 300`，timing 用 `Number.isInteger(line.status)`。如果 Magpie 某版本把 `status` 写成字符串 `"200"`，费用能算，timing 会跳过。
- 证据：
  ```js
  const answered = line.status >= 200 && line.status < 300;   // 508
  ...
  const answered = Number.isInteger(line.status) && line.status >= 200 && line.status < 300; // 553
  ```
- 建议：抽成一个共享的 `answered(line)`，或在两处都使用 `Number.isInteger` 并在 schema 变化时明确报错。当前 Magpie 的 token 字段用 `nonNegative` 校验，说明其他数值字段大概率是数字，所以这只是理论风险。

## 侧重检查

我按“错误路径、不可信输入、安全、资源耗尽、不可撤销、规则与文档一致性”逐项查了这些路径：

- **`readGatewayRests` 错误路径**：文件不存在返回 `[]`；其他读失败返回 `unreadable <code>`；JSON 坏返回 `unreadable bad-json`；顶层不是对象或为数组返回 `unreadable not-a-map`。这些分支都读到了；其中非 ENOENT 分支没有测试覆盖（见问题 2）。
- **不可信输入**：`rests.json` 来自本次临时目录 `workRoot/gateway-live`（`opencode-review.mjs:3100`，`workRoot` 由 `mkdtempSync` 创建于 `opencode-review.mjs:3272`），不是被复核 PR 的副本，因此 PR 内容不能直接控制这个文件。文本里的空白、`\p{Cc}`、`\p{Cf}` 会被替换为 `_`，ANSI ESC 和方向控制字符都被清掉，终端注入基本被挡住；但截断可能切断代理对（问题 3）。
- **安全/泄露**：`rest.why` 原样进入 `GATEWAY_REST`，没有像账本那样做密钥遮盖；如果 Magpie 的错误原因里带 URL 或凭证，可能被委托线程抄进最终回复。这个字段在第 1 轮（f7d）就已经打印，不是本轮新增，但本轮让它更明确地进入“全部 GATEWAY_REST 行”的汇报要求。最终回复不自动进仓库，提交前还有 `check:gitleaks`，所以风险低；建议保持不要把这些行写进仓库。
- **资源耗尽**：`readFileSync` 整个读入、没有大小上限；每个字段截到 80 字符，但条目数没有上限。由于是每次运行新建的临时 Magpie 目录、服务方只有配置里的几家，实际条目数受限；没有发现可利用的资源耗尽路径。
- **不可撤销操作**：本轮改动只读 `rests.json`、只写账本和标准输出，没有删除、覆盖用户数据或不可恢复的操作。
- **规则/文档一致性**：`REVIEW_TIMING` 已写进 `.agents/instructions/model-review.md:193`；但 `GATEWAY_REST` 的 unreadable 变体没有写进 193 行，而且 `--report` 不含 timing/rest 与第 71 行的汇报规则存在缝隙（问题 1、4）。`SELF_CHECK_OK` 从纯文本变成带 ` ms=<数字>`，仓库里的两个测试都用 `toContain`，没有发现精确匹配的消费者。

## 必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**不会改变复核模型已经见过的请求开头。** 本轮没有改 `buildPrompt`、系统提示、工具定义、历史消息或遮盖逻辑；`gatewayTiming`、`readGatewayRests` 只影响统计和标准输出，`timingLine` 和 `GATEWAY_REST` 也没有进入发给模型的 prompt。

`delegate.mjs:165` 改的是交给云端复核线程的任务说明文本，但这是每次委托新会话的第一条提示（`model-review.md` 的 delegate 一节），不是改写已有历史；新增文字是静态的，不含时间、哈希或随机值。`GATEWAY_REST` 里的 `until` 是每轮会变的时间字段，但它只打印到标准输出和最终回复，不进入模型请求。账本在 `.agents/reviews/` 下，复核副本用 sparse checkout 排除该目录，模型也读不到。结论：发给模型的内容仍然只在末尾追加，每轮变化的值不在请求开头。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

**当前改动没有引入新的模型请求字节不确定性。** `readGatewayRests` 对结果 `.sort()`，同一份 `rests.json` 输出顺序固定；控制字符替换是逐字符确定的；`gatewayTiming` 按日志顺序遍历、字段顺序固定；`timingLine` 的字段顺序固定。`until`、耗时、token 数都是每轮变化的值，但只出现在标准输出/账本，不进入 prompt。

唯一的“同一段文字可能不同”是 `GATEWAY_REST` 携带 `until` 恢复时间——如果将来有人把它拼进下一轮 prompt，那会破坏字节确定性；当前代码没有这样做。建议保持这个边界。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

有对应测试，且反向用例在旧代码上确实会失败：

- `review-gateway.test.mjs:1316-1333`：旧代码会把 502 行当成缓存没命中（`missTokens += 0`），并把该会话基线重置为 0；到第 5 行时 `before=0`，真实未命中被漏掉，最终 `missTokens=0`。新测试期望 `60000`，所以在 f7d 代码上会失败。`cacheMisses` 旧代码恰好也是 1，但 `missTokens` 能抓住差异。
- `review-gateway.test.mjs:1367-1375`：旧代码对坏 JSON 和 `[]` 都返回 `[]`，对 ESC 也不清理；新期望 `unreadable bad-json`、`unreadable not-a-map`、`go_[31m ...`，旧代码都会失败。

缺口：非 ENOENT 读失败分支没有测试；没有一条真实 Magpie usage 记录证明 `session`/`status` 的实际形状；没有端到端断言 `opencode-review.mjs` 主流程真的打印 `REVIEW_TIMING`/`GATEWAY_REST`（`timingLine` 单测有，但调用点没有）；`delegationPrompt` 的新增文本没有断言。建议至少补非 ENOENT 分支和一条真实 usage 样本。

### 4. 每个产生或修改的值的两端都能接受吗？

逐个核对如下：

- **`gatewayTiming` 对象（`requests`、`modelMs`、`firstTokenMs`、`slowestMs`、`cacheMisses`、`missTokens`）**
  - 生产：`gateway.mjs:564-571`，数值经 `number()`/`sum()`/`Math.max()`，均为有限数字。
  - 使用：`opencode-review.mjs:3385` 写进账本；`parseUsage`（`1734-1810`）只做通用校验，不拒绝新字段；`delegate.mjs:298` 的 `hasControlText` 对数字通过；`spentOf` 忽略；`timingLine` 读取已知字段。两端都能接受。
- **`selfCheckMs`、`runMs`**
  - 生产：`opencode-review.mjs:3308`、`3357`，`Date.now()` 差值，有限非负整数。
  - 使用：写进账本，`parseUsage`/`hasControlText` 接受；`timingLine` 读取。两端都能接受。
- **`REVIEW_TIMING` 行**
  - 生产：`timingLine`（`3006-3023`）。
  - 使用：标准输出 + 委托线程最终回复；仓库内没有自动解析器。文档 `.agents/instructions/model-review.md:193` 已提到打印它；`--report` 不含它（问题 4）。格式本身没有消费者会拒绝。
- **`GATEWAY_REST` 行**
  - 生产：`gateway.mjs:589-600` + `opencode-review.mjs:3451`。
  - 使用：标准输出 + 委托线程最终回复；没有自动解析器。但文档规定四段，而 `unreadable ...` 只有两段，生产端和文档端不一致（问题 1）。
- **`SELF_CHECK_OK ms=...`**
  - 生产：`opencode-review.mjs:3309`。
  - 使用：仓库内两个测试都用 `toContain("SELF_CHECK_OK")`，没有精确匹配的消费者；不构成破坏，但文档没有写这个格式变化。
- **`startGateway` 新增 `rests` 方法**
  - 生产：`gateway.mjs:856`。
  - 使用：仅 `opencode-review.mjs:3451` 调用；返回字符串数组，调用端按字符串处理。两端一致。

**结论**：修复方向正确，失败请求不再污染缓存基线，读失败也能区分。没有发现高、中严重度的新问题；主要遗留是 `GATEWAY_REST` 的 unreadable 格式与文档不一致、读不出分支缺少测试、截断可能切断代理对，以及 `session`/`status` 的真实日志 schema 未核实。
