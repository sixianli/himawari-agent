复核完成，信息已足够，写出结论。

# PR3 第 2 轮复核（e5edb546 → 38133377）

## 按严重度排列的问题

1. **中** · packages/platform-node/src/typesafe-jev-transport.ts:113-120 + packages/sensitive-capture/src/external.ts:76-84
   问题：TypeSafe 的每个 string 叶子单独调用 `redactForExternalText(value, { known })`（只传 `known`），`external.ts:82` 的兜底是 `options.tag ?? sequentialTag()` —— **每个叶子新建一张编号表，序号各自从 0 重排**。同一次发出的 state 里，字段 A 中第 1 个敏感值和字段 B 中第 1 个敏感值（不同值）都变成 `[密码#aaaaaaaa]`；同一值跨字段靠共享 `known` 才保住同号（external.ts:141-142、redaction.ts:359-373）。同一次请求内不同值占位符重号，后续若有人按占位符反查/恢复就会混。
   证据：typesafe-jev-transport.ts:114 `redactForExternalText(value, { known }).text`（未传 tag）；external.ts:82 `tag: options.tag ?? sequentialTag()`；sequentialTag 每实例从 0 起（external.ts:60-73）。
   建议：在 `redactedState` 入口建一次 `sequentialTag` 并入 options 传下去，与 `known` 同样共享；同输入两次调用字节不变（确定性不破坏）。
   性质：读代码证实；非泄露（遮盖单向、TypeSafe 无恢复表），与作者判“机器密钥重号可接受”同一取向，属可接受的设计延伸，建议顺手修。

2. **低** · packages/platform-node/src/deepseek-web-provider.ts:70 vs packages/platform-node/src/exa-public-search.ts:215
   问题：DeepSeek 预检查用 `input.query.length`（UTF-16 码元），Exa 用 `Buffer.byteLength`；且 DeepSeek 遮后只查 `!query` 等（provider:70-72），**没有** Exa 那样的遮后 `Buffer.byteLength(query) > 4096` 上限。
   证据：deepseek-web-provider.ts:70 `if (input.query.length > 4 * 4096)`；exa-public-search.ts:215 与 219 `Buffer.byteLength(input.query) > 4 * 4096`、`Buffer.byteLength(query) > 4096`。
   影响：实际威胁被入口兜住（production-coding-workflow.ts:184/192 两道 49152 字节检查，遮后若膨胀也会被 192 拒），只是纵深防御不对称。
   建议：Same 改 byte 计数，DeepSeek 补遮后上限。

3. **低** · apps/agent-service/src/service-main.ts:885-892
   问题：`externalTag` 失败后 `externalEgress = undefined` 丢缓存——**没有任何测试覆盖**（全仓库只有 workflow 测试自注入 throwing externalTag，ings service-main 这一缓存重置路径未走到）。
   证据：grep `key unavailable` / `externalEgress = undefined` 仅命中 workflow 测试一处和 service-main.ts:890 一处。
   建议：在 service-orchestration 测试里加一条：首次抛错后第二次调用能重建 egress。

4. **低** · scripts/check-egress-redaction.mjs:95-98
   问题：deepseek 行改登记 `maskedPublicFetchUrl`，但反向用例（“登记文件里缺遮盖调用要报错”）只覆盖了 exa（缺 redactForExternalUrl）和 typesafe；`maskedPublicFetchUrl` 的反向 fixture 缺失。同一代码路径（check-egress-redaction.mjs:244-249），风险小但反例不完整。
   建议：反向用例里加上 deepseek 的 fixture。

5. **低（设计确认）** · packages/sensitive-capture/src/external.ts:139-142 + redaction.ts:359-373
   作者请查的“误遮”点证实存在且行为如描述：≥6 字符、`(?<![\p{L}\p{N}_])…(?![\p{L}\p{N}_])` 字边界，同一次调用其它文字里边界处出现的同串会被遮（如 `, hunter2abc`、`/hunter2abc`），粘在更长词内（`tylerbanana67`）不遮。这是点名表的本意，不算新缺陷，但边界处（连字符、斜杠）的误遮是真实可能——URL 路径里的 slug 同值会被改写成占位符，可能让 fetch 404；与"先遮盖"政策一致，可接受。
   缺的是"`known` 长度下限 6 ≠ `redactForExternalUrl` 值长度无下限"之类的对称检查——作者第 1 轮已判不必要，我同意：不对称只影响下限值的登记方向，不影响泄露。

## 作者说法与代码的对照

- 第 1 条（known 表）：**照做**。`ExternalRedactionOptions.known`（external.ts:10-15）贯穿 text/URL/TypeSafe，测试覆盖（external.unit.test.ts:122-171、typesafe-jev-transport.unit.test.ts:217-229）。
- 第 2 条（入口先按原文大小拒 + 4 倍预拒 + 正则 160 上限）：**照做**（workflow:184、exa:215、deepseek:70、`{0,60?}` 160 上限 external.ts:103 + 60 秒内的有界回溯测试 external.unit.test.ts:163-171）。
- 第 3 条（片段 key=value 按参数名遮）：**照做**（external.ts:148-172，`hash` 前后两段都走 `maskParameterPairs`，含三个片段用例 plus 无参数片段原样保留）。
- 第 4 条（入口捕获 → WEB_*_UNAVAILABLE 且未授权未发出；service-main 丢缓存 Promise）：**照做**（workflow:187-191 在 `authorize`(workflow:408) 之前返回 `not_sent`；测试 945-989 断言 authorize/issue 未被调用）。`external` 关键字只在 service-main `external()` 缺陷路径丢缓存。
- 判"不成立"的各项：未重新裁决；"production-automatic-review.ts 的 state 只有固定字段"**未核实**（未读该文件）。
- DeepSeek fetch 改为 `maskedPublicFetchUrl` 后，往返夜灯 test（deepseek/exa-mcp 测试更新为带 `#aaaaaaaa` 编号）与新字节一致。

## 侧重检查（普通流程走查）

普通流程：模型发 web_search 调用 → `executeProductionCodingRequest`（production-coding-workflow.ts:124）→ binding/权限/JSON 大小预检（:184）→ `outboundWebArguments`（:108-122：`services.externalTag?.()` → service-main:885 → ModelEgress:524 `externalTag()` → sign 编号 → 遮盖 query 或 url，两参字段互斥且入口 206-214 只收 query/limit 或 url/offset，query+url 同存必拒）→ 遮后 49152 复检(:192) → 参数校验 → gate 授权（:408）→ provider（Exa:215 预拒 / 遮 4096 上限；DeepSeek 带 `maskedPublicFetchUrl`）→ 外部发送。
测试覆盖：workflow 单测（happy path、遮盖保存、不可用、超大）、model-egress 一致性单测、exa-mcp/typesafe/deepseek 包测、集成测试 web-content-limits。
未覆盖代码路径：① service-main:890 的缓存重置（见问题 3）；② `sequentialTag` 兜底路径在生产中不可达（入口总有 tag），仅测试和纵深防御经过——与作者说法一致；③ 脚本层 deepseek 反向 fixture（见问题 4）。
文档/规则一致性：docs/adr/0079 的 `WEB_SEARCH_UNAVAILABLE`/`WEB_FETCH_UNAVAILABLE` 码义（5xx/网络错误→稍后再试）与新增的"遮盖编号函数不可用→同码"相容（都是"稍后再试"不带值）；web-provider-failure.ts:35/47/66 同码既有使用一致。

## 必答问题逐条回答

1. **会不会改变模型已见过的请求开头？** 不会，证明：整个增量不改 prompt-catalog、runtime、Exchange 对模型请求的遮盖（model-egress.ts:120-125 的 `placeholderTag` 仅把内联 lambda 提出来，签名输入 `${kind}\u0000${value}` 与原实现逐字节相同）；改动只影响发往 Exa/DeepSeek/TypeSafe 的内容和工具执行结果，模型可见的只有**追加**的失败结果字符串“工具未执行：WEB_SEARCH_UNAVAILABLE / CODING_INPUT_TOO_LARGE / WEB_FETCH_*”等。每轮会变的值（失败码、外发请求）都在工具调用执行的尾部，不在请求前缀。
2. **同一段文字会不会在不同请求里变成不同字节？** 不会，证明：入口编号 = `letters(sign(key, kind+接缝+value))`（model-egress.ts:114-125），与 key 和值一一对应；兜底 `sequentialTag` 的序号只由**同一次调用内** `Map`（kind\0value 插入序）决定（external.ts:60-73），同一输入两次得相同字节；@遮过的占位符在下游二次遮盖中按 `isPlaceholder`/`WHOLE_PLACEHOLDER` 原样保留（external.ts:101-119、188-194），不会二次变形；`known` 表只在单次调用/单个 TypeSafe 请求内共享，不跨请求。无时间戳字段依侵入遮盖。
3. **有没有自动检查？反向用例会失败吗？** 有，实际核验过的：external.typesafe/workflow/model-egress 包测，反向（遮盖依赖缺失→断言失败语义、抛错授权不动、脚本"登记文件缺 redactForExternalUrl 要报错"）都写到了。缺口：service-main 缓存重置、脚本 deepseek 行专用反例（问题 3、4）。
4. **每个新值双端核对**：`WEB_SEARCH_UNAVAILABLE`/`WEB_FETCH_UNAVAILABLE`/`CODING_INPUT_TOO_LARGE`（workflow:185/190/192）→ 与 web-provider-failure.ts:35-66、ADR 0079:125、集成测试一致；`externalTag` sync→async → 接口（production-file-read-workflow.ts:68）、装配（production-file-read-services.ts:54/145）、唯一调用点外传递深度测试（workflow 测试:872-1009）签名一致；`maskedPublicFetchUrl` → 平台包内自用（未跨包，不需要 index 导出）、脚本登记与实现文件一致；`ExternalRedactionOptions` → index 导出（redaction 之外也用了）；占位符格式 `[…#[a-z]{8}]` 与 ModelEgress `letters`（8 个 a-z，model-egress.ts:114-118）及外部 `PLACEHOLDER` 正则匹配一致（external.ts:101）。未发现两端校验不匹配之处。
