---
status: active
supersedes: ""
superseded_by: ""
date: "2026-11-13"
covers: "apps/agent-service/src/production-owner-rules.ts, packages/application/src/services/thread-prompt-bundle-service.ts, packages/integration-web/src/untrusted-content.ts, packages/memory-engine/src/segmentation.ts, packages/sensitive-capture/src/external.ts, packages/sensitive-capture/src/identifiers.ts, packages/sensitive-capture/src/machine-secrets.ts, packages/sensitive-capture/src/redaction.ts, packages/sensitive-capture/src/secret-like.ts, scripts/check-meaning-word-lists.mjs, scripts/evals/memory-capture-live.eval.ts, scripts/model-review/opencode-review.mjs"
verified_at: "7c8521fe5f55e7dd57c5bd52badd16eef647502e"
---

# 词表登记表

<a id="contents"></a>

## 阅读导航

- [这份登记表管什么](#scope)
- [登记表](#register)
- [没有进来的地方](#outside)
- [怎么登记或删除](#how-to-change)

<a id="scope"></a>
## 这份登记表管什么

Andy 在 2026-11-12 定的原则（[ADR 0249](adr/0249-the-model-judges-meaning-where-word-lists-guessed-it.md)）：理解用户的意思（意图、时效、是否明说等）一律交给模型判断，不用关键词表、正则或写死的词典。这条原则已经被违反过三次（涉钱词、ADR 0249 的 T1 到 T6、规则管多久的词表），所以做成门槛：`npm run check:meaning-word-lists`（[`scripts/check-meaning-word-lists.mjs`](../scripts/check-meaning-word-lists.mjs)）在 `apps`、`packages`、`clients` 的非测试源码里找三种形状：名字带 MARKERS、KEYWORDS、PHRASES、STOPWORDS、LEXICON、WORDS 的列表或正则；含三个以上并列词的正则；连续四条以上中日英自然语言字符串的数组。每个命中必须在下面登记；没登记，检查失败。

这张表是检查脚本的唯一数据来源，改表不改脚本。类别只有这几种，没有“理解用户的意思”这一类：

| 类别 | 意思 |
| --- | --- |
| 格式解析 | 解析固定格式或我们自己生成的文字，不判断用户想说什么 |
| 安全底线 | 在模型看见内容之前必须由程序确定地遮盖或标记，只会多遮、多标，不会降低敏感级别 |
| 检索分词 | 搜索分词或排序用，不做任何决定 |
| 主人自定义规则 | 词是主人自己给的，匹配就是规则本身的含义 |
| 待删除 | 已经确定要改成模型判断，写明期限；期限过了词表还在，检查失败 |

[返回阅读导航](#contents)

<a id="register"></a>
## 登记表

| 文件 | 名字 | 类别 | 理由 | 期限 |
| --- | --- | --- | --- | --- |
| `apps/agent-service/src/production-owner-rules.ts` | `STANDING_MARKERS` | 待删除 | 判断规矩是长期还是一次性；ADR 0252 改成模型读整句，分支 `claude/project-thread-rusphi` | 2026-11-30 |
| `apps/agent-service/src/production-owner-rules.ts` | `ONE_OFF_MARKERS` | 待删除 | 同上 | 2026-11-30 |
| `apps/agent-service/src/production-owner-rules.ts` | `STANDING_STARTS` | 待删除 | 同上 | 2026-11-30 |
| `apps/agent-service/src/production-owner-rules.ts` | `QUIET_REQUEST_MARKERS` | 待删除 | PR 414 新增，同上，随 ADR 0252 一起删 | 2026-11-30 |
| `apps/agent-service/src/production-owner-rules.ts` | `RECURRING_TIME_MARKERS` | 待删除 | PR 414 新增，同上 | 2026-11-30 |
| `packages/sensitive-capture/src/external.ts` | `PLACEHOLDER` | 格式解析 | 认出我们自己生成的占位符 | |
| `packages/sensitive-capture/src/secret-like.ts` | `PLACEHOLDER` | 格式解析 | 同上 | |
| `packages/sensitive-capture/src/redaction.ts` | `EGRESS_PLACEHOLDER_PATTERN` | 格式解析 | 同上 | |
| `packages/sensitive-capture/src/redaction.ts` | `LOCATED_PLACEHOLDER` | 格式解析 | 同上 | |
| `packages/sensitive-capture/src/redaction.ts` | `VERIFICATION_CODE_KEYWORD` | 安全底线 | 发给模型之前遮盖验证码；必须每次得出同样字节（.claude/rules/prompt-prefix.md 第 11 条） | |
| `packages/sensitive-capture/src/redaction.ts` | `JP_MY_NUMBER_KEYWORD` | 安全底线 | 同上，日本个人番号 | |
| `packages/sensitive-capture/src/identifiers.ts` | `SENSITIVE_MENTION` | 安全底线 | 记忆分类时的“至少算敏感”底线，只升不降（[ADR 0300](adr/0300-how-memory-works-now.md) 第 40 行） | |
| `packages/sensitive-capture/src/machine-secrets.ts` | `POTENTIAL_SECRET_MARKERS` | 安全底线 | 机器密钥的确定性筛查 | |
| `packages/integration-web/src/untrusted-content.ts` | `INSTRUCTION_PATTERN` | 安全底线 | 网页内容里看到“忽略之前的指令”一类只打 `prompt_injection_observed` 标记，是防御纵深；是否照做仍由模型和授权出口决定 | |
| `packages/memory-engine/src/segmentation.ts` | `STOPWORDS` | 检索分词 | 检索分词时丢掉“的、了、什么”，只影响召回，和向量检索并用 | |
| `packages/application/src/services/thread-prompt-bundle-service.ts` | `SCHEMA_TEXT_KEYWORDS` | 格式解析 | JSON Schema 的关键字，不是自然语言 | |
| `packages/application/src/services/thread-prompt-bundle-service.ts` | `SCHEMA_VALUE_KEYWORDS` | 格式解析 | 同上 | |
| `packages/application/src/services/thread-prompt-bundle-service.ts` | `SCHEMA_MAP_KEYWORDS` | 格式解析 | 同上 | |

[返回阅读导航](#contents)

<a id="outside"></a>
## 没有进来的地方

- 脚本不扫 `scripts/`、`evals/`、测试和 `packages/prompt-catalog`（给模型的提示词）。开发工具里解析复核模型输出格式的几处（例如 `scripts/model-review/opencode-review.mjs` 的 `LOW_MODEL_SEVERITY`）和评测里的“关键词预筛”对照组（`scripts/evals/memory-capture-live.eval.ts` 的 `TRIGGERS`，用来证明预筛会漏）不判断主人的话。
- 脚本也不扫 `apps/control-center/src/i18n/`（界面文案）。并列词正则只在里面有中日文字符，或有少数几个常见英文词时才算命中，所以只写英文单词的并列正则（例如 `always|never|sometimes`）抓不到（Andy 2026-11-14 定暂不补）。
- 脚本是静态扫描，看不到运行时拼出来的词表，也看不到写在数据文件里的词。它拦的是最常见的写法，不是证明；评审时仍要问一句“这里是不是在猜用户的意思”。
- 唤醒名（例如苹果端主人叫 Himawari 才唤醒）只比主人配置的名字，不是词表；设备常开监听不能每句话送模型。

[返回阅读导航](#contents)

<a id="how-to-change"></a>
## 怎么登记或删除

- 新增命中：先问这是不是在判断用户话里的意思。是，就改成交给模型判断（照 [ADR 0249](adr/0249-the-model-judges-meaning-where-word-lists-guessed-it.md) 的做法：模型给结构化答案，程序严格解析、失败走安全默认、校验原话出处）。不是，就在上表加一行，写类别和理由。
- 要新增类别，必须 Andy 同意，同时改本文件的类别表和脚本里的 `ALLOWED_KINDS`。
- 登记的词表被删掉或改名后，同一个提交里删掉对应的行；“待删除”行可以提前登记，用来让还没合并的分支不被拦。

[返回阅读导航](#contents)
