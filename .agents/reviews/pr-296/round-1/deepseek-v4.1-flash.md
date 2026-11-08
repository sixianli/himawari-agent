# 复核结论

改动本身集中在 CI/安全脚本、测试和文档，没有碰模型请求组装路径。核心机制（只跑 gitleaks、复用规则摘要、扫 HEAD 祖先、复用已接受例外）方向正确；但**本地门槛并不像作者说的那样“与 CI 一样严、只差批准到期”**，这是本次最需要修的问题。

## 读代码证实的问题

### 高：本地门槛信任了未经批准的店主清单，比 CI 松，作者“只差到期”的说法不成立

- 文件:行：`scripts/ci/security-owner-review.mjs:230-240`、`scripts/ci/check-security.mjs:582-593`
- 问题：本地路径 `loadOwnerReviewManifest` 只做了清单结构检查，然后把清单里的 `secret` 条目直接构造成 `synthetic-secret` 例外交给 `applySecurityExceptions`。它不核对店主评论身份、`decision === "approved"`、`manifestSha256`、PR 编号/head、`sourceHead` 是否在 HEAD 历史内，也不核对批准是否到期。CI 的 `loadOwnerReview` 这些全做（`scripts/ci/security-owner-review.mjs:155-161`、`162-173`、`183-191`、`192-203`、`204-212`）。因此一个 `pending_owner_approval` 的清单、过期清单、或指向无关提交的清单，本地可以拿它豁免 gitleaks 发现，而 CI 会拒绝。
- 证据（本地路径）：
  ```js
  // scripts/ci/security-owner-review.mjs:230-240
  export function loadOwnerReviewManifest({ root, context }) {
    const located = readOwnerManifest({ root, context });
    if (!located) return null;
    const { bytes, manifest } = located;
    const { exceptions } = ownerReviewExceptions({
      manifest,
      bytes,
      common: { owner: owner.login, reviewReference: null, expiresAt: null },
    });
    return { exceptions, sourceSha: manifest.sourceHead };
  }
  ```
  ```js
  // scripts/ci/check-security.mjs:582-593
  const ownerReview = loadOwnerReviewManifest({ root, context });
  return {
    exceptions: [...accepted, ...(ownerReview?.exceptions ?? [])].filter(
      (entry) => entry.kind === "synthetic-secret",
    ),
  ```
  CI 路径则在 `scripts/ci/security-exceptions.mjs:216-222` 把 `ownerReview.exceptions` 与基础例外合并后再次调用 `validateSecurityExceptions`，并且 `loadOwnerReview` 在此前已经完成批准、哈希、到期、来源祖先检查。本地构造出的例外带有 `reviewReference: null`、`expiresAt: null`，也从未经过这个校验。
- 影响：按 ADR 0176 合并不等 CI；如果作者或复核者用一份过期/未批准的清单在本地跑过，gitleaks 发现会被本地放行，合入后 CI 仍变红，正好复现 I-83 要防的情况。作者说“已知差异只有本地不核对到期”，但到期本身就是一条会放行 CI 所拦状态的差异；此外还有批准身份、清单哈希、PR/来源绑定、路径 schema 等更多差异。
- 建议：本地门槛至少把构造出的 owner 例外合并后跑 `validateSecurityExceptions`，并检查 `manifest.sourceHead` 是 HEAD 的祖先；更稳妥的是本地只信任“从 base 继承、字节相同”的清单，或者要求显式环境变量才信任工作区清单。无论哪种，都应把“本地与 CI 的严格度差异”写清楚，而不是宣称只差到期。

### 中：本地完全不校验工作区里的 `ci/security-exceptions.json` 候选文件，CI 会校验

- 文件:行：`scripts/ci/check-security.mjs:566-581` 对比 `scripts/ci/security-exceptions.mjs:204-205`
- 问题：`gitleaksGateExceptions` 只从 `context.baseSha` 用 `git show` 读取已接受例外，从不读取当前工作区的 `ci/security-exceptions.json`；CI 的 `loadReviewedExceptions` 会先校验候选文件：
  ```js
  // scripts/ci/security-exceptions.mjs:204-205
  const candidate = readFileSync(join(root, exceptionPath), "utf8");
  validateSecurityExceptions(JSON.parse(candidate), { now, ruleIds, dependencies });
  ```
  因此一个修改了例外文件但内容过期/不合 schema 的 PR，本地可以过、CI 会失败。作者“本地比 CI 严或一样严”的说法不成立。
- 建议：本地也读取并校验候选文件。注意 CI 应用的是 base 文件、不是候选文件，本地可以保留“只应用 base”的语义，但至少要执行与 CI 相同的候选校验。

### 中：核心的例外/清单路径没有自动反向用例，现有测试只覆盖空例外

- 文件:行：`test/tooling/security-process.test.mjs:277-309`、`test/tooling/check-gitleaks.test.mjs:9-63`
- 问题：新增的 `runGitleaksGate` 测试使用 `securityFixture()`，而夹具的 base 提交里没有 `ci/security-exceptions.json`（`test/tooling/security-process.test.mjs:67-73` 显示 ci 文件是在提交之后才写入），也没有店主清单。因此这些测试只验证了“无例外时发现会拦下、报告坏了会抛错”，**没有一条测试覆盖**：
  - base 例外被正确消费；
  - 清单里的 synthetic-secret 被正确应用；
  - 过期/未批准清单不得在本地豁免（这正是上一条的漏洞）；
  - 允许清单里的计数/摘要不匹配时必须失败。
- 已有反向用例（发现阻断、报告不可读、平台不支持）确实会失败，设计是有效的；但门槛最关键的行为没有被测到。
- 建议：增加带 base 例外、带清单、过期清单、清单来源不在 HEAD 历史、例外摘要/数量不匹配的反向用例。`check-gitleaks.test.mjs` 也应补“下载摘要不匹配时不得解包/执行”“版本不匹配时失败”。

### 低：缓存下载不是原子写，损坏缓存不会自动恢复；并发首次运行可能失败

- 文件:行：`scripts/ci/install-tools.mjs:301-309`、`scripts/check-gitleaks.mjs:35-38`
- 问题：`downloadArtifact` 发现归档已存在就直接 `verifyDownload`，不匹配就抛错；不存在时直接 `writeFileSync(path, bytes, { flag: "wx" })` 写入最终路径。进程在写入中途被杀会留下损坏的归档，之后每次运行都因摘要不匹配失败，且没有删除重试。两个进程首次同时下载时，一个会因 `wx` 的 `EEXIST` 失败，或者在写入过程中被另一个进程读到半截内容而校验失败。
- 证据：
  ```js
  // scripts/ci/install-tools.mjs:302-309
  if (existsSync(path)) {
    verifyDownload(readFileSync(path), expected);
    return path;
  }
  const bytes = await fetchArtifact(expected, fetchImplementation, wait);
  verifyDownload(bytes, expected);
  writeFileSync(path, bytes, { flag: "wx" });
  ```
  `scripts/check-gitleaks.mjs:35-38` 对可执行文件用了 `.partial` + `renameSync`，这一处是原子的；问题只在归档缓存。
- 建议：归档也写到 `.<pid>.partial` 再原子重命名；遇到已存在但摘要不匹配的缓存时删除并重下一次（有次数上限）；测试里注入错误字节，断言不进入 `tar`/版本执行。

### 低：`gateBase` 把所有 git 错误都报成“基准缺失”，会掩盖真正的错误

- 文件:行：`scripts/check-gitleaks.mjs:47-57`
- 问题：`catch` 不区分“引用不存在”“git 不可执行”“仓库损坏”，统一抛 `GITLEAKS_BASE_MISSING`。排障时会误导。
- 建议：只在 `error.status === 1`（merge-base 无共同祖先/引用不存在）时报基准缺失，其余错误原样抛出或报 `GITLEAKS_BASE_COMMAND_FAILED`。

## 推测 / 未核实

- “下载和解包不会把被篡改的文件当成 gitleaks 运行”：**读代码成立**。`downloadArtifact` 在返回前校验 sha256（`install-tools.mjs:306-307`），`check-gitleaks.mjs:29-30` 在拿到归档后才解包。但归档校验与解包之间存在缓存目录 TOCTOU 窗口（有缓存写权限的人可在校验后替换归档），属推测，本地用户缓存场景风险低。
- “并发跑两次不会互相写坏缓存”：**部分成立**。可执行文件用原子 rename，内容不会被写坏；但两次运行不保证都成功（`EEXIST`/读到半截归档）。我未实际并发运行，失败时序是推测。
- “Hermes 上 `npm run check` 42 步通过、main 被拦 6 条、加 03f47b61 后通过”：**未核实**。当前仓库只有 `85007a7`（复核材料）和 `0590bb5`（改动）两个新提交，`03f47b61` 不在本仓库（`git show 03f47b61` 报 unknown revision）；没有 Hermes 访问权限。提交说明本身也写着“本分支要在误报修复（03f47b61 所在分支）合入 main 之后再合并，否则 main 上的 npm run check 会被这一步拦下”，这是真实的合并顺序风险，不是代码 bug。

## 作者说法逐条核对

- “拆分 `loadOwnerReview` 后，CI 路径校验一条没少、返回值相同”：**读代码成立**。改动只是把读取/构造抽成函数，`loadOwnerReview` 的评论身份、批准、到期、来源祖先和返回字段都在（`security-owner-review.mjs:133-228`）。
- “本地不会放过 CI 会拦的 gitleaks 发现，只差到期”：**不成立**，见高/中两条。除到期外，本地还跳过批准身份、清单哈希、PR/来源绑定、路径 schema、候选例外文件校验。
- “sha256 核对在解包前”：**成立**。
- “并发不会写坏缓存”：**基本成立，但会并发失败/留下损坏归档**，见低。
- “本地扫当前提交全部祖先、不扫 `--all`”：**成立**。本地把 `context.testedSha` 传给 `scanGitleaks`，CI 的 PR 路径仍用 `context.headSha`，非 PR 仍用 `--all`（`check-security.mjs:358-365`、`612-621`）。
- “CI 行为不变”：**读代码成立**，`semgrepRuleIds`/`reviewedExceptions` 抽取与旧逻辑等价。

## 侧重检查

- **错误路径**：报告不可读、空扫描、无效执行计数均抛错且不会被当成通过（`validateGitleaksExecution`、`parseGitleaksReport`），这部分可靠；`gateBase` 的错误分类会掩盖原因；缓存损坏不会自动恢复。
- **不可信输入**：gitleaks 报告的路径、行号、摘要、commit 都有校验，输出前经过 `redactText`，不会打印匹配到的原文；但店主清单被本地当成可信输入，缺少 CI 的批准/来源/schema 校验，是本次主要问题。
- **安全**：归档 sha256 在解包前校验，解包只取固定成员 `gitleaks`，不使用归档内路径写文件；规则文件也校验摘要。未发现新的明显提权或任意路径写。缓存目录的 TOCTOU 属低风险推测。
- **资源耗尽**：历史范围限制在 HEAD 祖先，报告写文件而非塞满 stdout，`maxBuffer` 有限，scratch 用完删除；未发现无界循环或不可控下载（工具锁文件固定）。
- **不可撤销操作**：只写临时目录和用户缓存，`rmSync` 只删自己的 scratch；没有删除仓库文件或改写历史。
- **规则/文档一致性**：`package.json` 确实把 `check:gitleaks` 放进了 `check:steps`，`run-all-checks` 会检查每个步骤都是真实 npm script；I-83 引用的 `scripts/check-gitleaks.mjs` 存在；`delivery-mode.md` 的描述与代码基本一致，但只说缓存目录到 `~/.cache/himawari/gitleaks/`，实际还有 `<版本>/<平台>` 子目录，且未提 `HIMAWARI_GITLEAKS_BASE`。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。全部改动在 `scripts/ci`、`scripts/check-gitleaks.mjs`、`package.json`、`docs/` 和 `test/tooling/`，没有进入系统提示、工具定义、历史消息或出口遮盖的组装路径。发给模型的内容仍然只由原有逻辑在末尾追加；本改动没有新增任何“每轮会变、却放在请求开头”的值。依据的只追加规则（`.claude/rules/prompt-prefix.md#rules`）不受影响。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   不会影响模型请求。门槛自身的输出顺序依赖 gitleaks 报告顺序（未排序），且结果依赖当前时间（例外到期）和 `origin/main` 的 merge-base，同一提交在不同时间/不同基准下可能得到不同结论；但这些都不进入模型请求，不构成 KV 缓存字节问题。

3. **有没有对应的自动检查，反向用例真的会失败？**
   有，但覆盖不完整。新增 `test/tooling/check-gitleaks.test.mjs` 和 `security-process.test.mjs` 中的门槛用例，CI 的 `policy`/`coverage` 作业通过 `testProjects.tooling.include = test/tooling/**/*.test.mjs`（`ci/policy.json`）会运行它们。已证实的反向用例包括：发现必须阻断、报告不可读必须抛错、平台不支持必须失败、历史范围不能是 `--all`。缺的是：例外/清单应用、过期或未批准清单不得豁免、下载摘要不匹配不得解包执行、缓存损坏恢复。我没有运行测试，只读代码确认了断言内容。

4. **改动产生/修改的每个值，所有使用方都能接受吗？**
   - `head` 参数：`scanGitleaks` 本地传 `context.testedSha`，CI 不传，保持原 PR/`--all` 行为；旧测试不传 `head` 仍有效（`security.test.mjs:534-573`）。✅
   - `loadOwnerReviewManifest` 返回值：唯一使用方是 `gitleaksGateExceptions`，它只取 `exceptions` 和 `sourceSha`；`reviewReference: null`、`expiresAt: null` 在本地路径没有消费者校验，这正是高严重度问题的来源。⚠
   - `check:gitleaks`：脚本存在，已在 `check:steps`，`run-all-checks` 测试会检查每一步都有真实 npm script。✅
   - `HIMAWARI_GITLEAKS_CACHE`：测试覆盖默认目录和覆盖值；`HIMAWARI_GITLEAKS_BASE` 没有测试，但错误处理路径存在。⚠
   - 退出码/状态：`runGitleaksGate` 只返回 `passed`/`failed`，入口映射为 0/1，异常为 2；`run-all-checks` 只关心非零，测试覆盖格式和失败文本。✅
   - `semgrepRuleIds`/`reviewedExceptions`：仅内部使用，逻辑与旧代码等价，现有安全测试仍调用旧签名。✅
   - I-83 里引用的路径存在，`check-incident-gates` 会检查已落门槛行的路径；文档与代码基本一致，缓存子目录和 `HIMAWARI_GITLEAKS_BASE` 的描述略有出入。⚠

总体建议：把本地门槛做成“与 CI 同一套校验”或明确更严，而不是只复用清单文件却跳过批准/来源/schema 校验；同时补上例外路径和下载完整性反向测试，再处理缓存原子写和 `gateBase` 错误分类。
