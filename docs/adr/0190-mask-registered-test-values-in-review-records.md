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

> **2026-11-25 起暂停。** Andy 叫停了全部 OpenCode 复核：方案讨论、方案说法核对和合并前代码复核都不跑，合并只看测试和 CI（见 [AGENTS.md](../../AGENTS.md#working-with-opencode)）。Andy 说恢复之前，本文的决定不适用。

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

1. **遮的是“已登记的测试假值”，不写死某一个值。** 复核脚本从 `ci/rules/gitleaks.toml` 读出所有用 `^…$` 锚定的精确值白名单（ADR 0177 第 2 条规定的形状）。只取长度不少于 12、且只含字母、数字和 `_-=.:/ ` 与空格（`\.` 当作 `.`）的字面值；字符类、带别的正则符号的、太短的都跳过。以后谁再给 Gitleaks 加了这个形状的精确值白名单（单行三单引号，`regexes` 只有一个元素），复核记录自动不再带出它；别的形状（字符类、含引号或汉字的整行、`regexTarget = "match"` 的固定开头、多行数组）不会被遮，仍靠 ADR 0177 的白名单块，也不报错，写 ADR 0177 的新块时按第 2 条的形状写。
2. **读哪个版本。** 只在写记录的复核运行里读：`--base` 提交和 `origin/main` 两处清单的并集（这样 main 上在分支点之后新登记的值，写记录时也遮得到）。读的是本地的 `origin/main`，脚本不替人 fetch：复核前本地 `origin/main` 落后时，落后部分新登记的值遮不到，Gitleaks 照旧会报，按 ADR 0177 加块，所以复核前先 `git fetch origin main`。不从被复核的改动或工作区读，免得改动自己改掉清单；只有没有 `--base` 的方案讨论模式（`plan`、`plan-review`）退回从被复核的提交读。某个提交不存在就跳过它；提交存在但没有这个文件，以 `REGISTERED_VALUES_UNREADABLE` 停下，不静默不遮。`--assert-reviewed` 和 `--report` 不读这份清单。
3. **遮盖写法。** 记录里出现这些值，一律换成 `[已遮盖:registered-test-value]`；先按 `RECORD_SECRET_RULES` 遮真密钥的形状，再遮登记值，一次正则替换（长的值优先），所以登记值嵌在真密钥里也遮不坏真密钥，同一段文字每次遮出的字节相同，与登记顺序无关。
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
- 脚本只遮它自己写的提示词、答案、报错和账本。线程手写的 `judgments.md`、`verdicts.jsonl` 不会被自动遮盖：`quote` 要从遮盖后的答案复制才能逐字对上，也不要在判断里写出已登记的值，否则 Gitleaks 会按它们所在的路径报出来。
- 合并门（`--assert-reviewed`）不检查登记值，只认内置的密钥形状。登记值的把关留给 Gitleaks：记录里带出登记值又不在白名单路径里，`check:gitleaks` 会报红，要按 ADR 0177 为那个文件加一块白名单；改成遮盖写法再提交不能去掉已提交的历史，所以不拿它当补救办法。这样合并门不会因为清单随时间变化而把早先写好的记录判红。
- 在同一个 PR 里新登记的值，要等该 PR 合并进 main 后才被遮。
- 补跑某一轮时，磁盘上的提示词存档按三种写法之一接受：按当前清单遮的、没遮登记值的（写于登记之前）、或和账本里记的 `promptFileSha256` 一致的（写入时的清单与现在不同）；提示词本身是否变了仍按账本的 `promptSha256` 核对。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0177](0177-gitleaks-exact-value-allowlist.md)：精确值白名单。
- [和 OpenCode 协作：方案讨论和代码复核](../../.agents/instructions/model-review.md#how-to-run)：写记录时的遮盖规则。
- `scripts/model-review/opencode-review.mjs`、`ci/rules/gitleaks.toml`：实现和清单来源。
- `test/tooling/opencode-review.test.mjs`：测试。

[↑ 返回阅读导航](#contents)
