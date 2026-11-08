# 审核结论

## 侧重检查（先做，走查最普通流程）

流程：Andy 要 PR 复核 → Mac 线程提交材料到分支 → 跑 `delegation-prompt.mjs` → `start_session` 开云端会话 → 云端 `git fetch` + 第 0 步 head 检查 → 跑 `opencode-review.mjs --require-gateway` → 云端提交账本并推送 → 回消息 → Mac 拉取、`--check-result` 核对 → 逐条判断 → `--assert-reviewed`。

核对过的对应物：`--brief` 在创建副本前从仓库读入（`scripts/model-review/opencode-review.mjs:2787`），副本确实排除 `.agents/reviews/`（同文件 2353、2373 行）——所以材料放在记录目录的 `briefs/` 子目录里**可行**，模型通过提示词拿到材料，不靠工具读；`--assert-reviewed` 的“只改记录目录”检查对 briefs 提交**兼容**。`vitest.workspace.ts:13` 确实清空 `HIMAWARI_REVIEW_GATEWAY`，与 `model-review.md:130` 一致；gateway 参数解析（`opencode-review.mjs:2496-2534`）与文档 130 行一致。

**无测试覆盖的路径**：① 交出前的账本续接（见问题 1）；② 第 0 步 head 检查（纯文字约束，无自动检查）；③ `--check-result`（方案 §7 完全没列它的测试）；④ DONE 消息解析。前三条都在主干道上。

## 问题清单（严重度从高到低）

**1.【中高·证实】交出前没有要求把整个记录目录（含账本 `usage.jsonl`）提交推送，只提交 briefs。**
证据：云端脚本的预算检查和轮次编号都读云端克隆里的账本——`opencode-review.mjs:2798` `readUsage(options.out)`、2801-2807 `budgetCheck`、2813-2826 `roundForRun`；而 `model-review.md:100` 现行做法是“合并前才把记录目录随 PR 提交”，即账本平时只在 Mac 本地。后果：a) 云端轮次从 1 重算，与 Mac 已有轮次冲突（`ROUND_HEAD_MISMATCH` 或拉回时账本冲突）；b) 累计费用先问门槛（`model-review.md:105`，1 美元/0.5 美元）在云端从零起算，可能不问 Andy 就越过累计线。改法：方案 §2 改成“交出前把整个 `.agents/reviews/<目录>/` 提交并推送”；`--check-result` 增加“云端账本是交出时账本的追加、没有丢行”的核对。

**2.【中·证实】`--check-result` 没有测试计划，必答问题 3 不满足。**
证据：方案 §7 只列了 delegation-prompt 生成和 `--require-gateway` 的用例；而 `--check-result` 是 Mac 端唯一防云端线程跑偏的自动核对（方案“风险”一节自己也靠它兜底）。改法：补正反用例——提交混入记录目录外的文件、`head`/`round`/`mode` 不符、账本缺行，都必须判失败。

**3.【中·证实】任务说明里的命令含按 CWD 解析的路径。**
证据：`opencode-review.mjs:2446` `options.brief = resolve(take())`——`--brief` 相对运行目录解析；`--repo` 同理。Mac 生成的命令若带 Mac 绝对路径，云端线程必须自行改命令，与“云端线程不得自己加参数”矛盾，也破坏“重跑逐字节一致”。改法：任务说明规定命令全部用仓库相对路径、在克隆根目录运行，测试断言生成的命令不含绝对路径。

**4.【低·证实，细节推测】`GATEWAY_REQUIRED` 的两处实现细节。**
a) `opencode-review.mjs:2532` 把 `--gateway direct` 直接 `delete options.gateway`，“命令行选了 direct”要在删除前记录，否则误判成“没选”；b) “`HTTPS_PROXY` 为空”这个判定假设云端容器用这个变量名注入代理——仓库里只能看到白名单列了它（`model-review.md:75`），云端实际注入哪个名字未核实，若名字不同会误停（好在是安全方向的误停）。

**5.【低·证实】委派会话开销 0.4–1.1 美元高于“其他花钱按 0.5 美元先问”（`model-review.md:37`），且不进账本，`BUDGET_NEEDS_APPROVAL` 看不见。**
改法：在新章节写明 Andy 批准本方案即预授权单次委派的会话开销，并定一个累计上限，超过仍先问。

**6.【低·证实】措辞冲突**：等待期间“不往这个分支推送”要和 `AGENTS.md:106`“每个提交立即推送”在新章节里协调（写成“等待期间不做任何提交”即可，否则两条规则打架）。

**7.【低·证实】前提 1 行号偏差**：“合并前核对代码都复核过”在 `model-review.md` 第 43 行（第 6 条），第 42 行是第 5 条。

**8.【未核实·须补进前提】云端线程对 origin 的推送权限**是第 3 步的硬前提，前提清单没列；`start_session` 工具、云端→Mac 消息通道仓库里也查不到（grep `start_session` 无结果，只有 Andy 转述）。建议动工前各实测一次。方案对消息丢失已有兜底（45 分钟后 fetch 分支），对“推送不了”没有兜底。

**9.【推测·建议】**DONE 消息里的 `REVIEW_RESULT`/`GATEWAY_USAGE`/`REVIEW_SPENT_TOTAL` 是云端线程转抄的文本；建议 `--check-result` 一并用账本重算核对，不信转抄。delegation-prompt.mjs 的输出不得嵌时间戳、枚举时排序固定，否则“重跑逐字节一致”不成立。

**业界对照**：把复核交给独立上下文的新会话、任务说明自成一体的做法与 Claude Code 官方 subagent 模型一致——“Each subagent runs in its own context window… It doesn't see your conversation history"（https://code.claude.com/docs/en/sub-agents）；以分支提交而非聊天消息作事实来源更可靠。未发现与业界成熟做法冲突之处。方案对“没采用 git 引用交接”的取舍理由（一次只有一个委派、避免一整套引用清理）成立。

## 必答问题

1. **不会改变请求开头。**改动只在复核工具链，Himawari 的请求组装不动；复核提示词仍由 `buildPrompt` 构造，新参数只影响开跑前检查（须插在 2787 行读材料之前）；云端会话是新对话，任务说明是第一条消息；DONE 是给 Mac 线程末尾追加的消息。brief 提交进 git 保证字节固定，重跑时 `ROUND_PROMPT_MISMATCH` 的逐字节比较仍成立。
2. **主要值已固定**（brief 在 git、账本 JSONL 追加、DONE 是新消息）；需补两条：delegation-prompt 输出无时间戳、枚举顺序固定；费用数字只出现在消息里，不进任何提示词固定部分。
3. **部分满足**：`--require-gateway` 与 delegation-prompt 有正反用例；`--check-result` 完全没有（问题 2）；第 0 步检查纯靠文字（可接受——`--head` 本身已锁定副本提交、账本记 `head`、`--check-result` 能兜住，第 0 步只防白跑，但应写明这个定位）。
4. **新值逐个核对**：`--require-gateway`（复核脚本自产自销，parseArgs 与用法文档同步）；`--branch`/`--reply-to`/`--check-result`（新脚本内部）；briefs 目录约定（`--brief` 在建副本前从仓库读，2787 行，已核实兼容；`--assert-reviewed` 的记录目录豁免已核实，2373 行）；DONE 消息格式（Mac 端解析，建议对照账本）。**未核实**：云端推送权限、`HTTPS_PROXY` 变量名、`start_session`、消息通道。

## 如果由我来定

采纳方案主体（分工、`--require-gateway`、briefs 进记录目录、`--check-result`、45 分钟兜底都保留），加四条：① 交出前把整个记录目录含账本提交推送，`--check-result` 核对账本续接和费用总数；② 给 `--check-result` 补正反测试，任务说明命令全部用仓库相对路径并加断言；③ 动工前实测云端推送权限、消息通道和代理变量名，作为前提 7-9 写进方案；④ 新章节写明会话开销的预授权范围和累计上限。
