# 复核结论（f30de847 相对 b9426447 的增量，并对照 6e33c029 起的完整改动）

## 一、读代码证实的发现（按严重度）

### 1. 中（安全）：ANSI 颜色码在遮盖和私钥标记检查之后才去掉，可能把被 ANSI 切开的密钥/私钥标记还原成明文

- 文件:行：`scripts/ci/ci-summary.mjs:75-78`、`scripts/ci/ci-summary.mjs:171-173`、`scripts/ci/ci-summary.mjs:177-180`
- 问题：三处都是先 `redactText()`、先用 `PRIVATE_KEY_MARKER.test()`，最后才 `.replace(ANSI_COLOR, "")`。如果敏感值或私钥标记中间夹着 ANSI 转义，遮盖正则和标记检查都会先漏掉，随后 ANSI 被删掉，输出反而变成连续的明文。
- 证据：
  ```js
  75    const redacted = redactText(text);
  76    if (PRIVATE_KEY_MARKER.test(redacted)) return null;
  77    const lines = redacted
  78      .replace(ANSI_COLOR, "")
  ```
  ```js
  171   const redacted = redactText(String(value));
  172   if (PRIVATE_KEY_MARKER.test(redacted)) return "?";
  173   return redacted.replace(ANSI_COLOR, "")...
  ```
  `redactText` 的 key=value 规则在 `scripts/ci/redact-text.mjs:8` 要求 `[:=]\s*` 后立即出现值字符；例如 `password=\x1b[32mhunter2hunter2\x1b[0m` 中 ESC 不是值字符，规则不匹配，之后 ANSI 被删，日志里就是 `[已遮盖:credential-assignment]`。私钥同理：`-----BEGIN\x1b[31m SSH2 ENCRYPTED PRIVATE KEY-----` 先不被标记正则命中，删掉 ANSI 后标记出现，而 SSH2/PGP 私钥正文本来就不在 `redactText` 的规则里，整段正文会被显示。
- 影响：作业摘要和作业日志是公开可读的，且保留期内不可撤销；这条路径正好绕过本轮新增的“ANSI 去掉”和“私钥标记整份隐藏”。
- 建议：三处统一改成“先去 ANSI，再 `redactText`，再做 `PRIVATE_KEY_MARKER` 检查”。这样既能让被 ANSI 切开的密钥先还原再遮盖，也能让被 ANSI 切开的私钥标记被识别。并补一条反向用例：ANSI 夹在 `password=` 与值之间、ANSI 夹在 `BEGIN` 与 `PRIVATE KEY` 之间，断言输出不含明文。

### 2. 低（文档/安全）：诊断文件和命令日志的文件名没有套用私钥标记隐藏，和 ADR 的“文件名”说法不一致

- 文件:行：`scripts/ci/ci-summary.mjs:93`；`docs/adr/0243-ci-uses-no-github-artifacts.md:59`
- 问题：`safeName` 只做 `redactText` 和控制字符替换，没有 `PRIVATE_KEY_MARKER` 检查；而 `renderSummary` 的诊断文件清单、日志文件清单、footer 里的文件名都直接走 `safeName`。ADR 第 59 行写的是“用例名或文件名里带私钥开始或结束标记时，整个名字显示成 `?`”。
- 证据：
  ```js
  93  const safeName = (value) => redactText(value).replace(/[\p{Cc}\p{Zl}\p{Zp}`|]/gu, "?");
  ```
  ```js
  114   .map((entry) => `\`${safeName(entry.relative).slice(0, 40)}\``)
  123   const name = safeName(file.relative);
  ```
  对比 `cleanLine`/`failureMessage` 已经有 `PRIVATE_KEY_MARKER` 检查（171-172、177-178）。
- 影响：测试名和 vitest 报告路径会被隐藏，但 `.ci-output/public/diagnostics` 或 `reports` 里一个名为 `[已遮盖:private-key-header].log` 的文件仍会把标记打印出来；文件名里若塞入私钥正文，`safeName` 也不会遮盖 SSH2/PGP 正文。标记本身不是密钥，但与本轮“文件名也显示成 `?`”的承诺不符。
- 建议：把标记检查放进 `safeName`（或抽一个统一的“安全名字”函数），并补一条文件名带标记的反向用例。

### 3. 低（边界）：footer 预留只保证“已显示文件之后的省略”，第一份文件就放不下时没有校验 footer 是否仍在上限内

- 文件:行：`scripts/ci/ci-summary.mjs:128-131`
- 问题：新算法在尝试加入第 k 份文件时，用 `footerFrom(k+1)` 预留；如果第 k 份放不下，实际压入的是 `footerFrom(k)`。对 k≥1 这是安全的：上一轮加入第 k-1 份时预留的正是 `footerFrom(k)`，条件保证 `used + footerFrom(k) <= limit`。但 k=0 没有上一轮，若第一份就放不下，代码直接 `sections.push(footerFrom(0))`，没有检查 `header + footerFrom(0)` 是否超过 `limit`。
- 证据：
  ```js
  128    const reserve = shown + 1 < files.length ? Buffer.byteLength(footerFrom(shown + 1)) : 0;
  129    if (used + Buffer.byteLength(section) + reserve > limit) {
  130      sections.push(footerFrom(shown));
  131      break;
  ```
- 影响：真实预算下不会触发。诊断摘要的 `limit` 是 64 KiB，单份 section 最多约 60 KiB；失败日志段剩余预算默认至少约 32 KiB，而 footer 最多约 700 字节。只有调用方传入小于约 700 字节的 `limit` 时才会超限。现有“多字节文件名”测试从 `first+800` 起循环，覆盖不到这个 k=0 分支。
- 建议：k=0 分支也应校验 `header + footerFrom(0) <= limit`（放不下就不写 footer 或截断 footer），或者把预留改成 `max(footerFrom(shown), footerFrom(shown+1))` 并在压入 footer 前再检查一次；补一条 `limit` 小于 header+footer 的用例。

### 4. 低（文档）：ADR 主句仍写“放不下的文件只报数量”，与补充和代码矛盾

- 文件:行：`docs/adr/0243-ci-uses-no-github-artifacts.md:58-59`；代码 `scripts/ci/ci-summary.mjs:111-117`
- 问题：第 58 行仍说“放不下的文件只报数量”，第 59 行补充说“上面‘只报数量’的说法从此改为列出前 5 个名字”，代码也确实列出前 5 个名字。补充虽然自认了矛盾，但主句没有改，后续读者只看第 4 条会得到错误结论。
- 证据：
  - 第 58 行：“…放不下的文件只报数量。”
  - 第 59 行：“…放不下的文件列出前 5 个名字（上面“只报数量”的说法从此改为列出前 5 个名字，诊断那一段也一样）。”
- 建议：直接把第 58 行改成“放不下的文件列出前 5 个名字”，补充里保留日期说明即可。

## 二、推测 / 未完全核实

- **硬链接绕过（推测，低）**：`readJsonInside` 用 `realpath` 防符号链接，但硬链接的 `realpath` 仍在 `reports/` 内，`lstat().isFile()` 也通过。若测试进程能在同一文件系统上创建指向目录外文件的硬链接，仍可读到目录外内容。`publish.mjs` 上游的 `reportEntry` 也只防符号链接，所以这不是本轮新增的边界；是否可利用取决于 CI 用户权限和文件系统。未实测。
- **realpath 与 readFileSync 之间的 TOCTOU（推测，低）**：`lstatSync` → `realpathSync` → `readFileSync` 之间存在竞态，后台进程可在检查后把文件换成指向目录外的符号链接。更稳妥的是 `openSync(..., O_NOFOLLOW)` 后 `fstatSync` 并从 fd 读取，再核对 fd 的真实路径。考虑到测试代码本身已经能以同一权限读取文件，这属于纵深防御，不是本轮必须修。
- **聚合资源上限（推测，低）**：每个 JSON 限 64 MiB，但 `failedTests` 会把所有报告里的失败项（含报错字符串）先全部收集到数组再截断到 30 条；`result.reports` 里的报告数量没有聚合上限。大量 64 MiB 报告可能造成内存压力。`publish.mjs` 在更早阶段已经完整读取所有文件，因此不是本轮新增的主要风险。
- **最终组件是符号链接时会被误拒（已读代码，非问题）**：`lstatSync(full).isFile()` 对“最终组件是符号链接”返回 false，所以即使它指向 `reports/` 内也会被拒绝；只有中间目录的符号链接会被 `realpath` 放行。这比 ADR 的“解析符号链接后仍在目录内”更严格，当前 publish 也不会产生符号链接，因此不构成实际误拒。
- **报告目录本身是符号链接**：按代码推演不会误拒。`realpathSync(reports)` 解析到真实目录，`realpathSync(full)` 也解析到同一真实目录下，`startsWith(真实目录 + 分隔符)` 成立。未在测试里覆盖。

## 三、侧重检查

- **不可信输入 / 路径穿越**：`reportPaths` 过滤绝对路径和含 `..` 的段；`readJsonInside` 再做 `lstat` 普通文件、64 MiB 上限、`realpath` 前缀检查。测试覆盖了 `../`、绝对路径、中间目录符号链接、最终组件符号链接四种写法，反向用例有效。硬链接和 TOCTOU 见上。
- **错误路径**：`reports` 不存在 → 空；`result.json` 读不出 → 只写一句说明；文本读取失败 → 按二进制只列名字和大小；`details.json` 缺失/损坏 → 不优先排序，不抛错。`listFiles`/`readdirSync` 的权限错误仍会向上抛出并让摘要步骤失败，这是原有行为，不是本轮引入。
- **安全 / 遮盖**：发现第 1 条（ANSI 顺序）和第 2 条（文件名标记）。`redactText` 本身不覆盖 SSH2/PGP 私钥正文，完全依赖标记检查；因此第 1 条对私钥尤其重要。
- **资源耗尽**：单文件 64 MiB 有上限；无聚合上限，见“推测”。
- **不可撤销操作**：只追加 `GITHUB_STEP_SUMMARY` 和写 stdout，不删除文件；一旦泄露在保留期内不可撤销，所以上面的遮盖顺序问题值得优先修。
- **规则/文档/代码一致性**：`ci.yml` 六个检查作业的 `--failed-logs .ci-output/public/reports` 与 `check-policy.mjs:563` 的逐字比对一致；`policy.test.mjs` 的两个反向变体会真正失败；三个数字常量与 ADR/设计文档一致。ADR 主句矛盾见第 4 条；文件名标记的文档与代码差异见第 2 条。

## 四、必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。本次改动只涉及 CI 摘要脚本、`ci.yml`、策略检查和测试/文档，没有触碰系统提示、工具定义、历史消息或模型请求的出口遮盖。发给模型的内容仍然只在末尾追加，每轮变化的值也没有被挪到请求开头；就仓库代码而言，这份摘要只写 `GITHUB_STEP_SUMMARY` 和作业日志，不进入模型请求组装。若某个外部代理自行把作业日志塞进自己的提示，那是代理侧行为，不在本 diff 的代码里，未核实。

2. **同一段文字会不会在不同请求里变成不同字节？**
   不会引入不确定性。`listFiles` 按相对路径排序，`reportPaths(...).sort()` 排序，`Set` 只用于成员判断而不参与输出顺序，输出里没有时间字段；同样的输入文件得到同样的摘要字节。这里说的“请求”如果指模型请求，本改动根本不参与；如果指摘要/日志文本，它是确定性的。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有。`test/tooling/ci-summary.test.mjs` 新增了目录外路径、多字节文件名上限、三个数字、用例名私钥标记等用例；`test/tooling/policy.test.mjs` 新增了 `no failed logs` 和 `wrong failed logs folder` 两个反向变体。按代码推演：
   - 去掉 `realpath` 检查，`link/linked.json` 会被读取，测试中会出现 `outside`，用例失败；
   - 去掉 `cleanLine` 的私钥标记检查，用例名会显示标记和 `keybody`，用例失败；
   - 去掉或改错 `--failed-logs`，`validateWorkflow` 的逐字比对会抛错，两个策略用例失败。
   未覆盖的反向场景：ANSI 夹在敏感值/私钥标记中间、诊断文件名带标记、`limit` 小到第一份文件放不下、报告目录本身是符号链接、硬链接。这些正是上面第 1、2、3 条和“推测”里的缺口。

4. **改动产生或修改的每个值，使用它的地方都能接受吗？**
   - `--failed-logs` 标志和 `.ci-output/public/reports` 路径：`ci.yml` 六个检查作业产生，`check-policy.mjs:563` 逐字要求，`ci-summary.mjs` 的 `main` 参数解析接受；检查 id 与 `ci/policy.json` 的 `id` 一致，两端匹配。
   - footer 新格式：只有测试和人类读者消费，`ci-summary.test.mjs:68-70` 已同步；没有其他代码解析旧文案。
   - 私钥标记的 `?`：`cleanLine`/`failureMessage` 产生，`renderFailedTests` 消费，用例名和测试文件名两端一致；但诊断/日志文件名走 `safeName`，没有同样的标记检查，文档承诺与代码不一致（第 2 条）。
   - `readJsonInside` 的“普通文件 / 64 MiB / realpath 在目录内”约定：`result.json`、`details.json`、vitest 报告三个入口统一使用，和 ADR 第 59 行一致；最终组件符号链接比文档更严格，但没有合法生产者。
   - 三个数字 20/120/30：代码常量与 ADR、设计文档一致。
   - `details.json` 的命令名：`failedCommandLogs` 产生 `${name}.log`，`first` 用 `path.posix.basename(relative)` 比较；当前 `run.mjs` 的命令名都不含斜杠，所以一致。如果将来命令名带目录，失败命令优先排序会静默失效，这不是当前改动的问题，但值得留意。
