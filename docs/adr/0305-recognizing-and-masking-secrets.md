---
status: active
document_type: adr
decision_status: accepted
supersedes: "https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0167-sensitive-capture-package.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0183-mask-only-when-data-leaves-and-keep-the-original-inside.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0188-recognize-passwords-without-a-separator.md"
superseded_by: ""
date: "2026-11-26"
covers: "packages/sensitive-capture/src/redaction.ts, packages/sensitive-capture/src/machine-secrets.ts, packages/sensitive-capture/src/identifiers.ts, packages/sensitive-capture/src/restoration.ts, packages/sensitive-capture/src/web-content.ts"
verified_at: "7d0ffcd52cbb69d4941871cf9bf08d93f3843da8"
---

# ADR 0305：认出密码和密钥，只在数据出门时遮盖

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [和 ADR 0286 的关系](#adr-0286)
- [放弃的做法](#rejected)
- [后果](#consequences)

<a id="context"></a>

## 背景

怎样认出密码、验证码、卡号、证件号、密钥，以及什么时候遮盖，原来分散在三份 ADR 里（0167、0183、0188）。这份 ADR 只写现在为真的做法。旧文全文在 `supersedes` 列的固定提交链接里。

遮盖指把认出的值换成“[密码]”这类占位文字。

<a id="decision"></a>

## 决定

- 识别和遮盖的规则全部放在独立的包 `packages/sensitive-capture`：不依赖 Himawari 的其他包，不读写文件、数据库和网络，浏览器里也能用。散在别处的同类规则（受限证件号、诊断日志和追踪记录的字段名打码、网页抓取内容里的密钥）一律搬进这个包。
- 只在数据发往外部时遮盖（发给模型、搜索服务等）。内部存储和给主人看的界面用原文，不整段拦下或丢弃。
- 模型回复里抄回来的占位符，写库前按本次的对照表还原成原值；还原不了的原样保留，不猜。
- 密码的认法：关键词（含中、英、日、韩）后接冒号、等号、“是/为/は”，或英文 is、中文“改成/设为”、韩文“는/은”，再接一个不含空白的值；关键词后直接空一格接 6 个字符以上的值也算。值是日期、版本号、网址、路径或命令重定向时不算，免得误遮普通句子。
- 建记忆检索词表之前的遮盖见 [ADR 0300](0300-how-memory-works-now.md#model-view)。

[返回目录](#contents)

<a id="adr-0286"></a>

## 和 ADR 0286 的关系

[ADR 0286](0286-the-main-model-reads-and-writes-memory-itself.md) 决定以后不再给记忆标“敏感”、取消敏感审批，只有密码、密钥由程序拒存，发出前的出口遮盖保留。那一步编码完成后，这份 ADR 的识别规则改为用来拒存密码和密钥，出口遮盖不变。

[返回目录](#contents)

<a id="rejected"></a>

## 放弃的做法

- 存储时就把含机密的整段拦下：主人自己的数据在自己机器上，拦下只会让记忆和记录残缺。
- 宽泛地把“关键词后面的任何词”都当密码：会把普通句子遮得看不懂。

[返回目录](#contents)

<a id="consequences"></a>

## 后果

- 主人在自己的界面里看到的都是原文；发出去的请求里认得出的机密都被遮住。
- 认不出的写法仍会原样发出，识别规则要随实际漏报逐条补。

[返回目录](#contents)
