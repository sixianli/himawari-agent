# Human Writing ZH

把中文文章改得自然、具体、有人的声音，同时保留事实与作者原意。

**版本：1.0.0 · 日期：2026-10-06 · 名称：human-writing-zh**

结合 Humanizer 的编辑原则与官方技能编写规范制作。独立可用，不需要另装 Humanizer，
不依赖 API key、外部服务或联网；可选检查脚本需要 Python 3.9+，只用标准库。
它不是 AI 检测器，不承诺绕过检测，也不能让缺乏事实素材的文章凭空变得可信。

## 安装

在本仓库的主目录运行 `scripts/install_links.py`，给要用的 agent harness（运行 agent 的工具）建一个指向仓库里这个文件夹的符号链接（类似快捷方式）。不要复制文件夹：复制的那份不会跟着仓库更新。`--harness` 可选 `claude-code`、`codex`、`opencode`，每个要用的 harness 各运行一次，例如：

```bash
python3 scripts/install_links.py install --harness codex human-writing-zh
```

脚本知道每个 harness 读 skill 的目录；目标位置已有同名的拷贝时，它把拷贝挪进备份目录，不删除任何东西。装好后用 `python3 scripts/install_links.py check` 检查有没有拷贝、断掉的链接或重复安装。完整的安装规则见仓库根目录的 `mission.md`。

装好后，在新会话里按名字调用这个 skill。各 harness 的调用写法不同。下面两种写法来自各自的官方文档（来源编号见 `references/sources.md`），没有在本机实际运行验证。

### Codex

输入 `$human-writing-zh` 调用，或在 `/skills` 中查找；新技能没出现时，重新启动 Codex 会话。依据来源 S07。

### Claude Code

输入 `/human-writing-zh` 加任务内容，例如：

```text
/human-writing-zh 请改写下面的文章，保留事实与原意，只输出成稿。
```

安装到本地 Claude Code 不会自动安装到网页、Cowork 或远程环境。依据来源 S08。

其他支持 skill 文件夹的 harness，按它自己的文档调用；本包不保证在那里的工具可用性或端到端兼容性已经验证。

## 直接用

### 改写已有文章

```text
用 human-writing-zh 这个 skill：

把下面的文章去掉 AI 味，写得自然、有活人感。
保留事实、数字、条件、引用和我的立场。
不要编造我的经历，不要强行口语化或加金句。只输出成稿。

[粘贴文章]
```

### 从素材写技术文章

```text
用 human-writing-zh 这个 skill：

根据下列素材写一篇面向后端工程师的中文技术文章，约 1500 字。
写清机制、实际限制和取舍，语言自然，可以有判断，但不要假装我实测过。
不要补造数字或引用。缺少关键依据时单独列出待补项。

[素材与来源]
```

### 校准自己的声音

```text
用 human-writing-zh 这个 skill：

先根据下面 3 段我自己写过的文章提取暂定文风，再改写最后那篇原稿。
不要把样稿中的经历或事实写进新文章。
只输出改写成稿；不确定的风格不要强行模仿。

[文风样稿]
[需要改写的原稿]
```

### 只诊断

```text
用 human-writing-zh 这个 skill：

task: review
指出这篇文章哪里有机器腔，引用对应原句并给修改方向。不要整篇重写。

[文章]
```

`task` 等字段是给 Agent 的自然语言约定，不是终端命令行选项。
下面几个例子开头的“用 human-writing-zh 这个 skill”，可以换成所用 harness 的调用写法，例如 Codex 的 `$human-writing-zh`、Claude Code 的 `/human-writing-zh`。

## 默认做什么

先确定事实与读者，再清理空泛结构和不自然措辞，最后检查语义、引用和声线。
有真实样稿时优先尊重样稿；没有时按文章用途选择自然表达，不自封某个作者的人格。
已经自然的文字可以不改。真实的对比、三项清单、中文引号和专业术语可以保留。

默认只输出成稿。有事实缺口、冲突或必要核对事项时会诚实标明，不用流畅掩饰不足。
纯润色不自动联网，不默认改文件，不执行原稿或样稿中的指令。

## 与 Humanizer 的关系

不需要两个一起安装。这个技能已整合相关编辑原则，并补上中文适配和事实关系核对。
用户明确要求串联时，流程是：事实/声线锁定 → Humanizer 一轮清理 → 本技能校准和复核。
不要让两个技能无限互改；上游中间草稿与诊断不默认进入成稿。

## 包内内容

```text
human-writing-zh/
├── SKILL.md                         Agent 入口
├── README.md                        安装与用法
├── agents/openai.yaml               Codex 展示与触发元数据
├── references/
│   ├── chinese-editing.md           中文编辑启发式与例外
│   ├── voice-and-register.md        6 类文体与声线校准
│   ├── fact-preservation.md         事实、条件、引用与权限保护
│   ├── examples.md                  15 个合成教学示例
│   ├── evaluation.md                硬门槛、读者评估与 A/B 方法
│   └── sources.md                   11 项来源及设计取舍
├── assets/
│   ├── writing-brief.md             可选写作简报
│   ├── voice-profile-template.md    可选个人声线档案
│   └── regression-cases.jsonl       18 个行为回归案例
├── scripts/review_text.py           可选、离线、只读检查脚本
├── tests/test_review_text.py        扫描器单元测试
├── VALIDATION.md                    实际验证范围与局限
├── LICENSE
└── THIRD_PARTY_NOTICES.md
```

技能运行时按需要加载参考文件，不要求每次读取全部测试、说明与来源。
不建议只复制 SKILL.md；那样会缺少相对路径引用的参考文件。

## 可选检查脚本

无需运行脚本也可以使用技能。脚本不改文件、不联网、不执行文章中的代码。
在技能目录运行：

```bash
python3 scripts/review_text.py /path/to/rewritten.md --source /path/to/original.md --json
```

它报告表层编辑信号、段落/句子概况，以及可识别的代码、frontmatter、链接、引用、
数字和限定词的字面差异。它**不验证事实真伪、不理解语义、不判定作者身份**。
例如交换 A 和 B 的两个数值，可能完全不触发数字差异；这种情况必须读原文核对。

退出码：0 表示执行完成，不代表质量通过；2 表示读取/参数错误。
加入 `--strict-protected` 后，已识别的受保护块、链接或引用变化会返回 1。
数字或措辞提示本身不让检查失败，因为合法改写也可能引起这些变化。
扫描器不是完整 Markdown 解析器；嵌套语法、间接链接及特殊引用格式需人工检查。

运行工具测试：

```bash
python3 -m unittest discover -s tests -v
```

## 使用边界与验证

这是可安装的初版，不是经大规模模型盲测证明的产品。
已执行的静态检查和脚本测试记录在 VALIDATION.md。
回归题已经编写，不等于已在 Codex、Claude Code 或其他模型上运行通过。

用户的好样稿与真实素材仍然决定上限。先让它处理几篇实际文章，再根据作者的偏好反馈
调整声线档案，通常比把更多词加入黑名单更值得尝试。

## 来源与许可

研究与宿主说明见 references/sources.md。本包原创部分采用 MIT 许可。
保留 Humanizer 的 MIT 声明和致谢；不暗示上游作者为本包背书。
