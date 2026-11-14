## 一、读代码证实的问题（按严重度）

### 1. 中：同一份 `summary` 进了两个公开出口，作业摘要遮盖了、步骤日志没遮盖
- 严重度：中
- 位置：`scripts/ci/required.mjs:72`（写入日志） 对 `scripts/ci/required.mjs:39`（写作业摘要前遮盖）；`scripts/ci/gate-log.mjs:15-22`；`scripts/ci/aggregate.mjs:141,234`
- 问题：`required.mjs` 先用 `encodeGate({ context, summary })` 把整份 `summary` 原样 base64 打进 `ci/required` 的公开步骤日志，随后才用 `cell()`（内含 `redactText`）渲染作业摘要表。`summary.checks[].reasons` 和 `summary.failures[].reason/source` 都在 `summary` 里，日志那一端没有任何遮盖。第 2 轮新增的测试只验证 `gateSummaryMarkdown`，没有验证 `encodeGate`。
- 证据：
  - `required.mjs:72`：`write(encodeGate({ context, summary }));`
  - `required.mjs:39`：`const cell = (value) => redactText(String(value)).replace(/[\p{Cc}|`]/gu, " ");`
  - `gate-log.mjs:15,18`：`const json = JSON.stringify({ context, summary });` … `bytes.toString("base64")`
  - `aggregate.mjs:141`：``fail(checkId, matrixKey, source, `Unsafe report path: ${report.path}`);``，第 234 行再把这些 `reason` 放进 `checks[].reasons`。
  - 第 2 轮测试 `test/tooling/ci-summary.test.mjs:130` 自己把 `` `... ${secret}` `` 放进 `reasons` 并断言作业摘要不含它，说明作者认为 `reasons` 可能带密钥。
- 建议：在 `encodeGate` 之前对 `reasons`/`failures[].reason`/`failures[].source` 统一做遮盖（或在 `aggregate` 生成字符串时就遮盖），让日志和作业摘要两端用同一套规则；并补一条断言日志不含 secret 的反向测试。注意 `verifyGate` 只接受 `reasons` 为空的 passed gate（`main-evidence.mjs:231`），遮盖失败路径的 `reasons` 不会破坏轻量路径。

> 读代码证实的是“两个出口处理不一致”；端到端是否真能泄漏见下面“推测”。

### 2. 中：截断只读文件尾部，会切断多行遮盖的上下文
- 严重度：中
- 位置：`scripts/ci/ci-summary.mjs:54-57,65`；`scripts/ci/redact-text.mjs:2`
- 问题：文件大于 `READ_LIMIT_BYTES` 时，从读到的块里找到第一个 `0x0a` 后直接丢掉前面的字节，再对剩下的文本做 `redactText`。被丢掉的“半行”里如果正好是 `-----BEGIN ... PRIVATE KEY-----` 的开头，后面完整的私钥正文就不再匹配 `BEGIN...END` 正则，会原样出现在公开作业摘要里。单行模式（`Bearer`、`key=`）不受影响，因为它们在同一行内整行被丢；受影响的是 PEM 这种跨行模式。
- 证据：
  - `ci-summary.mjs:54-57`：
    ```js
    if (file.size > bytes.length) {
      const newline = bytes.indexOf(0x0a);
      if (newline < 0) return null;
      bytes = bytes.subarray(newline + 1);
    }
    ```
  - `ci-summary.mjs:65`：`const lines = redactText(text)`
  - `redact-text.mjs:2`：`/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END .../g`
- 建议：在丢弃半行之前先检查这段前缀是否含有 `BEGIN ... PRIVATE KEY` 之类的多行敏感开头，若有可能被切断就直接按二进制处理（fail closed）；或者改成在遮盖之后再截断（对超大文件可用流式遮盖），不要先丢上下文再遮盖。

### 3. 低：ADR 0243 决定 2 仍按旧语义描述 `ci/required` 作业挑选
- 严重度：低
- 位置：`docs/adr/0243-ci-uses-no-github-artifacts.md:56`；代码 `scripts/ci/main-evidence.mjs:162-171`；设计文档 `docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:291`
- 问题：新代码先按名字取所有 `ci/required`，要求恰好一个，再对这个作业检查 run/attempt/status/conclusion。因此“一个成功 + 一个失败的 `ci/required`”现在会被拒绝，而 ADR 决定 2 仍写“只认唯一一个名字是 `ci/required`、结论为成功、运行号和尝试号都对得上的作业”，按旧 filter 语义会忽略失败的那个。设计文档第 291 行已经改成“要求名字是 `ci/required` 的作业恰好一个且结论为成功”，两份文档自相矛盾。
- 证据：
  - `main-evidence.mjs:162`：`const gates = jobs.jobs.filter((job) => job.name === "ci/required");`
  - `main-evidence.mjs:163-171`：`gates.length === 1 && ... conclusion === "success"`
  - ADR:56：“只认唯一一个名字是 `ci/required`、结论为成功、运行号和尝试号都对得上的作业”
  - 设计文档:291：“要求名字是 `ci/required` 的作业恰好一个且结论为成功”
- 建议：把 ADR 决定 2 改成与设计文档/代码一致的“名字是 `ci/required` 的作业恰好一个，再要求其成功且 run/attempt 对得上”。

### 4. 低：设计文档“作业摘要总量不超过 64 KiB”与 `quality.yml` 的两次摘要不一致
- 严重度：低
- 位置：`docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:320`；`scripts/ci/ci-summary.mjs:14`；`.github/workflows/quality.yml:44-49`（其余 job 类似）；`scripts/ci/quality-policy.mjs:147-148`
- 问题：`renderSummary` 每次上限 64 KiB，但 `quality.yml` 每个 job 调两次 `ci-summary`（“检测结果”和“失败诊断”），两次都追加到同一个 `GITHUB_STEP_SUMMARY`，所以单个作业的摘要总量可达约 128 KiB。设计文档第 320 行的“作业摘要……总量不超过 64 KiB”按字面不成立。
- 证据：
  - `ci-summary.mjs:14`：`export const SUMMARY_LIMIT_BYTES = 64 * 1024;`
  - `quality.yml:46,49`：两个 `ci-summary.mjs --title ...` 步骤
  - `quality-policy.mjs:147-148`：`summary(\`${check} 检测结果\`, ...)`、`summary(\`${check} 失败诊断\`, ...)`
- 建议：把文档改成“每段摘要不超过 64 KiB”，或在调用方合并成一次 `ci-summary`/强制一个作业级总预算。

### 5. 低：ADR 决定 4 对“找不到换行就按二进制”缺少“被截断后”限定
- 严重度：低
- 位置：`docs/adr/0243-ci-uses-no-github-artifacts.md:58`；代码 `scripts/ci/ci-summary.mjs:54-58`
- 问题：代码只在 `file.size > bytes.length`（即文件确实超过 256 KiB）时才把“没有换行”当二进制；完整的、小于 256 KiB 的单行文件仍按文本显示。ADR 写成“读到的部分含 NUL 字节或找不到换行时按二进制处理”，丢掉了“被截断后”这个前提，比代码严。
- 证据：`ci-summary.mjs:54-57` 的新行判断在 `if (file.size > bytes.length)` 内。
- 建议：ADR 补上“被截断后”四个字，和作者说明及设计文档保持一致。

### 6. 低：设计文档仍残留 GitHub 产物说法，作者“去掉残留说法”的说法不完整
- 严重度：低
- 位置：`docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:357,394`
- 问题：作者说明称“设计文档去掉残留的 GitHub 产物说法”，但失败类型表仍写“下载、runner 或 artifact 服务不可用”，参考链接仍列“Actions artifact 下载权限”。前者可能是泛指内部构建产物/服务，后者明确是 GitHub Actions artifact 文档。
- 证据：
  - :357：`| 下载、runner 或 artifact 服务不可用 | ...`
  - :394：`- [Actions artifact 下载权限](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts)。`
- 建议：确认 :357 的“artifact 服务”是否指内部共享目录；:394 要么删掉，要么改成与 ADR 0243 一致的表述。

### 7. 低：截断读取的测试缺口与短读处理
- 严重度：低
- 位置：`scripts/ci/ci-summary.mjs:44`；`test/tooling/ci-summary.test.mjs:65-92`
- 问题：
  - `readSync` 的返回值没检查。文件在 `lstat` 之后变小或发生短读时，`Buffer.alloc` 剩余部分是 0，会因 `bytes.includes(0)` 被判为二进制。行为是 fail-closed，安全，但依赖 zero-fill 实现，比较隐晦。
  - 新增的“超大文件”用例把截断点落在连续的 `'h'` 里，没有覆盖“256 KiB 边界正好落在多字节 UTF-8 字符中间”的场景，也没有覆盖 stat 之后文件变大/变小的场景。
- 证据：`ci-summary.mjs:44`：`readSync(handle, bytes, 0, length, file.size - length);`（未接收返回值）
- 建议：显式检查 `bytesRead !== length` 并按二进制处理；补一条把多字节字符放在截断边界的用例，以及一条文件在 stat 与 read 之间变化的用例。

## 二、推测/未证实

- **问题 1 的端到端可利用性未证实**：正规流水线里 `result.json` 在 `publish.mjs`/`redactReport` 阶段已经对字符串值做过 `redactText`（`publish.mjs:35-42`），`assertPublicArtifacts` 也对内容做过检查，所以进入 `aggregate` 的 `report.path` 很可能已经是 `[REDACTED]`。因此“日志泄漏”目前只是两端处理不一致，是否真能从 PR 可控输入走到日志里，未做端到端复现。
- **控制字符只清 `Cc`，不清 `Cf`**：`ci-summary.mjs:68` 的 `\P{Cc}` 不会处理 U+202E（双向覆盖）、零宽字符这类 `Cf`，可能用来在公开作业摘要里做视觉伪装。不是本次新增代码引入的，影响未验证。
- **`lstat` 与 `open` 之间的 TOCTOU**：`listFiles` 用 `lstat` 过滤非普通文件，但 `readTail` 再 `openSync`。若普通文件在两步之间被换成 FIFO，`openSync` 可能阻塞。CI 诊断目录不是直接暴露给外部的输入，实际风险很低，未验证。

## 三、侧重检查

- **错误路径与不可信输入**：读了 `ci-summary.mjs` 的空文件、<256 KiB、=256 KiB、>256 KiB、截断后无换行、NUL 在头/尾、无效 UTF-8、文件名含控制字符/反引号/竖线、多字节边界、文件变大变小、短读、符号链接/非普通文件等路径。`lstat` 只收 `isFile()`，`safeName` 清理 `Cc`/`` ` ``/`|`，NUL 和无效 UTF-8 都走二进制，控制字符在遮盖之后替换，没有发现崩溃路径；发现“截断切断多行遮盖上下文”（问题 2）和短读未检查（问题 7）。
- **安全**：核对遮盖顺序为“先 `redactText` 再控制字符替换”，控制字符替换不会撤销 `[REDACTED]`，也不会引入反引号破坏代码块；发现公开日志未遮盖（问题 1）、PEM 上下文可被截断（问题 2）、`Cf` 未处理（推测）。
- **资源耗尽**：`readTail` 最多分配/读取 256 KiB，超大文件不再 `readFileSync` 全读，内存有界；`renderSummary` 输出有 64 KiB 上限（单次调用）；`listFiles` 递归不限制文件数量，但每次只读一个文件，未见新的无界内存。问题 4 是多次调用叠加的上限问题。
- **不可逆操作**：`ci-summary.mjs` 只读文件并 `appendFileSync`，没有删除；`run-share.mjs remove` 未在本次增量改动。没有新增不可逆操作。
- **规则/文档与代码一致性**：核对了 ADR 决定 2/3/4、设计文档 291/320/357/394、`main.yml`/`main-confirm.mjs`（重新 `discover`、失败在 `MAIN_EVIDENCE_NO_LONGER_VALID`）、`quality.yml`（无 shared dir）、`main-workflow.mjs`/`quality-policy.mjs` 的硬校验。决定 3/4 与代码一致；发现决定 2 措辞（问题 3）、64 KiB（问题 4）、ADR 缺“被截断后”（问题 5）、残留 artifact 说法（问题 6）。
- **`ci/required` 作业挑选**：确认新写法没有放宽条件，反而更严（见必答问题 3）。

## 四、必答问题

**1. 会不会改变模型已经见过的请求开头？**

不会。本次完整 diff 只涉及 `.github/`、`ci/`、`docs/`、`scripts/ci/`、`test/tooling/`、`.agents/`，没有改动 `packages/`、`apps/` 里的系统提示、工具定义、历史存储或出口遮盖代码。CI 摘要不是发给模型的内容。因此模型请求仍然只在末尾追加，每轮变化的值仍应放在最后一条消息；本 PR 不涉及遵守/违反这条规则的问题。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**

不会（对模型请求而言）。本 PR 没有模型请求路径。就 CI 输出来说，`renderSummary` 按相对路径排序、不含时间戳，同样输入产生同样字节；诊断文件内容本身随运行变化是预期的，也不会进入模型请求。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**

有，且反向用例在旧代码上会失败：
- `ci-summary.test.mjs:65-77`“超大文件只读末尾一段，控制字符被替换”：旧代码不做控制字符替换、且整文件读取，`expect(text).not.toContain("\u001b")` 会失败；无换行的大文件旧代码会当文本，`toContain("二进制文件")` 会失败。
- `ci-summary.test.mjs:78-84`“NUL 出现在文件末尾”：旧代码只抽样前 8192 字节，末尾 NUL 检测不到，会失败。
- `ci-summary.test.mjs:85-92`“最后一个文件放得下时不因预留的说明文字被挤掉”：旧代码总把 footer 加进比较，会丢掉该 section，会失败。
- `test/tooling/main-evidence.test.mjs:268-269` 的 `extra-failed-gate-job`：旧 filter 会排除失败的 `ci/required`，接受成功那个，测试会失败。
- `ci-summary.test.mjs:118-139` 的 `gateSummaryMarkdown` 遮盖/转义：去掉 `redactText` 或 `|`/换行替换，断言会失败。

缺口：没有“截断边界落在多字节字符中间”的用例、没有 stat/read 之间文件变化的用例；也没有断言 `encodeGate` 打出的日志不含 secret 的用例——这也正是问题 1 没被自动检查挡住的原因。

**4. 改动产生或修改的每个值，两端能否接受？**

逐个核对结果：
- `READ_LIMIT_BYTES = 256*1024`：只在 `ci-summary` 的 `readTail` 和测试里使用；文档统一写 256 KiB，一致。
- `FOOTER_RESERVE_BYTES = 256`：只在 `renderSummary` 内部使用；footer 模板按字符估算约 71–77 字节（“其余”6 + 空格 + 数字 + “个文件超出”15 + 空格 + `65536` 5 + “字节的摘要上限，没有显示。”39 + 换行），远小于 256；footer 真正写入时 `used ≤ limit-256`（或只有 header），所以单次 `renderSummary` 不会超过 64 KiB。若 `title` 异常长导致 header 本身超限，则另说；workflow 里的 title 都是固定短串。
- `MAIN_GATE_JOB_REQUIRED`：由 `discoverEvidence` 产生，`main-evidence.main` 的 catch 用 `/^MAIN_[A-Z_]+$/` 接受，`main-confirm` 再按 `mode !== "light"` 统一报 `MAIN_EVIDENCE_NO_LONGER_VALID`；两端都能接受，且新语义更严（不会放宽）。
- `summary.checks[].reasons` / `summary.failures[].reason/source`：`gateSummaryMarkdown` 会遮盖和转义，`encodeGate` 不会（问题 1）。
- `gateSummaryMarkdown` 的表格行：`cell` 把 `Cc`、`|`、`` ` `` 换成空格，测试断言每行恰好 5 段、伪造行不出现，生产端写 `GITHUB_STEP_SUMMARY` 能接受。
- 文档里的“恰好一个 `ci/required`”“256 KiB”“64 KiB”“找不到换行按二进制”：与代码分别存在问题 3、4、5 的不一致；`ci/required` 实际行为与设计文档 291 行一致。

**问题 3 的明确回答**：新写法没有放宽任何原有条件。旧代码是把 run/attempt/status/conclusion 放进 filter 再要求唯一；新代码先要求名字恰好一个，再要求同一个作业满足 run/attempt/status/conclusion。区别只在于“额外的失败/错 attempt 的 `ci/required` 作业”以前被 filter 忽略、现在会导致拒绝，属于收紧，不属于放宽。
