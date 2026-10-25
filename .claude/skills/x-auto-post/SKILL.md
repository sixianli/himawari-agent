---
name: x-auto-post
description: Research, write, schedule, and publish original X posts through Buffer Free for a user's own account. Use for automatic posting, topic-based content generation, scheduled X publishing, publishing history, or duplicate prevention. Supports Codex and Claude Code on macOS without a user-owned paid X API key. 中文：X 自动发帖、定时发帖、自动选材、去重、发布历史。
---

# X 自动发布

按用户设定的主题和频率，为用户自己的 X 账号研究、写作，并通过 Buffer Free 自动发布。正常运行不要求逐篇审批。用户只需一次设置账号、主题、频率和使用的 agent。运行必须遵守宿主的权限与授权；本 skill 不会绕过确认要求。

采用标准 `SKILL.md` 和 Python 标准库，供 Codex、Claude Code 共用。所有发布都经 `scripts/xpost.py`，它调用 Buffer 的公开 GraphQL API。Buffer 在后台使用 X 官方 API，用户不需要申请或购买自己的 X API。不要切换到浏览器点击、私有接口、Cookie 导出或模拟人工操作作为故障后备。

中文正文的写作与审校依赖独立安装的 `human-writing-zh`。在 Codex 中调用 `$human-writing-zh`，在 Claude Code 中调用 `/human-writing-zh`，读取它的入口及按需引用的文件。这里不保存该 skill 的副本；角色分工和输出要求见 [选材与写作](references/editorial.md)。后台运行要求将它安装到对应宿主的用户 skill 目录，安装位置见 [安装和运行](references/installation.md)。

## 首次使用

先确认用户是在创建草稿、预览，还是已授权持续自动发布。创建、安装或预览 skill 本身不等于授权连接账号、启用定时任务或发送真实帖子。

如果尚未配置，读 [安装和运行](references/installation.md) 与 [服务和规则依据](references/services-and-rules.md)。复用已有用户选择，只询问缺失的实际账号、主题和频率。发布账号必须是用户自己的账号；配置指向一个账号。语言、口吻、agent 和时区使用用户已有选择或模板建议。不要替用户决定发布频率。

在获准的配置位置复制 `assets/config.example.json`。将账号 ID 和 handle、主题、星期与时间填入配置。用私有文件或环境变量提供 Buffer API key，不把密钥放进对话、配置正文、代码、任务提示词或日志。不要要求用户付费升级。检查当前 Buffer Free 条款和 X 自动化规则；规则已变更或存在影响该用途的未解决限制时，说明具体限制，不承诺“零封号风险”。

持续自动发布的授权应明确绑定账号、主题和频率。取得该授权后将 `enabled` 设为 `true`，沿用它完成后续正常运行，无需每篇重新询问。账号认证失效或服务明确要求人工处理时才通知用户。启用系统定时任务遵循宿主的实际权限；权限拒绝不能当作已经启用。

## 单次或人工触发

1. 用 `python3 <skill>/scripts/xpost.py --config <config> history` 读取去重历史。
2. 读 [选材与写作](references/editorial.md)，调用 `human-writing-zh` 编辑正文。实时搜索并打开来源，在配置主题内生成符合 `assets/candidate.schema.json` 的候选对象，保存到任务所有的文件。
3. 用 `python3 <skill>/scripts/xpost.py --config <config> preview --candidate <candidate>` 检查。预览会回显正文、图片和时间，不读取凭据、不请求 Buffer、不创建历史数据库。尚未连接 Buffer 时，填好主题和频率即可预览，账号字段可以留空；`account_ready=false` 表示尚不能发布，不要伪造账号 ID。
4. 用户已授权该账号持续自动发布，或明确授权本次发布时，运行 `python3 <skill>/scripts/xpost.py --config <config> publish --candidate <candidate>`。默认安排在配置的下一个时段。`--due-at <ISO-8601>` 只能选择配置中未来两周内的合法时段，不能绕过频率。
5. 根据返回值报告真实状态。`scheduled` 表示 Buffer 队列已接收；`sending` 表示正在发送；`sent` 和 `external_link` 来自之后的查询。不能把排队成功说成已经发到 X。

如果用户想让 agent 自行选材并完成整轮发布，使用 `run`。它在预定时段前的准备窗口调用配置中的 agent CLI，生成候选并提交。准备窗口外只做必要的本地检查及到期结果查询，不调用选材模型。

用户要求改进尚未发布的稿子时，读选材与写作规则，调用 `human-writing-zh` 改写同一事件的候选，然后执行 `revise --buffer-id <历史中的真实 Buffer ID> --candidate <candidate>`。它只修改正文，保留账号、帖子 ID、时段、事件、主要来源和图片。不能用再次 `publish` 替换原稿。修改前记录待确认状态，按同一 ID 独立查询新正文后才更新为排队成功；响应丢失时执行 `reconcile`，不要再次修改或提交。已发送或即将发送的帖子不能改稿。

## 全自动定时运行

读 [安装和运行](references/installation.md) 的 launchd 步骤。脚本生成 plist，用户授权激活后由 macOS 定时调用 `run`。它使用已登录的 Codex 或 Claude Code，不新增模型 API key，不修改全局模型选择。选材进程不直接接收 Buffer 密钥；发布由父进程完成。

两个 agent 使用同一配置与 `state_dir`。不要复制数据库后让两份历史各自发布。配置的每个时段最多提交一次。无可靠素材返回 `skip`，记录已跳过时段。重复内容不换标题、不换事件标识、不重试提交。系统睡眠时不会实时生成新内容；已经交给 Buffer 的帖子按其队列继续发布。醒来后不补发错过的时段。

## 结果不明确和异常

执行 `python3 <skill>/scripts/xpost.py --config <config> reconcile` 查询待确认及排队中的帖子。提交前数据库会先记录 `uncertain`（尚未确认结果）。响应丢失、服务错误或程序中断后，禁止直接再次 `createPost`。

脚本会按频道、提交时间、正文、发布时间和图片 URL 查找，再用帖子 ID 独立查询。只有唯一匹配才接受结果。没有查询到帖子不等于证明它不存在。不能确定时保留 `uncertain`，暂停该频道的新提交，只通知需要处理的异常。不要自动清空数据库、换 `state_dir`、删除记录、降低去重标准或手工改状态来继续发帖。

`error` 表示已知失败或被拒绝；保留事件与时段记录，不自动重发。账号失效需在 Buffer 恢复连接。配额或队列满不升级套餐，等待空间或额度恢复。具体代码、检查命令和限制见安装说明。

## 检查界限

`check` 只检查配置。`preview` 只检查本地候选。项目的合成服务测试不证明真实账号已连接、真实 agent 能无人值守搜索、launchd 已运行或 X 已发布。报告检查范围并提供证据路径。实际启用后，至少独立查询一条真实帖子及其 X 链接，再确认用户看到的结果。
