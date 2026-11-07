（本轮工具调用已达上限，以下结论全部基于我已读到的代码和 diff；没有再调用工具，也没有运行测试。）

# PR #274 第 4 轮复核结论

## 一、读代码证实的问题（按严重度）

### 1. 【中高】窗口起点落在长行内、其后又有合法正文行时，整段窗口不再被遮，私钥正文会漏出

- 文件:行：`packages/sensitive-capture/src/machine-secrets.ts:111-117`
- 问题：新代码把两个候选按 `[lineStart, earliest]` 排序，`.find` 取第一个能匹配的候选。`nextLineStart` 总是返回 `earliest` **之后**的行首，所以当 `earliest` 落在一条超过 `KEY_TAIL_WINDOW` 的长行内部、而长行后面还有合法正文行（或短正文行）时，`lineStart` 候选先匹配成功，`earliest` 候选根本不会被使用，长行里属于窗口的那一段（可能正是私钥正文）就完全没有被遮。第 3 轮正是要把“整行遮掉”改成“只遮窗口”，这里却变成了“该行一点不遮”。相对 `fd2b3834`（`lineStartBefore` 会回退到行首，虽多遮但不会漏）是覆盖范围的倒退。
- 证据（我读到的行）：
  - `machine-secrets.ts:111-117`
    ```ts
    const earliest = Math.max(cursor, marker.index - KEY_TAIL_WINDOW);
    const lineStart = earliest === cursor ? earliest : nextLineStart(input, earliest, marker.index);
    const found = [lineStart, earliest]
      .map((from) => ({ from, tail: KEY_TAIL.exec(input.slice(from, marker.index)) }))
      .find(({ tail }) => tail !== null);
    if (found?.tail == null) continue;
    const start = found.from + found.tail.index;
    ```
  - `machine-secrets.ts:98-103`：`nextLineStart` 找的是 `earliest` 之后的下一个 `\n`/`\n`，即向后跳过当前长行剩余部分。
  - 新测试 `test/private-key-fragments.unit.test.ts:61-67` 只测了“长行就是最后一行”（后面直接是 END）的情况，此时 `lineStart` 等于 `marker.index`、切片为空而失败，才回退到 `earliest`，所以测试刚好能过；而 `:69-80` 的“长行 + 一个 `MIIE...` 正文行 + END”只断言耗时，不断言遮住了什么：
    ```ts
    `${line}\nMIIE${"Q".repeat(60)}\n${marker("END")}`,
    ...
    expect(performance.now() - started).toBeLessThan(2000);
    ```
    这个输入正是会漏的场景。
- 建议：不要“先试 lineStart、命中就停”。要么只试 `earliest`（`KEY_LINE_START` 的 `^` 已允许从窗口起点中间开始匹配），要么把两个候选都算出结果后取 `start` 更小的那个；至少应先试 `earliest`、失败再用 `lineStart`。并补一条反向用例：长行 + 紧随其后的正文行 + END，断言输出里不再残留长行末尾的 base64 串。

### 2. 【中】ADR/设计说明仍写“五处用 containsToolOutputSecret 整段拦”，与代码现在的“出口遮盖”不一致

- 文件:行：`docs/adr/0054-readonly-tools-in-host-and-reused-task-sandbox.md:137`、`:139`；`docs/execution/specs/2026-09-07-srt-unified-execution-design.md:417`；代码端 `packages/platform-node/src/files/pi-output-export.ts:41-50`
- 问题：文档仍说“把工具输出交给模型的五处改用 `containsToolOutputSecret`”“完整输出文件命中时交出提醒/拒绝”，但现在 `pi-output-export.ts` 对合法 UTF-8 文本是 `redactForEgress(text).text` 后把**遮盖后的字节**发出去，`containsToolOutputSecret` 只在非 UTF-8 分支保留。本次 `git diff --stat 80eaff41..f2d91d6b -- docs` 为空，说明整个 PR 没有同步修改这些文档。规则/说明与代码不符本身属于复核要报的“会出错”。这一条不是 f2d91d6b 引入的，来自本 PR 更早的提交；但代码现状确实与文档冲突。
- 证据：
  - `pi-output-export.ts:47-50`
    ```ts
    const masked = redactForEgress(text).text;
    return masked === text
      ? exportedOutput(bytes, false)
      : exportedOutput(Buffer.from(masked), true);
    ```
  - `docs/adr/0054...:137`：“把工具输出交给模型的五处改用 `containsToolOutputSecret`……”
  - `docs/adr/0054...:139`：“…脱敏函数只换掉一行标记会把正文留在原处。”
  - `grep containsToolOutputSecret` 现在只剩 `pi-output-export.ts` 的非 UTF-8 分支、`production-muse-intake.ts` 和脚本/测试里，五处工具输出路径已不再是它。
- 建议：在本 PR 内给 ADR 0054 和 SRT 设计文档加一段“已被出口遮盖取代”的修订，或由 Andy 明确接受文档滞后；否则下一轮/以后的人会按旧文档改回去。

### 3. 【低｜推测】大量 END 标记且都匹配失败时会反复扫满整个窗口，存在 CPU/内存放大

- 文件:行：`packages/sensitive-capture/src/machine-secrets.ts:109-116`（`KEY_TAIL_WINDOW` 见 `:85`）
- 问题：`found?.tail == null` 时只 `continue`，`cursor` 不前进。于是对于输入里第 N 个 `-----END PRIVATE KEY-----`，只要 `marker.index - cursor` 超过窗口，就会对约 19200 字符的切片再跑一次 `KEY_TAIL`。如果不可信内容（网页/工具输出）里塞满 `-----END PRIVATE KEY-----\n`，而每行都不构成合法正文，每个标记都会做一次满窗口扫描。总复杂度是“标记数 × 窗口”，不是原先那种按行长平方，但常数很大（1 MB 标记约 4 万个，乘 1.9 万字符），可能造成明显延迟/内存分配抖动。
- 证据：
  ```ts
  if (marker.index < cursor) continue;
  const earliest = Math.max(cursor, marker.index - KEY_TAIL_WINDOW);
  ...
  if (found?.tail == null) continue;
  ```
- 说明：这是静态推断，未运行、未实测，标为“推测”。现有 “stays fast on one very long line / long base64 run” 测试都只有单个 END 标记，覆盖不到这种情况。
- 建议：匹配失败时也把扫描下界前移（例如把 `cursor` 或单独的 `searchedThrough` 推到 `marker.index`），或对单次 `redactPrivateKeyFragments` 的 END 标记数量/总耗时有上限；加一条“上万条 END 标记”的耗时用例。

## 二、推测（未实测/未核实）

- 【推测】`KEY_HEAD`、`BASE64_DATA_URL` 没有发现明确的平方级路径：`KEY_HEAD` 没有 `$` 收尾、`TEXT+` 后可选组可为 0，失败时在单个 `-----BEGIN` 处最多线性回溯；`BASE64_DATA_URL` 两端锚定，`[\w.+-]` 被 `;`、`=` 分隔，回溯局限在单段内；`KEY_TAIL` 每次调用被 `KEY_TAIL_WINDOW` 截到约 19200 字符。以上是静态阅读结论，未跑性能测试，不能排除极端输入下的常数放大。
- 【未核实】作者说法 1“记录里把 AWS 样例拆开、删掉 baseline 那条基线”：我确认 `scripts/machine-secret-scan-baseline.json` 里该条已删除（当前文件 129-136 行之后直接结束，diff 也显示删除），但 `.agents/reviews/` 被 `-diff` 和 sparse checkout 屏蔽，`read`/`git show` 都读不到记录内容，无法确认样例是否真的不再连续出现。若仍连续，本地 `scan-machine-secrets.mjs` 会报错；CI 侧 `scripts/ci/check-security.mjs:442-466` 用的是 **baseSha 的 baseline**，PR 里删不删那条都不影响 CI，真正决定 CI 的是记录文件本身。
- 【未核实】作者说法 2/3 的“线性”“不再往回挪到行首”：代码确实去掉了 `lineStartBefore`、`KEY_END` 只搜 `-----END`、前缀移到 `KEY_TAIL` 末尾（`:93-96`），这部分与说法一致；但正如问题 1，正向的“线性”完成了，反向的“覆盖窗口”没有完成。

## 三、侧重检查（错误路径 / 不可信输入 / 安全 / 资源耗尽 / 文档一致）

- 不可信输入：`KEY_END`/`KEY_TAIL`/`BASE64_DATA_URL` 都按不可信内容处理；`maskKeyTails` 不信任行边界，`earliest` 落在长行中间时允许从中间开始（问题是候选顺序，见问题 1）。
- 错误路径：`redactPrivateKeyFragments` 先替换完整块、再 `KEY_HEAD`、再 `maskKeyTails`；`found?.tail == null` 分支不推进游标，见问题 3。
- 安全：问题 1 是“该遮的私钥窗口没遮”的泄漏方向；`assertMachineSecretFree` 自检只能发现 **完整** 私钥块（`scanMachineSecrets` 的 `private-key-block` 规则），发现不了“残块正文漏出”，所以问题 1 不会被发送前自检兜住。`packages/application/src/services/model-egress.ts:223-237` 的兜底只对 `scanMachineSecrets` 命中的内容生效。
- 资源耗尽：见问题 3（推测）。
- 文档一致：见问题 2。另外 `KEY_LINE_PREFIX` 的 `[^\s:\\"]*?` 排除了反斜杠，Windows 风格 `C:\...\id.pem:7:` 的 grep 前缀不会被末尾 `${KEY_LINE_PREFIX}$` 吃掉；按旧代码 `fd2b3834` 的 `KEY_END` 也处理不了同样的前缀，因此这不是本轮新增，但仍是新残块规则的一个未覆盖输入（未实测）。
- 配置键/字段：`outcome: "withheld"` 已被 `packages/gateway-contracts/src/contracts-v2.ts:703` 的 `enumeration(["masked","withheld","not_saved"])`、迁移 `packages/persistence-sqlite/src/migrations/0078_sensitive_interceptions.sql:20` 的 CHECK 接受；`redacted` 字段只是被当成不透明内容嵌入，没看到拒绝它的校验。

## 四、逐条回答必答问题

### 1. 会不会改变模型已经见过的请求开头？是否仍然只在末尾追加、会变的值是否都在最后一条消息？

第 4 轮改动本身没有往系统提示、工具定义或历史里加任何“每轮会变”的值，仍然只影响“发送前对内容的遮盖”，请求结构仍是工具定义→系统提示→历史→最后一条用户消息，规则 4/5/11 的要求没有被本轮代码破坏。

但有两个需要说清楚的点：
- 由于历史存的是**遮盖前**内容、每次发送重新遮盖（`.claude/rules/prompt-prefix.md` 第 5 条），本次修改了遮盖算法后，含私钥残块的历史消息下一轮重新遮出的字节会和旧版本不同，属于一次性的前缀变化/缓存失效；问题 1 更严重，是“上一版遮住、这一版会漏出”的内容变化。
- 早先提交里的 `BASE64_DATA_URL`（`model-egress.ts:410-420`）也会改变 `data:` 开头字符串的遮盖结果（真 base64 图片放行、其它按文字遮），同样会改变老对话里这类消息的字节；这是 PR 的既有影响，不是 f2d91d6b 新增。

结论：本轮没有把每轮变化的值挪出最后一条消息，仍是“只在末尾追加”的发送方式；但遮盖结果变化会让已发历史重新遮成不同字节，需要作为“一次性缓存失效 + 可能的泄漏”处理，而不是当作纯内部重构。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

本轮新增的 `maskKeyTails` 是确定的：对同一个输入，`cursor`、`marker.index`、`earliest`、`KEY_TAIL` 都只取决于该输入本身和它前面的内容，不依赖后面的消息、时间、无序集合；`KEY_END`/`KEY_TAIL`/`nextLineStart` 没有随机性。规则 11 允许“取决于它自己和它前面的内容”，所以不违反确定性要求。

需要注意的只是既有机制：`known`/`named-earlier`（点到名的密码/验证码）本来就会让点名消息之后的文字在后续请求里多遮一些，这是规则 11 的例外，不是本轮引入。`BASE64_DATA_URL.test` 也是自包含的。因此本轮没有引入新的“同文不同字节”来源；但第 1 条的遮盖范围变化会让新旧版本之间同一段历史字节不同。

### 3. 有没有对应的自动检查？反向用例真的会失败吗？

有部分检查，但**没有覆盖第 1 条这个会出错的反向用例**：
- `test/private-key-fragments.unit.test.ts:61-67` 只覆盖“长行是最后一行”的窗口遮盖；`:69-80` 包含“长行 + 正文行 + END”这个会漏的输入，却只断言耗时，不断言遮住了长行内容，因此当前实现能通过。
- 如果把“长行 + `MIIE...` 正文行 + END”的输出断言为“不再包含长行末尾的连续 base64（例如 `A.repeat(64)`）”，按当前候选顺序会失败，能真正暴露问题 1。
- baseline 相关：`scripts/scan-machine-secrets.mjs:57-65` 的逻辑是“实际出现次数 > baseline 允许次数才报错”，删掉的条目若样例仍在会报错；但 `scripts/ci/check-security.mjs:442-466` 使用 baseSha 的 baseline，PR 内 baseline 的增删不参与 CI 判定，所以不要误以为删条目本身能修 CI。
- `test/tooling/security-machine-baseline.test.mjs` 只验证 baseline 计数语义，不覆盖这次的具体条目。

### 4. 改动产生或修改的每个值，使用它的地方都能接受吗？

- 删掉的 baseline 清单项：消费方是 `scripts/scan-machine-secrets.mjs:35-37`（allow-list）和 `scripts/ci/check-security.mjs:442-466`（从 baseSha 取 baseline）。删除一个条目不会让任何消费方要求它必须存在；本地扫描会因为“不再允许”而更严格，这正是拆分样例后的期望。CI 不读 PR 里的这份文件，所以删除对 CI 中性。唯一风险是记录文件若仍含连续 AWS 形状，本地扫描（以及 CI 的 machine/gitleaks 历史扫描）仍会报；记录不可读，标未核实。
- `KEY_END`/`KEY_TAIL`/`nextLineStart`/`lineStartBefore`：都是 `machine-secrets.ts` 内部使用，没有跨模块的序列化或校验契约；改变只影响 `redactPrivateKeyFragments` 的行为。
- `outcome: "withheld"`：`model-egress.ts:44` 生成，消费者 `sensitive-interception-recorder.ts`、`contracts-v2.ts:703`、迁移 `0078...sql:20`、控制中心 UI 都能接受（枚举/CHECK 已包含 `withheld`）。
- `redacted: true`（本 PR 早先提交）：`pi-output-export.ts:56-63` 产生，`pi-host-publication.ts:123-133` 作为不透明内容嵌入，测试 `sandboxed-coding-operations.unit.test.ts:248-253` 接受；没有看到严格 schema 拒绝额外字段。

## 五、未核实 / 本轮没做完

- 未能读取 `.agents/reviews/pr-274/round-2/...` 和 `round-3/judgments.md`（被 `-diff`/sparse checkout 屏蔽），所以“样例已拆开”“第 3 条判断的理由”都无法核对。
- 未运行任何测试，问题 3 的资源放大量是静态推测，不是实测结果。
- 未逐条比对第 3 轮 judgments 里的“不改的一条（真图片 base64 恰好含 AWS 形状）”，因为该文件读不到；只能确认当前 `BASE64_DATA_URL` 的行为（`model-egress.ts:410-420`）确实会在图片 base64 含 AWS 形状时改字节。
