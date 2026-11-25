---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-01"
---

# ADR 0148：所有模型和嵌入请求只走一个进程内出口，在这里统一遮盖，回复里的占位符显示时还原

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [放弃的做法](#options)
- [业界做法和依据](#industry)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

[ADR 0146](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0146-redact-sensitive-text-before-it-leaves-for-any-model.md) 在三个发送点（主对话、辅助调用、嵌入）各自调用脱敏函数，并用一道自动检查登记这三个点。2026-11-01，Andy 提出：所有模型请求出系统之前应统一过一个自己的出口，脱敏只在那里做，而不是每接入一个厂商就把请求和脱敏逻辑重写一遍；回复显示给用户时要把占位符还原成原文；并要求参考主流开源模型网关和 Magpie 的源码。方案全文和前提来源见项目文件 `redaction/gateway-plan.md`，Andy 当天回复“同意”。

0146 的三个缺口：

1. 调用点分散，新增一种出口要靠检查发现。
2. 占位符只带类型（`[验证码]`），模型分不清两处是否同一个值，回复里的占位符也无法还原。
3. 只遮盖列出的位置，列表之外的字段会漏。

<a id="decision"></a>

## 决定

1. **一个进程内出口**。`packages/application/src/services/model-egress.ts` 的 `ModelEgress` 提供 `exchange()`；每次模型调用建一个 `ModelEgressExchange`，用 `wrapFetch(baseFetch)` 包住发出请求的 `fetch`。主对话（`pi-runtime-adapter.ts`）、辅助调用（`pi-model-transport.ts`）、嵌入（`embedding.ts`）都只用这个包过的 `fetch`。不接 LiteLLM、Portkey、Bifrost 这类外部网关。
2. **默认遮盖，按位置排除**。出口识别请求路径（`/chat/completions`、`/responses`、`/messages`、`/embeddings`），解析 JSON 后遍历所有字符串逐段遮盖。不碰的位置按结构决定：带 `type` 为推理块、图片、音频、文件的整个对象；消息上的 `reasoning_content` 等推理字段；顶层 `tools`、`functions`、`tool_choice`、`response_format`；结构对象上的 `id`、`type`、`role`、`name`、`model`、`*_id` 这类字符串。工具参数（`arguments`、Anthropic 的 `tool_use.input`）里面一律检查，字段叫什么都一样。`data:` 开头的字符串不碰。
3. **拒绝发送而不是放行**：路径不认识、请求体不是文字或不是 JSON、请求没有对话部分、嵌入输入是 token 编号数组、遮盖后仍检出机器密钥，都抛出 `ModelEgressRefusedError`；辅助调用把它映射为 `AI_GATEWAY_INPUT_REJECTED`。无请求体的 GET 原样通过。
4. **稳定占位符**。形如 `[验证码#kqzmdwrp]`、`[银行卡 尾号1111#kqzmdwrp]`，编号是 8 个小写字母，由 HMAC-SHA256（类型、值）取得，密钥由 `payload-encryption` 密钥再派生（标签 `himawari.model-egress.placeholder.v1`），不新增需要运维配置的密钥。编号不含数字，避免被验证码规则当成数字串。机器密钥仍是固定的 `[密钥]`，没有编号，不可还原。
5. **前面出现过的值处处遮**。一次请求内，密码和验证码（长度至少 6）遮盖过一次，之后在更靠后的任何文字里再出现同一个值也遮。只依赖更靠前的内容，不依赖更靠后的内容，所以前缀不变。
6. **还原只在主对话的显示端**。出口为每次调用记下“占位符对原文”的内存对照表；`restoreModelStream` 把模型回复事件里的占位符换回原文，占位符被切在两段流式文字之间时先扣住前半段（`StreamingPlaceholderRestorer`）。机器密钥不在对照表里。后台辅助调用的输出不还原。工具调用参数里的占位符不还原（牵涉工具执行和权限，另行评审）。（[ADR 0183](0183-mask-only-when-data-leaves-and-keep-the-original-inside.md) 增加了两处后台还原：自动整理记忆和对话标题写库前，按各自发出的提示重建对照表还原。）
7. **占位符说明改为固定文字**：照原样当作普通内容使用，不要求核实，不换成示例；主对话版本补一句“回答里写出占位符时，系统在显示给用户时会换回原值”。参考 Magpie 因说明措辞让较弱模型拒用占位符的教训。主对话和辅助调用各一份，每次相同。
8. **密码类名称补全**：口令、PIN码、安全码、授权码、暗証番号、비밀번호、암호、비번。
9. **门槛**：`npm run check:egress-redaction` 要求三个发送点用 `exchange.wrapFetch(`，主对话用 `restoreModelStream(`，并拒绝出口模块之外直接调用 `redactForEgress(` 和任何未登记的模型或嵌入请求出口；测试覆盖正例、反例、受保护名字放在工具参数里仍被遮、标识符不被误遮、推理块和签名字节不变、前缀字节稳定、占位符被切开、嵌入 token 编号数组被拒、未知路径被拒，以及用真实 Pi 运行时对回环服务的端到端测试。

<a id="options"></a>

## 放弃的做法

- **自建 LiteLLM + Presidio**：多三个常驻服务；LiteLLM 2026-03 发生过供应链投毒；两者遇到不认识的格式都放行。
- **用 Magpie 的内置遮盖或 `onRequest` 钩子**：管不到嵌入；默认关，靠设置页面开关；三个实例版本各异。
- **按字段名排除**（Magpie 的 `kept` 表）：模型起的工具参数名可以冒充受保护的名字，Magpie 自己的 LESSONS.md 第 177 行记录了由此漏掉密码的事故。
- **只遮盖列出的位置**（LiteLLM 的做法）：没列到的新字段会漏。
- **把已遮盖的文字存进历史**：丢失原件。
- **启动时接管全局 fetch**：网页搜索、邮件等工具也用它，改动面大。
- **在工具参数里也还原占位符**：本次不做，需要单独评审工具执行和权限。

<a id="industry"></a>

## 业界做法和依据

- LiteLLM（提交 `60fc121`）：每种接口一个翻译处理器，只取消息内容和工具调用，没取到的位置不管；嵌入输入不是字符串就跳过；对照表放在本次请求里。
- Portkey 开源网关（`669825c`）：只检查最后一条消息，嵌入判定为通过。
- Bifrost（`496693a`）：开源仓库没有脱敏插件。
- Magpie（`9d08993`）：占位符是值的带密钥哈希；对照表只在内存；流式还原要缓冲；遍历所有字符串，按键名加位置排除；`LESSONS.md` 记录了由键名排除造成的漏遮和结构字段被遮造成的 400。
- Presidio、Google DLP：默认替换成类型名，只有加密类变换可逆。

<a id="consequences"></a>

## 后果

- 上线后第一次，主对话的系统提示说明文字变了，缓存重新计算一次。
- 上线之前存下的老对话，其推理块在没有遮盖时生成，可能含有原值；推理块带签名，不能改，所以会原样再发。已知缺口。
- 新增一种全新的请求格式，要补一个路径入口；新增一个用已有格式的厂商不用写脱敏代码。
- 服务商以后改变格式，宁可让那一轮失败（拒绝发送）也不漏发。
- 回复里的占位符被模型改写或翻译就还原不了，原样保留占位符。
- 在 0146 之前已用原文生成并发出的嵌入向量改不回来。

<a id="references"></a>

## 关联文档

[ADR 0146](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0146-redact-sensitive-text-before-it-leaves-for-any-model.md)、[ADR 0134](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0134-adopt-product-vision-v2-2.md)、[产品愿景](../product-vision.md#principles)
