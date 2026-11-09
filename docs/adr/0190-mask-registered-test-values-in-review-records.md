---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: "docs/adr/0177-gitleaks-exact-value-allowlist.md"
date: "2026-11-09"
---

# ADR 0190：复核脚本写记录时，把已登记的测试假值遮掉

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [Andy 的原话](#owner-decisions)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

复核脚本 `scripts/model-review/opencode-review.mjs` 把模型的提示词、答案、报错和账本写进 `.agents/reviews/pr-<编号>/`。模型读代码时会原样引用测试里的假令牌，例如测试网址里的 `token=…`。Gitleaks（开源的密钥扫描工具，CI 的 `check:gitleaks` 用它）把这种引用当成密钥报红。

[ADR 0177](0177-gitleaks-exact-value-allowlist.md) 的做法是给每个被引用的假值加一块“规则 + 单一路径 + 精确值”的白名单，并在后果里写明：“以后复核模型在新的记录里再引用测试令牌，security 检查会再报，要再按本 ADR 加一块。”2026-11-08 到 11-09 同一个假令牌因此红了两次，连续两个 PR（[PR 316](https://github.com/sixianli/himawari-agent/pull/316)、[PR 319](https://github.com/sixianli/himawari-agent/pull/319)）只为它加白名单。

脚本已有写入时的遮盖层：`RECORD_SECRET_RULES` 和 `maskSecretLike` 把像密钥的文字换成 `[已遮盖:<规则>]`。但这套规则只认固定的密钥形状，认不出 `token=` 加一个短假值。

[↑ 返回阅读导航](#contents)

<a id="owner-decisions"></a>

## Andy 的原话

- 2026-11-09，协调者转来 Andy 的“做”（cmsg_01EE1hey9cboYNfwFnBv5dgrCq9haXX2hjrrHhvEFwcXR1），要做一劳永逸的方案：改 ADR，让复核脚本写记录时把测试假令牌遮掉。
- 2026-11-09 02:44 UTC，Andy 看过方案后说“同意”（cmsg_01EE1hey9cboYNfwFnBv5dgr6vi1w6EDmeCgsiW3gK25mR）。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **遮的是“已登记的测试假值”，不写死某一个值。** 复核脚本从 `ci/rules/gitleaks.toml` 读出所有用 `^…$` 锚定的精确值白名单（ADR 0177 第 2 条规定的形状）。只取长度不少于 12、且只含字母、数字和 `_-=.:/ ` 与空格（`\.` 当作 `.`）的字面值；字符类、带别的正则符号的、太短的都跳过。以后谁再给 Gitleaks 加了精确值白名单，复核记录自动不再带出它。
2. **读哪个版本。** 复核时从 `--base` 提交里读，不从被复核的改动或工作区读，免得改动自己改掉清单；`--assert-reviewed` 从 `--main-ref`（默认 `origin/main`）读。读不到文件就以 `REGISTERED_VALUES_UNREADABLE` 停下，不静默不遮。
3. **遮盖写法。** 记录里出现这些值，一律换成 `[已遮盖:registered-test-value]`，在其他规则之前执行；同一段文字每次遮出的字节相同，与登记顺序无关。`secretLikeRules` 也报这一条，所以合并门（`record-secret-like`）会拒绝带着这些值的新提交记录。
4. **已经提交的老记录不改。** 它们靠现有白名单（[ADR 0177](0177-gitleaks-exact-value-allowlist.md)、[PR 316](https://github.com/sixianli/himawari-agent/pull/316)、[PR 319](https://github.com/sixianli/himawari-agent/pull/319) 加的那几块）放行；改写已推送的历史违反项目规则。
5. **ADR 0177 第 2 条以及它的白名单形状要求不变。** 只修正它“后果”里那一条：新记录由脚本遮盖，不再需要为引用假值而加新块。
6. **只管已登记的值。** 没登记过的新假值，第一次被引用时仍会红一次；登记（加白名单）之后，以后的记录就不会再带出它。

这个改动只影响写进仓库的复核记录。模型收到的提示词仍是原文，遮盖发生在落盘时，所以不改变任何发给模型的请求开头。

取舍依据：用户主权下的“边界与可逆性”优先于“主动性与效率”。遮盖只替换文字，不放宽任何扫描规则，也不新增白名单。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- **放宽白名单到整个 `.agents/reviews/` 目录。** 不采用：[ADR 0177](0177-gitleaks-exact-value-allowlist.md) 已否决，模型以后可能引用真实格式的密钥。
- **每次再加一块白名单（现状）。** 不采用：同一个值一周内红了两次，每次都要走完整的复核和合并。
- **只给这一个假令牌写死一条遮盖规则。** 不采用：下一个被引用的假值又要改脚本；从白名单动态读取，清单只有一处来源。
- **提示词里禁止模型引用测试值。** 不采用：模型本来就要读代码，靠提示词约束不可靠，也会限制模型的思路。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 新复核记录不再带出已登记的假值，`check:gitleaks` 不会因它们再红。
- 遮盖清单随 `ci/rules/gitleaks.toml` 走：白名单块被删掉，对应的值就不再被遮。
- 同一个值在答案里被遮成 `[已遮盖:registered-test-value]`，复核人读记录时看不到原值，需要时去 `gitleaks.toml` 对照。
- 判断文件 `verdicts.jsonl` 里的 `quote` 必须能在答案里逐字找到；答案和判断都经同一遮盖，所以仍然能对上。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0177](0177-gitleaks-exact-value-allowlist.md)：精确值白名单。
- [和 OpenCode 协作：方案讨论和代码复核](../../.agents/instructions/model-review.md#how-to-run)：写记录时的遮盖规则。
- `scripts/model-review/opencode-review.mjs`、`ci/rules/gitleaks.toml`：实现和清单来源。
- `test/tooling/opencode-review.test.mjs`：测试。

[↑ 返回阅读导航](#contents)
