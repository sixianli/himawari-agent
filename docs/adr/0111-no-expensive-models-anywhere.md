---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-29"
covers: "scripts/check-expensive-models.mjs, test/fixtures/jarvis-test/models.json, test/integration/fixtures/openrouter-live-configuration.ts, test/tooling/expensive-models.test.mjs"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0111：任何场景都不调用 Claude、OpenAI 等贵模型；评测裁判换成 Qwen3.8 Flash，并由检查脚本拦住贵模型名

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [这 2.27 美元花在哪](#bill)
- [决定](#decision)
- [裁判模型的价格对比](#prices)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

2026-10-29 13:31（日本时间），Andy 在 Vercel AI Gateway（Vercel 的模型网关，Himawari 经它调用模型）的“Budgets & Spend”页看到：本月花费最多的模型是 `anthropic/claude-sonnet-5.5`，2.27 美元，缓存命中 0%；生产主模型 DeepSeek V4.1 Flash 才 1.48 美元。他定下长期规则（已写进项目指令）：

- 任何场景（生产、评测、裁判、测试、实验、后台任务）都不得调用 Claude、OpenAI 或其他同价位的贵模型，一律用 DeepSeek V4.1 Flash 一类的低价模型或免费额度。
- 代码和评测脚本里不得再写死 `anthropic/*`、`openai/*` 模型名。

仓库里调用 Claude 的地方只有一处：Jarvis Test（按产品愿景写的真模型评测）第二层裁判写死了 `anthropic/claude-sonnet-5.5`（[ADR 0103 两层裁判](0103-jarvis-test-live-evaluation-and-two-tier-judge.md#judges)，选它的理由是“和被测的 DeepSeek 不是同一家”）。另外，草稿 PR #95 给评测加了把被测模型换成 `anthropic/claude-haiku-5.5` 或 `claude-sonnet-5.5` 的开关，10-29 的三模型对比评测就是用它跑的。`openai/*` 在代码里已经没有引用。

[↑ 返回阅读导航](#contents)

<a id="bill"></a>

## 这 2.27 美元花在哪

来源：2026-10-29 约 13:45 在 Andy 的浏览器里打开 Vercel AI Gateway 的 Logs 页（最近 30 天，按模型筛选），逐行读出每次请求的时间（日本时间）和费用后按时间段加总。Hobby 套餐不能用按模型汇总的报表接口（文档原文：“The reporting endpoint is available on Pro and Enterprise plans”），所以只能逐行读。

| 时间（日本时间） | 是哪次调用 | 次数 | 费用（美元） |
| --- | --- | --- | --- |
| 10-28 15:31–15:54 | Jarvis Test 第一次接真模型：裁判校准加三组小试跑（[案例 39](../engineering-casebook.md#case-jarvis-test-evals)），含 1 次被评测 key 拒绝的请求 | 106 | 0.25 |
| 10-28 16:03–16:41 | 三轮完整评测（16:03、16:11、16:37）的第二层裁判 | 149 | 0.46 |
| 10-28 22:51–22:56 | 第一轮“已校准”完整评测的第二层裁判 | 50 | 0.23 |
| 10-29 10:54–10:58 | “评估把问答切到 Claude 模型”线程的三模型对比评测：Sonnet 既当被测模型又当裁判 | 约 488 | 约 1.33 |
| 合计 | | 793 | 2.27 |

- 前三段逐行读到，合计 0.94 美元。第四段页面能读出 350 行、1.08 美元；筛选栏显示 Sonnet 共 793 次请求，逐行只读到 655 次，差的 138 次都在 10-29 那 4 分钟里（同一秒内并发的请求，页面滚动加载时漏读，两次读取数字不同，其余三段两次一致），所以第四段按 2.27 减去前三段计。
- 同一段时间 Claude Haiku 5.5 另有 29 次、0.03 美元（同一次对比评测）。
- OpenAI：30 天内只有 10-04 16:09、16:10 两次 `openai/gpt-6-astra`，共 0.01 美元（[ADR 0048](0048-vercel-ai-gateway-replaces-openrouter.md) 迁移网关时的连通验证）。
- 缓存命中 0% 的原因：裁判每次请求的材料都不同，而且没有用 Anthropic 的显式缓存，所以没有可复用的前缀。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **模型名集中写在一处。** Jarvis Test 的两个裁判模型从代码里移到 `test/fixtures/jarvis-test/models.json`，`gateway-judges.ts` 只从这里读。被测模型仍是测试共用配置里的生产主模型 DeepSeek V4.1 Flash（`test/integration/fixtures/openrouter-live-configuration.ts`）。
2. **第二层裁判换成 `alibaba/qwen3.8-flash`。** 仍然和被测的 DeepSeek 不是同一家，价格见[下表](#prices)。第一层 `typesafe-ai/jev-1.14.0` 不变。
3. **检查脚本拦住贵模型名。** `scripts/check-expensive-models.mjs`（`npm run check:expensive-models`，`npm run check` 的一步）扫描 `apps`、`packages`、`scripts`、`test`、`evals`、`tools`、`ci`、`config` 和根目录配置文件，出现以下任一写法就失败，并打印文件和行号：
   - 带厂商前缀的 `anthropic/…`、`openai/…`；
   - 不带前缀的 `claude-opus…`、`claude-sonnet…`、`claude-haiku…`、`claude-fable…`、`gpt-<数字>…`（直连厂商接口时的写法）。
   不扫的内容：`docs/` 下的文档（要记录历史）、`evals/*/history.jsonl`（历次评测的原始记录）、`node_modules`、`evidence` 目录、GitHub 链接里的 `/openai/codex` 这类路径和 `@anthropic-ai/sdk` 这类包名。
   唯一被豁免的测试文件是检查脚本自己的测试 `test/tooling/expensive-models.test.mjs`（它必须写出贵模型名才能测试检查）。其他测试文件的示例数据也照扫，不要拿 `gpt-4o` 这类真实型号当普通词用，换成中性的词（例如 `wi-fi6`）。
4. **换裁判后第一次跑评测前，先在线程里报费用。** 裁判换了，ADR 0103 的校准要重新过一遍（每轮开跑前自动校准 42 条样本），Andy 抽查过的“已校准”标记也要重新抽查。预计费用写在[后果](#consequences)里；超过 0.5 美元先在项目聊天问 Andy。

“同价位的贵模型”没有逐家列名：其他厂商的旗舰模型（例如 Google Gemini Pro 一档）也不许用；新增任何模型名都要写进集中配置，并在 PR 里写出每百万 token 价格，和 DeepSeek V4.1 Flash 比。

[↑ 返回阅读导航](#contents)

<a id="prices"></a>

## 裁判模型的价格对比

来源：2026-10-29 读取 Vercel 公开模型清单接口 `GET https://ai-gateway.vercel.sh/v1/models`（不计费）。单位：美元 / 每百万 token。

| 模型 | 输入 | 输出 | 和 Sonnet 5.5 比 | 说明 |
| --- | --- | --- | --- | --- |
| `anthropic/claude-sonnet-5.5`（原第二层裁判） | 2.00 | 10.00 | — | 禁用 |
| `alibaba/qwen3.8-flash`（新第二层裁判） | 0.15 | 0.47 | 输入约 1/13，输出约 1/21 | 阿里通义千问，带推理，1M 上下文 |
| `alibaba/qwen3.7-flash` | 0.03 | 0.13 | 输入约 1/67，输出约 1/77 | 上一代，官方定位偏视觉语言 |
| `zai/glm-5.3-flash` | 0.15 | 0.50 | 输入约 1/13，输出约 1/20 | 智谱，备选 |
| `xiaomi/mimo-v2.5` | 0.119 | 0.238 | 输入约 1/17，输出约 1/42 | 小米，发布较早 |
| `deepseek/deepseek-v4.1-flash`（被测模型） | 0.075 | 0.30 | — | 和被测同一家，不能当裁判 |
| `typesafe-ai/jev-1.14.0`（第一层裁判，不变） | 0.042 | 0 | — | 只回答“是”的概率 |

按 10-28 22:50 那轮的实际花费估算：第二层裁判花了 0.23 美元，换成 Qwen3.8 Flash 后约 0.01–0.02 美元；整轮（54 次试跑加两层裁判）从 0.37 美元降到约 0.16 美元，剩下的主要是被测的 DeepSeek。这是按价格比例推算的，未实测。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

### 裁判继续用 Sonnet，只把评测频率降下来

- 好处：裁判质量已经校准过，Andy 抽查 14 次全部同意。
- 代价：违反 Andy 的规则；每轮裁判仍要 0.2 美元以上。不选。

### 第二层裁判也用 DeepSeek V4.1 Flash

- 好处：最便宜，不用再接一家。
- 代价：裁判和被测是同一个模型，会偏向自己的回答，ADR 0103 正是为此要求“异厂”。不选。

### 第二层裁判用 Qwen3.7 Flash 或免费模型

- 好处：更便宜，甚至不要钱。
- 代价：Qwen3.7 Flash 是上一代，官方介绍偏视觉语言；网关上的免费模型（例如 `nvidia/nemotron-3.5-lightning-free`）稳定性和限流不明，评测要可重复。先选 Qwen3.8 Flash；校准不过时，按 GLM 5.3 Flash、Qwen3.7 Flash 的顺序换，只改 `models.json`。

### 只在 Vercel 账户上禁用 Claude 和 OpenAI

- 好处：网关直接拒绝，任何代码都绕不过去。Vercel 的 Model Allowlist（模型白名单）原文：“A request returns a `403` when the requested model is not on the allowlist”。
- 代价：只有 Pro 和 Enterprise 套餐能用（原文 “available on Pro and Enterprise plans”），成功请求每千次另收 0.10 美元；Andy 已定不升级 Pro。所以门槛落在仓库里。以后如果升级 Pro，这是第二道防线。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 好处：评测费用约降一半以上；代码、脚本、评测配置里再出现 Claude 或 OpenAI 模型名，`npm run check` 就失败，不靠人记。
- 代价：
  - 新裁判还没校准。第一次跑要先过校准，预计校准加一轮小规模试跑（每组 1 条、每条 1 次）不到 0.05 美元，完整一轮约 0.16 美元（推算，未实测），都要先在线程里报费用。
  - 检查只看仓库里的代码，拦不住有人在命令行里临时传一个 Claude 模型名；评测脚本的 `--subject` 这类开关不再接受贵模型，靠的是这道检查拦住写进代码的候选名单。
  - 生产配置 `/etc/himawari/config.json` 不在仓库里，检查扫不到；目前生产只用 DeepSeek V4.1 Flash、Qwen3 Embedding 8B 和两个重排模型（Vercel Logs 核对）。
- 后续：
  - 草稿 PR #95 加的“被测模型换成 Claude”开关要删掉，否则合并后 `npm run check` 失败（已告知该线程）。
  - 新裁判校准和抽查：等 Andy 同意费用后再跑。
- 2026-10-29 跟进：Andy 看过[价格对比](#prices)后 14:44 选定第二层裁判改用 `zai/glm-5.3-flash`（智谱，输入 0.15、输出 0.50 美元每百万 token，和 Qwen3.8 Flash 几乎同价，同样不是 DeepSeek 一家），只改了 `test/fixtures/jarvis-test/models.json`。两个模型当裁判谁更准都没测过；校准和抽查照旧，第一次跑前先报费用。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0103 Jarvis Test 两层裁判](0103-jarvis-test-live-evaluation-and-two-tier-judge.md)
- [ADR 0107 每个事故落一道自动检查](0107-every-incident-gets-an-automatic-gate.md)
- [事故与门槛清单 I-19](../incidents-and-gates.md#incidents)
- [案例 53](../engineering-casebook.md#case-no-expensive-models)
- Vercel 文档 [Custom Reporting](https://vercel.com/docs/ai-gateway/observability-and-spend/custom-reporting)、[Model Allowlist](https://vercel.com/docs/ai-gateway/security-and-compliance/model-allowlist)

[↑ 返回阅读导航](#contents)
