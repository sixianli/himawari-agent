---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-08"
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

[ADR 0185](0185-mark-passwords-and-keys-sensitive-instead-of-dropping-them.md) 的“已知缺口”写明：“password is abc12345”和“Wi-Fi 密码 abc12345”认不出。原因在 `packages/sensitive-capture/src/redaction.ts` 的密码规则：关键词后面必须紧跟冒号、等号或“是/为/は”才认作密码，没有英文 “is”，也没有“关键词 + 空格 + 值”的写法。这条规则同时管发给模型和搜索的遮盖，以及存储时的敏感判断（`classificationWithIdentifiers`），所以认不出的值会原样发给模型、含它的提醒推送也会显示正文。Andy 2026-11-08 问起这个缺口，协调者要求修。

<a id="decision"></a>

## 决定

在原来的规则（关键词 + 冒号、等号、“是/为/は” + 值，不变）之外，加两条更窄的规则。它们都要求值里至少有一个数字，用来挡 “password is required”“密码改成每月一次”这类普通句子：

1. **带词的写法。** 关键词后接英文 `is/are/was`，或中文“改成/改为/设为/换成”，或韩文 `는/은`，再接含数字的值。
2. **没有分隔符的写法。** 关键词、空白，再接 6 个字符以上且含数字的值，如 “Wi-Fi 密码 abc12345”“password 123456”。日期（`2026-11-08`）和版本号（`v2.0.1`）不算。

关键词表不变，仍在三种语言之外含日文、韩文，所以日文 “パスワード abc12345”、韩文 “비밀번호는 abc12345” 一并识别。

<a id="options"></a>

## 放弃的做法

- **关键词后面的任何词都当成值**：“password is required”“密码管理器”会被误判，普通提醒被标敏感、推送正文被藏。
- **值不要求有数字**：同上。代价是 “password is hunter” 这种全字母的值认不出，留作已知缺口。

<a id="consequences"></a>

## 后果

- 正面：常见的口头写法被遮盖，含它们的提醒、记忆、导入行被标敏感。
- 负面：规则仍是启发式，全字母的口令、关键词与值之间隔着别的词（“密码我设成了 abc12345”）的写法仍认不出；少数普通句子（如 “密码 abc123 已过期”）会被误标，方向是保守的。
- 发给模型的内容：这是遮盖规则的变化。已经发出过的历史里，如果有刚好符合新写法的文字，这些文字从此会被遮盖，所以这样的对话请求开头会变一次（缓存整段重算一次）；没有这类文字的对话不受影响。遮盖本身仍只取决于这段文字自己，同一段文字每次遮出的字节相同。

<a id="references"></a>

## 关联文档

- [ADR 0185：密码、密钥、证件号、银行卡号标成敏感，不再标受限丢弃](0185-mark-passwords-and-keys-sensitive-instead-of-dropping-them.md)
- [ADR 0183：只在数据发往外部时遮盖，内部存储和展示用原文](0183-mask-only-when-data-leaves-and-keep-the-original-inside.md)
