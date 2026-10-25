# 安装和运行

需要 macOS、Python 3.11 或更新版本，以及已安装、已登录的 Codex CLI 或 Claude Code。运行脚本只用 Python 标准库。这里的安装和激活命令由使用者或已获授权的 agent 执行；文件交付不会自动修改全局配置、登录账号、加载 launchd 或发布帖子。

## 安装同一份 skill

将 `x-auto-post` 文件夹复制到已有 skill 目录。不要覆盖同名的既有 skill；先比较内容。Codex 用户目录为 `~/.agents/skills/x-auto-post`，Claude Code 用户目录为 `~/.claude/skills/x-auto-post`。也可以按宿主规范安装为项目 skill。保留 `scripts`、`references`、`assets` 和 `agents` 子目录。

两个宿主可以各有一份 skill，但必须使用同一个配置和 `state_dir`。定时器只选择一个选材 agent；切换 provider 后继续使用同一历史。下面用路径变量说明命令；设置时用本机实际绝对路径，不把尖括号直接输入终端。

另行安装 `human-writing-zh`：Codex 用户目录为 `~/.agents/skills/human-writing-zh`，Claude Code 用户目录为 `~/.claude/skills/human-writing-zh`，目录内须包含 `SKILL.md` 及它引用的材料。可将两个入口链接到同一份由用户管理的 skill 目录。`x-auto-post` 不分发、不复制它的内容；更新独立 skill 后，下一轮生成会重新加载。后台在私有运行目录启动，不能依赖只安装在别的项目中的 skill。

```sh
XPOST_SKILL="$HOME/.agents/skills/x-auto-post"
XPOST_CONFIG="$HOME/Library/Application Support/x-auto-post/config.json"
```

第一次在已授权的位置创建私有目录，将 `assets/config.example.json` 复制为配置文件。目录权限设为 `0700`，配置文件设为 `0600`。不要把真实账号配置或凭据提交到版本仓库。

## 一次设置账号、主题和频率

1. 注册或使用 Buffer Free，连接用户自己的 X 账号。检查实际界面仍是 Free；不要开始收费订阅。连接流程由账号运营者完成，包括 X 授权页面要求的操作。
2. 在 Buffer 的 API 设置创建 Free 可用的 personal API key。密钥作用于 Buffer 账号的组织，不能把它当作只有一个 X 频道的凭据。文件权限 `0600`，将文件路径填入 `credentials.token_file`。也可使用 `BUFFER_API_KEY`，但 launchd 默认不会继承交互式 shell 的变量，因此后台任务优先使用私有文件。不要将密钥作为命令行参数。
3. 运行只读账号查询，选择对应的 `organization_id`、`channel_id` 和 X `handle`：

   ```sh
   python3 "$XPOST_SKILL/scripts/xpost.py" --config "$XPOST_CONFIG" accounts
   ```

   `accounts` 不发帖，会读取凭据、调用 Buffer，并在私有数据库记录请求额度。它可在 `enabled=false`、主题和时间尚未填写时运行。

4. 填写 `topics`。首个来源 URL 应指向每篇自己的主要事件，不能总是新闻首页。题材可多样，但必须属于配置的主题。
5. 由用户填写 `schedule.times`，格式为 `HH:MM`；`weekdays` 为 `0..6`，0 是星期一。`timezone` 使用 IANA 名称。`times` 与 `weekdays` 的组合就是频率，不设置额外的隐藏发帖频率。`lead_minutes` 默认 30，表示在发布时间前最多 30 分钟开始选材；它不是发帖间隔。
6. `agent.provider` 选择 `codex` 或 `claude`。建议在 `agent.executable` 填入 `command -v codex` 或 `command -v claude` 显示的绝对路径；不执行安装，也不覆盖已有模型配置。`language` 和 `voice` 可按需要调整。
7. 检查配置并预览候选。取得针对该账号、主题和频率的持续自动发布授权后，设置 `enabled=true`。正常后续发布不逐篇审批。

```sh
python3 "$XPOST_SKILL/scripts/xpost.py" --config "$XPOST_CONFIG" check
python3 "$XPOST_SKILL/scripts/xpost.py" --config "$XPOST_CONFIG" preview --candidate /absolute/path/candidate.json
```

`check` 不检查凭据或网络。`preview` 不读取密钥，不请求 Buffer，不创建数据库；已有历史只读。通过预览不能证明账号已连通。

尚未提供 Buffer 账号时，可以先填写主题、频率和 agent。账号字段保持空字符串，`check` 返回 `incomplete`、`account_ready=false`，`preview` 仍可回显候选正文、图片和发布时间；`history` 返回空历史。这些命令不要求虚构账号 ID。`publish`、`run`、`reconcile` 和 `launchd` 仍要求完整账号字段。账号信息补全后才生成绑定真实账号的定时配置。

## 先运行一轮，再激活定时器

```sh
python3 "$XPOST_SKILL/scripts/xpost.py" --config "$XPOST_CONFIG" run
```

在准备窗口内，`run` 会检查 Buffer 账号、队列和最近历史，调用 agent 搜索和写作，然后提交至配置时段。在窗口外返回 `idle`。没有可靠素材会跳过本时段。错过的时段不会集中补发。

Codex 使用 `codex exec --sandbox read-only`、实时 web search、JSON schema 和最后结果文件，明确调用 `$human-writing-zh`。Claude Code 使用 `claude -p` 和 JSON schema，提供 `WebSearch,WebFetch,Read,Skill`；仅预授权网页研究、`Skill(human-writing-zh)` 和该 skill 目录内的文件读取。符号链接同时授权安装入口和实际目标目录，不提供 Bash、写入或发布工具。双方沿用现有登录和模型设置，均不使用跳过所有权限的参数。Claude 的 `--bare` 不采用，因为它不使用订阅 OAuth 登录。宿主的管理策略、网络限制、登录失效、搜索不可用或 CLI 改动仍可使运行失败。

选材只传入主题、口吻、发布时间和历史，移除子进程环境中的 `BUFFER_API_KEY`。父进程读取发布凭据。Codex 的文件读取权限仍由宿主控制，这不是对宿主全部文件的安全隔离保证。子进程每轮有超时，超时后终止其进程组，不提交内容。正常跳过、成功、限流冷却、队列暂满及单次超时或候选格式失败不通知；需要处理的认证、权限和结果不明确等异常按代码去重。生成失败的时段会保留跳过记录，不会每五分钟重复消耗模型额度。

生成 launchd 文件；这一步不会激活它：

```sh
python3 "$XPOST_SKILL/scripts/xpost.py" --config "$XPOST_CONFIG" launchd --output /absolute/path/local.x-auto-post.plist
```

生成的 plist 含绝对 Python、脚本、配置路径与本机 PATH，不含密钥。`StartInterval=300` 表示每五分钟检查是否需要运行，空闲检查不调用模型和 Buffer；到期结果与异常恢复可请求 Buffer。对长期后台运行，确认 `credentials.token_file` 已设好且 Python、CLI 路径保持可用。

plist 绑定生成时的绝对路径和账号。更换安装目录、Python 路径或发布账号后需要重新生成；临时演练产生的 plist 不能直接当作真实部署配置使用。

用户授权启用后，将生成的 plist 放到 `~/Library/LaunchAgents/`。用生成结果中的实际文件名执行：

```sh
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/local.x-auto-post.plist"
```

不要重复加载同一服务。修改频率只需修改配置，脚本每次重新读取。若要暂停，先将 `enabled=false`；它停止新提交，但 Buffer 已排队的帖子仍会发布。需要取消已排队帖子时，由用户或获得具体授权的 agent 在 Buffer 操作。不要把暂停本地程序说成撤销远端队列。

卸载定时器使用实际安装路径：

```sh
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/local.x-auto-post.plist"
```

睡眠、关机或用户未登录时，launchd 不生成新内容。Buffer 中已有队列继续由 Buffer 发布。此版本不提供云端持续选材。

## 查询和处理异常

用户要求调整已排队帖子的表达时，可对同一篇执行：

```sh
python3 "$XPOST_SKILL/scripts/xpost.py" --config "$XPOST_CONFIG" revise --buffer-id <history中的帖子ID> --candidate /absolute/path/revised-candidate.json
```

只允许改写当前账号历史中的排队帖子，距发布时间须至少 60 秒。保留事件标识、主要来源、图片和时段。脚本先查询旧稿，再保存修改记录并调用 Buffer `editPost`；请求只包含帖子 ID、正文和 AI 辅助标记，不改变排期或创建第二条。修改记录保存在同一数据库的 `revisions` 表中。响应丢失后，旧正文读回不能证明修改失败；保持待确认状态，只有查询到预期新正文才恢复。服务明确拒绝且独立读回旧稿时，保留旧稿并报告 `revision_rejected`。

```sh
python3 "$XPOST_SKILL/scripts/xpost.py" --config "$XPOST_CONFIG" history
python3 "$XPOST_SKILL/scripts/xpost.py" --config "$XPOST_CONFIG" reconcile
```

历史数据库：`<state_dir>/state.sqlite3`。每轮模型输入和候选：`<state_dir>/runs/<run-id>/`。定时器日志：`scheduler.stdout.log` 与 `scheduler.stderr.log`。这些文件含账号内容和来源，保持私有权限。脚本不会保存 API key、原始认证响应或模型 stderr。

| 状态或代码 | 具体含义与处理 |
| --- | --- |
| `scheduled` | 已经通过 Buffer 帖子 ID 独立查询到排队记录，尚不能说已发到 X。 |
| `sent` | Buffer 查询返回已发送；`external_link` 存在时到 X 检查正文和账号。 |
| `duplicate` / `occupied` / `skipped` | 内容重复、时段已处理或无合适素材；正常情况，不要求用户介入。 |
| `uncertain_submission` | 提交结果不明确。查询到唯一相符记录才恢复。未查询到不证明没有发布；停止新增提交，核查 Buffer。不能清库或直接重发。 |
| `publication_failed` / `publication_rejected` | Buffer 报告失败或拒绝，保留事件和时段，不自动重发。已知失败不会导致重复提交，后续新事件仍按频率处理。 |
| `buffer_auth` / `channel_unavailable` | API key 或频道连接有问题，需要在 Buffer 修复。没有发帖授权时不要修改账号权限。 |
| `queue_full` | Free 每频道最多同时排队 10 条，等待腾出位置，不升级。 |
| `api_rate_limit` / `api_cooldown` / `api_budget` | 服务限流或本地请求预算耗尽，等待冷却或额度恢复，不即时重试。 |
| `agent_failed` / `agent_timeout` / `agent_output` | 选材进程失败、超时或输出不合格，本时段跳过，检查 CLI 登录、权限和 schema 支持。 |
| `writing_skill_unavailable` | 当前选材宿主的用户 skill 目录缺少可读的 `human-writing-zh/SKILL.md`。安装或恢复该独立 skill；本时段不生成、不提交内容。 |

共享目录使用文件锁，SQLite 在提交前持久记录事件和时段。精确文本、事件标识和主要来源 URL 长期去重，最近 1000 条本地正文做相似度比较。另检查 Buffer 最近 30 天创建的帖子和整个待发队列；最多读取 20 页，超过时停止提交。两个 agent 必须共享历史，其他服务、人工网页发帖和多个不同 state_dir 无法靠本地锁统一控制。语义去重仍取决于选材 agent 阅读历史并使用稳定事件标识。

图片 URL、正文、频道和发布时间必须匹配才采纳不明确的提交。如果 Buffer 改写图片来源 URL，或者人工编辑了帖子，自动匹配会停止，需要人工核实。此版本没有自动“确认不存在”或清除待确认记录的命令；无法确定时优先保留暂停状态。

脚本按 Free 上限记录本进程体系的滚动请求：100 次/15 分钟、250 次/24 小时、3000 次/30 天。其他 Buffer 工具和 MCP 共用服务额度，本地数据库看不到它们的具体请求；服务响应头显示额度为 0，或返回 429 时，脚本记录冷却并停止请求。创建请求明确收到 429 时保留已知失败记录，冷却后可处理后续新事件，不把它误判为永远无法确认的提交。响应丢失仍保持 `uncertain`。正常一次发布至少包括频道查询、队列查询、近期帖子查询、创建和独立查询，通常约 5 次请求，分页和状态检查会增加次数。由用户设定频率，超出 Free 额度时停止提交，不收费兜底。AI 调用仍使用用户已有 agent 服务的额度。

## 可复现的本地检查

在交付项目根目录运行：

```sh
python3 tests/e2e.py --label final
```

报告和独立服务状态保存在 `artifacts/verification/<run>/`。测试使用本机合成 GraphQL 服务与合成 agent CLI，没有访问真实账号或调用真实模型。报告包含每个场景、输入、命令、输出、服务提交状态与源文件 SHA-256。不存在 Git 仓库时用源文件指纹标识检查对象。
