# 复核报告：密码识别补漏（PR 315，63ddef5c）

## 发现（按严重度从高到低）

**【中】redaction.ts:83-86 — BARE 规则把技术语境里的 `pwd` 命令、带数字的路径/URL 误遮**
- 证据：`((?:${PASSWORD_KEYWORDS})\s+)(?!\[)(?=${PASSWORD_VALUE}*\d)(${PASSWORD_VALUE}{6,})`，关键词含 `pwd`，值字符类 `[^\s,，;；]`（第 71 行）包含 `/`、`.`、`:` 等。终端记录 `pwd` 换行后跟含数字的路径（`\s+` 匹配换行）→ `pwd\n/home/user1` 整个路径被遮成 `[密码]`；`密码 https://example.com/reset?token=123` 这类 URL 也整段遮。旧规则因要求分隔符而碰不到这些，本次扩大了撞车面。方向是保守的（多遮不是泄漏），且 ADR 0188「后果」已概括性承认误标，但没点名这两类。模型会丢失路径/链接信息，主人端显示经还原表不受影响（model-egress.ts:155-158）。
- 建议：英文关键词前加词边界（`(?<![A-Za-z])`）；考虑把纯路径/URL 形态的值加入 `NOT_A_PASSWORD_VALUE`。至少在 ADR「后果」里点名。

**【低】redaction.ts:78-81 — WORDED 规则没有最小值长度，与 BARE 的 6 字符下限不一致**
- 证据：WORDED 值为 `(${PASSWORD_VALUE}+)`（1 个字符即可），只要含数字就遮：`password is a1` → `password is [密码]`；`password is 1` 同样。ADR 0188 只写了 BARE 的「6 个字符以上」，带词写法未写长度要求——说法与代码一致，但这个更宽的下限没在 ADR 里说明。
- 建议：给 WORDED 也设一个下限，或在 ADR 写明理由。

**【低】docs/adr/0166:83 — 文档与代码不一致：仍说这些写法认不出，未加指向 ADR 0188 的说明**
- 证据：ADR 0166 的 W-07b 段落写「认不出的写法仍只靠提示词：”password is …“这类英文写法、关键词和值之间没有”是""为“或冒号的写法（例如”Wi-Fi 密码 abc12345"）」，本次只更新了 ADR 0185 的已知缺口（加了指向 0188 的括注），0166 没改。虽然该条已被 ADR 0183 取代存储侧行为，但「检测范围和出口遮盖相同」一句使这段描述现在过时了。
- 建议：像 0185 那样加一处括注。

**【低】测试缺口（推测部分见下）**
- 正例没覆盖 `are/was`、`改为/改為/設為/换成/換成`、韩文 `은`（redaction.unit.test.ts:38-44 只测了 `is`、`改成`、`는`）；`locateMaskedValues`（redaction.ts:478-519）没有 BARE/WORDED 命中的用例；`check:prompt-prefix` 的多轮对话夹具不含新写法（prompt-prefix.md:74 列的场景清单），所以「已发历史含新写法 → 前缀变一次」这件事没有端到端用例，只有 ADR 文字。

**【低，推测】** 值吞并机器密钥占位符的边界：机器密钥先替换成 `[密钥]`（redaction.ts:323），若其与密码值之间无空白（如 `密码 abc12345[密钥]`），BARE 的值字符类会把 `[密钥]` 整个吞进 `[密码#…]` 占位符。严格规则同样有此问题，非本次引入；`(?!\[)`（第 74/79/84 行）只挡值开头。未运行验证，属推演。

**【低，推测—漏判方向】** 全角数字（`１２３４５６`）不匹配 `\d`，`password １２３４５６` 认不出；日文 `が` 粒词（`パスワードが abc12345`）、破折号分隔（`password - abc12345`）仍漏。均为 ADR 承认的「启发式仍漏」范畴。

## 作者说法核对

- 「都要求值里至少有一个数字」：与代码一致，两处 lookahead `(?=${PASSWORD_VALUE}*\d)`（redaction.ts:79,84），且 lookahead 字符类与值捕获同类，等价于「值本身含数字」。
- 「6 个字符以上」：`{6,}` 为 ≥6（含 6），与中文「以上」通常含义一致；正例 `pwd hunter22abc`（11 字符）、反例 `密码 abc 很短` 两端都有。
- 「关键词表不变」：一致（redaction.ts:68-69 与旧正则关键词逐项相同）。
- 「处理顺序严格→带词→没有分隔符不会让同一段文字在不同位置被不同规则处理出不同字节」：**证实**。三次 replace 顺序固定（redaction.ts:330-342），新规则对已被遮的占位符有 `(?!\[)` 和 `startsWith("[")` 双重防护；带词先于裸值，韩文 `는` 情形（`비밀번호는`）BARE 因无空白也不会抢匹配。同一文本是自己的纯函数。
- 「识别同时用于出口遮盖和存储判断」：证实（identifiers.ts:16-28，`containsCredential` 直接复用 `redactForEgress` 的 findings）。

## 侧重检查（普通流程走查）

流程：主人在对话输入 `Wi-Fi 密码 abc12345` → 线程组装模型请求 → `Exchange.#prepare`（model-egress.ts:175-257）→ 每条消息过 `text()` → `redactForEgress`（trusted=提示词目录，model-egress.ts:224）→ BARE 命中 → `[密码#hash]` 入 `table`/`#known` → `assertMachineSecretFree` 通过 → 发送。模型回复中的占位符经 `restore`/`StreamingPlaceholderRestorer`（model-egress.ts:84-110,155-158）还原给主人。存储侧：提醒（production-reminder-writer.ts:205）、记忆捕捉/导入走 `classificationWithIdentifiers` → 标 sensitive、推送正文隐藏。

**没有测试覆盖的路径**：上述流程中，新写法只在 `packages/sensitive-capture/test/` 的单测里直接验证；生产端到端（`check:prompt-prefix` 多轮对话、`trusted-prompt-egress`、邮件 `locateMaskedValues` 路径）的夹具都不含新写法。我对这些路径做了推演（占位符形状相同、restore 表机理相同），未发现不兼容，但无运行证据——标「未核实」：所有测试和检查的实际运行结果（我无权运行命令）。

## 必答问题

1. **会不会改变模型已见过的请求开头？** 会，且仅此一次、有 ADR 依据。历史存原文、每次发送时对整个请求体重新遮盖（model-egress.ts:219-245 逐条遮 `messages`；prompt-prefix.md 规则第 5 条明文允许此例外）。含新写法的已发历史从此遮出 `[密码#…]`，该对话请求开头变一次，缓存整段重算一次——ADR 0188「后果」已如实记录。仍是只追加：遮盖按消息数组顺序处理、`#known` 只增不减，追加新消息不会改变旧消息遮出的字节（redaction.unit.test.ts:196-205 有此性质测试，虽然没用新模式）。本次改动不引入任何每轮变化的值。
2. **同一段文字会不会在不同请求里变成不同字节？** 不会（新规则部分）。三条规则都是局部正则、顺序固定、占位符由 HMAC（`sign`，model-egress.ts:120-125）或固定 `[密码]` 生成；`NOT_A_PASSWORD_VALUE` 无 `g` 标志无状态。已知例外是既有机理：`named-earlier` 依赖同请求更早的消息记下的值（prompt-prefix.md 第 11 条明文允许，只向后生效不回改）；trusted 固定文字清单在构建内固定。均非本次新增。
3. **有没有自动检查、反向用例会不会真的失败？** 有。正例（redaction.unit.test.ts:38-44）在旧代码下必然失败（旧规则认不出无分隔符写法）；反例（78-84 行）我逐条推演：若去掉数字要求，「the password is required」会命中 WORDED 而失败；若去掉 `NOT_A_PASSWORD_VALUE`，「密码 2026-11-08 更新」「password v2.0.1 发布」会命中 BARE 而失败——反例不是摆设。`check:egress-redaction`、`check:prompt-prefix` 挂在 `npm run check`（package.json:27,51-52）；identifiers 的正反例也补了（identifiers.unit.test.ts:89-90,95-96）。缺口见「测试缺口」一条。运行结果未核实。
4. **每个产生/使用的值两端都能接受吗？** 证实可以。新匹配产生的只有既有形状：kind `password`、ruleId `password-keyword`（redaction.ts:327）、占位符 `[密码#8位hash]`。逐个消费方核对：还原表 `table`（redaction.ts:304）和 `EGRESS_PLACEHOLDER_PATTERN` 还原（model-egress.ts:155-158）✓；流式还原器按 `[`/长度 48 分段（model-egress.ts:91-103），占位符 14 字符 ✓；`known`/`named-earlier`（redaction.ts:390-404）✓；`locateMaskedValues` 的 `LOCATED_PLACEHOLDER`（redaction.ts:425）✓；拦截日志按 kind+HMAC 指纹（model-egress.ts:202-218），UI 按 kind 显示 ✓；`machinePositions` 的出现次数/不重叠校验（redaction.ts:441-465）对新规则取整段值的机理与旧规则相同 ✓。`EGRESS_REDACTION_RULE_IDS` 未增项，无新校验面。
