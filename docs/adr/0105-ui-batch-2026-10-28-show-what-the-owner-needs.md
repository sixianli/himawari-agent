---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-28"
covers: ""
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0105：10-28 界面整批修改：只给主人需要的信息，记忆和提醒各有入口，设置只留主人会改的项

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [和早先决定的关系](#relation)
- [比较过的方案](#options)
- [业界做法](#industry)
- [后果](#consequences)
- [关联文档](#references)
- [后续](#follow-up)

<a id="context"></a>

## 背景

Himawari 网页（Andy 日常聊天用的网页，代码在 `apps/control-center`）上线第十六版后，Andy 在 2026-10-28 18:44–19:27（日本时间）逐条发了 22 条界面意见，清单和原话在 `/mnt/project-files/ui-feedback/2026-10-28-ui-ux-batch.md`。意见集中在三件事上：

- 显示的信息不是主人想看的。原话：“你得站在用户的角度思考用户想要知道什么信息，而不是你以为！”例如回答上方的“最久：搜索网页 3.1s”、步骤里“从第 0.2s 到第 1.6s”、Token 行里的费用和说明文字。
- 东西放错了地方。“你必须好好思考提醒是否应该放在记忆这个模块中！！！！”“你必须好好思考设置里面打底什么该放，什么不该放！”
- 细节粗糙：品牌字样、步骤图标、记忆详情对不齐、文件页一会儿有一会儿没有。

Claude 做了可点原型（<https://claude.ai/artifact/KYcGzu8DdXoLNUT8XuD8JL>，三语、演示数据），几处给了多套方案。Andy 当晚逐条批注选定：品牌字样 D、右键菜单 A、提醒用小圆点、过程区方案 A、步骤图标 D、回答底栏 A、文件筛选 B；Token 行“不要彩色条”，“缓存”要写明是 LLM 的 KV 缓存命中；外观缩略图“太大太唐突”；主题色“文字不要上对应的颜色”；并提醒“同样的意思，不同的语言长度不同，请你注意排版和视觉的调整”。未批注的地方按推荐做。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

逐条要求写在 [v4 设计说明的 v9 增补](../execution/specs/2026-09-15-control-center-v4-design.md#v9-ui-batch)，这里只记录会长期约束后续设计的几条：

1. **过程区和回答下方只放主人关心的信息。** 收起时一句话说做了什么和总用时（“搜索了 2 次网页，用时 13.1s”）。展开后每步只写这一步的总耗时，数字由这一轮执行记录的时间戳相减得出，有测试逐项核对。最下面一行只有 Token 总数和“缓存命中 N%”，N 是本轮输入里从模型服务商 KV 缓存（模型服务商把算过的前文存起来，下次同样开头的输入直接复用）读出的部分所占比例：缓存读取 ÷（普通输入 + 缓存读取 + 缓存写入）。不显示费用。回答下方只放操作（复制、从这里开新对话），时刻悬停才显示。
2. **能点开的才给箭头。** 过程里的步骤只有在有内容可看（工具参数和结果、记忆原文）时才能展开，并显示小箭头；没有内容的步骤不能点。
3. **记忆和提醒各有侧栏入口，都不放在设置里。** 记忆是独立页面；提醒是独立页面，按到期、今天、本周、以后分组。侧栏“提醒”只在有到期提醒时显示一个小圆点，不写文字。小圆点表示真实的待处理状态，不用来标“新功能”。
4. **设置只留主人会改的项。** 四页：通用（称呼、界面语言、外观、主题色）、通知、工具与权限（联网搜索开关；发送说明默认折叠；“先问你再做的操作”固定开启）、数据（已归档对话和一句浏览器存储说明）。称呼只存在浏览器里，用在欢迎页问候。
5. **品牌字样是两行：Himawari + ひまわり。** 两种字体只取用到的字形，随网页一起发布，不连外部字体服务；网页的内容安全策略为此加上 `font-src 'self'`。
6. **回答里的加粗由写作规则约束。** 系统提示加一条：加粗只用在最值得注意的一两处。网页的 Markdown 显示只在模型写了 `**` 时加粗，所以问题出在模型写法，不在网页。
7. **三种语言一起验收。** 每个改过的页面在中英日三种语言、电脑和手机宽度下截图检查；按钮和标签不写死宽度，放不下时换行。

[↑ 返回阅读导航](#contents)

<a id="relation"></a>

## 和早先决定的关系

- [ADR 0087](0087-chat-ui-v6-process-timeline.md) 定了 v6 过程区：收起时显示分类时间条和“最久”，展开后有分段明细和分类合计。本 ADR 改掉其中收起一行、分段明细和分类合计；每步的时间条、葵盘标志、前端体积不设上限和界面三语等其余决定不变。
- [ADR 0096](0096-phone-chat-page-safe-area-and-quiet-answer-line.md) 定了回答下方一行写“用时 · 时刻 · N tokens”。本 ADR 把用时和 token 移回过程区，这一行只留操作，时刻悬停显示；不显示模型名、安全区留边等其余决定不变。
- [ADR 0100](0100-conversation-more-panel-files-and-background-commands.md#baseline-rule) 的基线规则（不加堆放内部运行信息的通用面板）继续有效。记忆页和提醒页都是有明确用途的页面，原型已经 Andy 批准，截图存为基线 `docs/assets/control-center/2026-10-28-v9/`。

因为两份旧 ADR 只有部分内容被替换，它们保持 `active`，在各自末尾加一条指向本 ADR 的后续说明，不改写原决定。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

每处多套方案的样子在原型里，Andy 的选择见[背景](#context)。这里记录没选的方案为什么没选：

- **过程区收起时保留细时间条（方案 B）。** 能一眼看出哪段长，但主人看这一行时只想知道“做了什么、多久”；时间条留在展开后的每一步上。
- **步骤图标用细线（A）、彩色圆底（B）或只用色点（C）。** Andy 选了小方框（D），更有分量，代价是每行多占一点高度。
- **回答底栏保留常驻时刻（B）。** 选了 A：时刻悬停才显示，触屏设备上一直淡淡显示，因为手机没有悬停。原型 A 里的“⋯”按钮没有做：“从这里开新对话”拿出来后菜单里没有别的操作，放一个空菜单就是摆设。
- **文件筛选只用图标（A）。** 选了图标加文字（B），不用悬停也看得懂。
- **数据页放“这台设备 · 退出登录”。** 没做：生产环境的登录由 Cloudflare Access（网页前面的一道邮箱验证码）负责，网页里没有可以退出的会话，放按钮也不会生效。
- **提醒继续放在记忆页里当一个标签。** 提醒是“到点要做的事”，记忆是“关于主人的事实”，主人找提醒时不会先想到记忆。

[↑ 返回阅读导航](#contents)

<a id="industry"></a>

## 业界做法

- Anthropic 提示缓存文档（2026-10-28 打开）：“`cache_read_input_tokens`: Number of tokens retrieved from the cache for this request”，并给出 “total_input_tokens = cache_read_input_tokens + cache_creation_input_tokens + input_tokens”。缓存命中率的分母按这个算法取全部输入。<https://platform.claude.com/docs/en/build-with-claude/prompt-caching>
- DeepSeek 上下文硬盘缓存文档（2026-10-28 打开，生产主模型来自 DeepSeek）：“`prompt_cache_hit_tokens`: The number of tokens in the input of this request that resulted in a cache hit.” <https://api-docs.deepseek.com/guides/kv_cache>
- ChatGPT 和 Claude 的回答底栏只放操作（复制、重试、更多），不放耗时和 token；这是原型阶段对两家网页的观察，没有一手文档可引。OpenAI 帮助中心“自定义说明”一页（设置称呼的入口）本次打开返回 HTTP 403，未核对。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 好处：收起的一行能直接回答“它刚才做了什么”；设置变短，记忆和提醒各自有地方找；耗时数字只有一个来源，不会出现两处数字对不上。
- 代价：费用不再显示在网页上，要看费用得查用量账本；“最久的一步”需要展开过程才能看出来。
- 未验证：加粗规则没有在云端取生产回答原文核对，也没有用评测集实测效果；上线后看几轮真实回答再判断。
- 后续：回答“重新回答”按钮两家都有，Himawari 没有这个后端功能，这批不做。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [v4 设计说明 · v9 增补](../execution/specs/2026-09-15-control-center-v4-design.md#v9-ui-batch)
- 截图基线：`docs/assets/control-center/2026-10-28-v9/`
- 面试案例：[案例 44](../engineering-casebook.md#case-ui-batch-1028)
- PR #80
- [ADR 0087](0087-chat-ui-v6-process-timeline.md)、[ADR 0096](0096-phone-chat-page-safe-area-and-quiet-answer-line.md)、[ADR 0100](0100-conversation-more-panel-files-and-background-commands.md)

[↑ 返回阅读导航](#contents)

<a id="follow-up"></a>

## 后续

- 2026-10-29：[ADR 0110](0110-ui-batch-2026-10-29-check-it-before-the-owner-does.md) 第 3 条替换本 ADR 第 4 条“称呼只存在浏览器里”：称呼、界面语言和主题色改存服务器，跨设备一致。回答下方的“从这里开新对话”改名“分出新对话”。其余决定不变。

[↑ 返回阅读导航](#contents)
