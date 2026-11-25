---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-08"
covers: "packages/application/test/model-egress.unit.test.ts, packages/runtime-pi/test/prompt-prefix.compat.test.ts, packages/sensitive-capture/src/redaction.ts, test/integration/thread-prompt-bundles.test.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0188：密码识别补上英文 “is”、没有分隔符的写法和其他语言

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

[ADR 0185](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0185-mark-passwords-and-keys-sensitive-instead-of-dropping-them.md) 的“已知缺口”写明：“password is abc12345”和“Wi-Fi 密码 abc12345”认不出。原因在 `packages/sensitive-capture/src/redaction.ts` 的密码规则：关键词后面必须紧跟冒号、等号或“是/为/は”才认作密码，没有英文 “is”，也没有“关键词 + 空格 + 值”的写法。这条规则同时管发给模型和搜索的遮盖，以及存储时的敏感判断（`classificationWithIdentifiers`），所以认不出的值会原样发给模型、含它的提醒推送也会显示正文。Andy 2026-11-08 问起这个缺口，协调者要求修。

<a id="decision"></a>

## 决定

在原来的规则（关键词 + 冒号、等号、“是/为/は” + 值，不变）之外，加两条更窄的规则。为了不误遮普通句子，它们的值有同样的限制：必须是一段不含空白、逗号、分号、方括号的 ASCII 字符（所以中文短语不算值），里面至少有一个数字，值前面的引号、左括号，值后面的句号、冒号、右括号、引号都不算在值里；英文关键词（`password`、`passwd`、`pwd`、`PIN码`）前面不能紧挨 ASCII 字母、数字或下划线（“1Password”“notpassword”不算），中文、日文、韩文关键词前面可以紧挨任何字符（“wifi密码 abc12345”照样认）；关键词和值之间只隔空格或制表符，不跨行（终端里的 `pwd` 命令后面换行的路径不算）。

1. **带词的写法。** 关键词后接英文 `is/are/was`，或中文“改成/改为/设为/换成”，或韩文 `는/은`，再接 4 个字符以上的值（去掉前后标点后再数）。
2. **没有分隔符的写法。** 关键词、空白，再接 6 个字符以上的值（去掉前后标点后再数），如 “Wi-Fi 密码 abc12345”“password 123456”。

值是日期（`2026-11-08`、`2026/11/08`、`11/08/2026`、带时间的 ISO 写法）、版本号（`v2.0.1`）、网址（`http(s)://…`）以 `/` 开头的路径，或以 `>`、`<`、`2>` 开头的重定向（`pwd 2>/dev/null`）时不算密码；值外面包着引号或括号时，先去掉它们再判断。

关键词表不变，仍含日文、韩文，所以日文 “パスワード abc12345”、韩文 “비밀번호는 abc12345” 一并识别。

<a id="options"></a>

## 放弃的做法

- **关键词后面的任何词都当成值**：“password is required”“密码管理器”会被误判，普通提醒被标敏感、推送正文被藏。
- **值不要求有数字、不限字符**：同上，“密码 我已经用了3年”“密码设为8位以上”会被误遮。代价是 “password is hunter” 这种全字母的值认不出；值里夹着非 ASCII 字符时，只遮到第一个非 ASCII 字符之前（“密码设为 abc12345中文” 遮成 “密码设为 [密码]中文”），后面的部分会原样外发。这两种都留作已知缺口。

<a id="consequences"></a>

## 后果

- 正面：常见的口头写法被遮盖，含它们的提醒、记忆、导入行被标敏感。
- 负面：规则仍是启发式，全字母的口令、关键词与值之间隔着别的词（“密码我设成了 abc12345”）的写法仍认不出；少数普通句子（如 “密码 abc123 已过期”、`password is a1b2c3 hex`）会被误标，方向是保守的。
- 发给模型的内容：这是遮盖规则的变化，但已有对话发出过的字节不变。做法是给遮盖规则编版本（`EGRESS_RULESET_CURRENT`，现在是 2；这两条宽松规则从 2 起生效，1 是此前的规则），版本记在按对话冻结的提示记录里（[ADR 0165](0165-freeze-the-request-head-per-conversation.md)，存在记录的 `identity_json`，不加列）：
  - 新对话的第一条记录写当前版本；
  - 上线时已有历史、第一次建记录的对话（来源 `rollout`）写版本 1；
  - 上线前已存在的记录没有这个字段，读出来按版本 1；是否换新的判断不看这个字段，所以不会因此换新；
  - 记录因工具集合、模型、推理强度、回答语言或手动换新而换新时，请求开头本来就整段重算（手动换新由操作的人决定），新记录写当前版本；因数据分级降低而换新时，提示和工具不变，所以沿用上一份记录的版本，不为这件事额外失效一次缓存；
  - 读出的版本不是 1 以上的整数时按 1；比当前版本高的（回滚到旧代码时可能遇到）按当前版本。
  - 当前版本只覆盖两条宽松密码规则，其余规则不分版本；以后要让别的规则也只对新对话生效，要在规则里加判断，不能只把版本数加一。
  发给模型的遮盖用这条记录的版本；没有记录的路径（没有对话的辅助调用、联网搜索、嵌入）用当前版本，它们不是某个对话的请求开头。存储时的敏感判断（`classificationWithIdentifiers`）和推送正文隐藏始终用当前规则，不影响发给模型的字节。
- 代价：版本 1 的老对话继续把“Wi-Fi 密码 abc12345”这类宽松写法原样发给模型，直到它因上面的原因换新。这是为了遵守“发给模型的内容只能往后追加”，Andy 若认为缺口比缓存更重要，可以对指定对话手动换新（`thread prompt rebuild`）。
- 遮盖仍只取决于这段文字自己和它前面已经点名的值（不依赖后文），所以追加新消息不会改变旧消息遮出的字节。
- 检查：`packages/runtime-pi/test/prompt-prefix.compat.test.ts` 的 `[ADR-0188]` 三条用例（旧版本的对话全程不变、新对话从第一轮遮盖、中途换版本必须被报告为断开）；`packages/application/test/model-egress.unit.test.ts` 和 `test/integration/thread-prompt-bundles.test.ts` 里同名标记的用例。

<a id="references"></a>

## 关联文档

- [ADR 0185：密码、密钥、证件号、银行卡号标成敏感，不再标受限丢弃](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0185-mark-passwords-and-keys-sensitive-instead-of-dropping-them.md)
- [ADR 0183：只在数据发往外部时遮盖，内部存储和展示用原文](0183-mask-only-when-data-leaves-and-keep-the-original-inside.md)
