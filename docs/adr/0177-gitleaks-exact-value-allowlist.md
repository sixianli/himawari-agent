---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: "docs/adr/0157-gitleaks-allowlist-for-evidence-digests.md"
amended_by: "docs/adr/0190-mask-registered-test-values-in-review-records.md"
date: "2026-11-07"
---

# ADR 0177：例外清单收不下的个别误报，用“规则 + 单一路径 + 精确值”的 Gitleaks 白名单放行

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [Andy 的原话](#owner-decisions)
- [决定](#decision)
- [与 ADR 0157 的关系](#amendments)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

CI（每次推送后 GitHub Actions 自动跑的检查）的 security 检查（`scripts/ci/check-security.mjs`）用 Gitleaks（一个按规则找密钥的扫描程序）8.30.0 扫两遍：一遍扫当前文件，一遍扫 git 历史。它的默认规则 `generic-api-key`（“看起来像 API 密钥”的通用规则）会把一些不是密钥的值认成密钥，例如测试里的合成令牌、幂等键（防止同一请求被重复执行的标识）、文件摘要。

发现这类误报，原先只有两条路：

- **逐条例外**（`ci/security-exceptions.json`）：每条精确到路径、规则、摘要和次数，最长 30 天到期。规则 `scripts/ci/security-exceptions.mjs` 只接受测试目录下的路径（`test/`、`ci/rules/fixtures/`、`apps/*/test/`、`packages/*/test/`），别处的命中一律报 `REAL_SECRET_CANNOT_BE_EXCEPTED`；合成令牌还要求那一行符合 `classifiedLiteral` 认得的几种写法（例如含 `idempotencyKey` 的行才算幂等键样例）。
- **形状白名单**（[ADR 0157](0157-gitleaks-allowlist-for-evidence-digests.md)）：只用于资格证据目录里“源码路径: 文件摘要”这种成批、形状固定的误报，按整行形状放行。

有些误报两条路都走不通：

- PR 273 的代码复核记录（`.agents/reviews/pr-273/` 下，复核模型的答案原样入库）里，模型引用了测试里的合成启动令牌。它不在测试目录下，例外清单不收；它也已经进了 git 历史，删文件挡不住历史扫描。
- `apps/agent-service/test/production-http-composition.unit.test.ts` 里的幂等键，命中的那一行写的是请求头 `"idempotency-key"`，不符合 `classifiedLiteral` 的写法。
- `test/tooling/gitleaks-allowlist.test.mjs` 里核对回读文件那一行用的文件摘要，也不符合任何一种写法。

2026-11-05 合并的 PR 248（提交 bd0859a9；Andy 2026-11-04 批准）在 `ci/rules/gitleaks.toml` 里加了八块白名单处理同类误报，但没有写进 ADR。PR 275 之前，ADR 0157 第 1 条和 Spec 都只写着“个别具体的值仍按逐条例外处理”，文档和代码不一致；PR 275 随本 ADR 一起更新了 Spec，ADR 0157 用 `amended_by` 指向本 ADR。2026-11-07 的 PR 275 复核时，GLM 指出了这处不一致。这八块是：

- 六块按 `regexTarget = "secret"`（只看 Gitleaks 认出的那个值）放行。其中五块各锚定一个精确值；另一块（已删除的 `apps/agent-service/test/production-reminder-push.unit.test.ts` 里的合成值）写成“固定前缀 + 任意 7 个字符”。git 历史里这个前缀只出现过 `F5u42Bd3HyW8KxkUqo2gRA` 一个值，PR 275 把它收紧成这个精确值。
- 两块按 `regexTarget = "match"`（看 Gitleaks 命中的那一段文字）放行，都只覆盖一个文件：已删除的 `.agents/tasks/round2-tool-execution/evidence.jsonl` 在 git 历史里的“文件名: 40 位 git 对象号”行（写成形状，因为历史里有许多不同的对象号），和一份资格证据回读文件里那一整段摘要（精确值）。

[↑ 返回阅读导航](#contents)

<a id="owner-decisions"></a>

## Andy 的原话

- PR 248 的提交说明记着：“Andy 2026-11-04 批准白名单方案和‘51 条按现状续期 30 天’”。那个 PR 里的白名单方案就包括上面八块。
- 2026-11-07，线程问“要不要我开这个小 PR，为这 5 处误报登记例外？”，Andy 答：“需要”。线程随后发现例外清单收不下这几处，改用本 ADR 的做法；这一改动在 PR 275 的说明里写明，由 Andy 决定是否合并。
- 2026-11-07，Andy 在项目聊天交代新任务：让 main 上 security 检查不再被 PR 274 带进来的 3 处误报拦下（复核记录两处私钥开头标记的引用、`pi-coding-program.unit.test.ts` 里的假私钥结尾），照 PR 275 的做法用“规则 + 路径 + 精确值”的白名单，并要求放宽有反向用例、范围尽量窄；用哪套机制由线程判断并写明理由，理由见决定第 2 条和第 5 条。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **先走逐条例外。** 误报能登记进 `ci/security-exceptions.json` 的，照旧登记。
2. **例外清单收不下时，用精确值白名单。** 这一条约束此后新加的每一块。收不下指：命中在测试目录之外（例外规则报 `REAL_SECRET_CANNOT_BE_EXCEPTED`），或者那一行不符合 `classifiedLiteral` 的任何一种写法。这时在 `ci/rules/gitleaks.toml` 末尾加一块 `[[allowlists]]`，每块必须同时满足：
   - `condition = "AND"`，`targetRules` 只列一条规则；
   - `paths` 只有一个正则，锚定到具体文件（不得放行整个目录）；
   - `regexTarget = "secret"`，`regexes` 只有一个正则，用 `^…$` 锚定那一个精确值（不得写成字符类，例如“任意 32 位十六进制”）；
   - `description` 写明这个值是什么、为什么不是密钥。
3. **PR 248 那两块按命中片段放行的白名单照旧保留。** 它们不满足第 2 条的 `regexTarget = "secret"`，也不满足 ADR 0157 的 `regexTarget = "line"`，但都只认一个文件：一块只覆盖已删除文件的 git 历史，那个文件不会再出现新内容；另一块锚定一整段精确文字。改用第 2 条的写法要重新核对历史里每一个命中，收益很小，所以不改；`test/tooling/gitleaks-allowlist.test.mjs` 分别核对它们的路径和值的正反例。
4. **改动都要有测试。** `test/tooling/gitleaks-allowlist.test.mjs` 核对每块的形状、路径正反例，以及“改一个字符就不放行”（包括改成同类字符，挡住放宽成字符类）；新加或改动的块，还要在 `test/tooling/gitleaks-config.test.mjs` 里加样例，用锁定版本的真实 Gitleaks 核对放行的文件不再报、同一个值出现在别的文件里照报。`ci/toolchain-lock.json` 里 `ci/rules/gitleaks.toml` 的 sha256 同步更新。
5. **命中值是一整段文字时，按固定开头放行。** 复核记录里引用私钥开头标记的文字，会被 `private-key` 规则连同后面直到下一个结束标记的说明文字一起认成一个命中，这段命中值有几百个字符，没法写成精确值。这种情况下 `regexes` 仍只有一个正则，锚定命中值的固定开头（`^` 加标记和紧跟的那几个词，不用字符类），`paths` 锚定到那一个记录文件，并且每个开头单独一块。只用于已经进了 git 历史、内容不会再变的记录文件。PR 274 第 7 轮复核记录（`.agents/reviews/pr-274/round-7/deepseek-v4.1-flash.md`）的第 37 行和第 117 行用这一条放行，`test/tooling/gitleaks-config.test.mjs` 核对同一目录别的轮次、同一文件里别的文字都照报。
6. **只放行已经核实不是密钥的值。** 加白名单之前，先确认它是合成样例、标识或摘要，不是任何真实凭据。真密钥误入仓库时，按真密钥处理（轮换），不加白名单。

取舍依据的原则：这是在“边界与可逆性”和“主动性与效率”之间取舍。白名单不会像例外那样 30 天到期，边界放松了一点；所以每块只认一个文件里的一个值，比例外清单（按路径、规则、摘要和次数）只宽在“没有到期日、不核对次数”。

[↑ 返回阅读导航](#contents)

<a id="amendments"></a>

## 与 ADR 0157 的关系

ADR 0157 第 1 条写“个别具体的值（合成 token、示例密码等）仍按规范走逐条例外”。本 ADR 部分修正（amend）这一条：逐条例外仍是首选，例外清单收不下时按本 ADR 第 2 条用精确值白名单。ADR 0157 关于资格证据摘要的形状白名单不变，继续有效。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- **放宽例外规则，让它接受测试目录以外的路径。** 不采用：例外清单只收测试目录，是为了防止真实代码或配置里的值被当成样例豁免；为几处记录文件放开它，影响面更大。
- **删掉复核记录里的令牌。** 不采用：记录已经进了 git 历史，历史扫描仍会报；改写已推送的历史违反项目规则。
- **按目录放行 `.agents/reviews/`。** 不采用：复核记录是模型写的，以后可能原样引用真实格式的密钥，按目录放行会把它们一起放过。
- **白名单正则写成字符类（例如任意 32 位十六进制）。** 不采用：同形状的真实密钥也会被放过。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 精确值白名单没有到期日，不会被定期重审；值所在的文件改名或删掉后，白名单块不会自动失效，要在改动那个文件时一起清理。
- 以后复核模型在新的记录里再引用已登记的测试令牌，由复核脚本写记录时遮掉（见 [ADR 0190](0190-mask-registered-test-values-in-review-records.md)），不再需要为引用再加白名单块；没登记过的新假值第一次被引用时，security 检查仍会报，要按本 ADR 加一块。
- 白名单写进 `gitleaks.toml`，改它要改 `ci/toolchain-lock.json` 的摘要，所以每次改动都会经过代码复核。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0157](0157-gitleaks-allowlist-for-evidence-digests.md)：资格证据摘要的形状白名单。
- [GitHub CI 与质量门禁设计](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md#security-and-exceptions)：例外和白名单的现行规范。
- `ci/rules/gitleaks.toml`、`ci/security-exceptions.json`、`scripts/ci/security-exceptions.mjs`：实现。
- `test/tooling/gitleaks-allowlist.test.mjs`、`test/tooling/gitleaks-config.test.mjs`：测试。

[↑ 返回阅读导航](#contents)
