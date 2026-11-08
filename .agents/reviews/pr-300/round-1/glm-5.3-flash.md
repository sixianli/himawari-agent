# 复核报告：PR 300（复核委托给云端线程）

## 读过的材料

- `git diff 9f75931..51dd5b2` 全量（scripts、test、docs、AGENTS.md）
- `scripts/model-review/delegate.mjs`（新文件，358 行，全文）
- `scripts/model-review/opencode-review.mjs` 的相关段：2400–2560（选项/子命令/网关门）、2576–2630（gatewayRecordFields）、1455–1560（parseUsage）、2772–2834（main 顺序）
- `test/tooling/review-delegate.test.mjs`、`test/tooling/review-gateway.test.mjs` 新增部分
- `.claude/rules/prompt-prefix.md`（复核指令引用的规则原文）
- `.agents/reviews/topic-review-delegation/` 下的记录文件：本复核环境对 records 路径返回 `REVIEW_GIT_REFUSED records-path`，内容**未核实**（210 条测试、九处改坏实验也无权运行，**未核实**）

## 发现的问题（按严重度从高到低）

### 中

**1. `check` 不校验记录目录内的其他文件，`verdicts.jsonl`/`judgments.md` 可被云端线程伪造而不被拒**
- 文件：`scripts/model-review/delegate.mjs:192-196`（目录白名单）、`scripts/model-review/opencode-review.mjs:1091`、`1426`（verdicts.jsonl 是 `--assert-reviewed` 的输入）
- 证据：`delegate.mjs:193` 只要求改动文件以 `.agents/reviews/<key>/` 开头：`const outside = changed.find((file) => !file.startsWith(`${REVIEWS_DIR}/${key}/`));`。目录内新增 `round-N/verdicts.jsonl`、`judgments.md`、改写 `briefs/` 里的材料，都通过 check。而 `opencode-review.mjs:1091` 读 `${ledgerPath}/round-${round}/verdicts.jsonl` 作为合并前核对的依据。任务说明只口头禁止（`delegate.mjs:151` “不写 verdicts.jsonl 和 judgments.md”），check 不强制。
- 影响：出错或恶意的云端线程可以先放一份伪造的逐条判断，Mac 线程合并后跑 `--assert-reviewed` 时门可能按伪造内容放行。文档已声明“防误操作，不防有意”（model-review.md 局限一节），所以不算违背承诺，但这是“云端结果不能直接信”里唯一没有技术防线的一段。
- 建议：check 对目录内改动加白名单（`usage.jsonl`、`round-N/<短名>.md`、`round-N/<短名>.prompt.md`），至少明确拒绝 `verdicts.jsonl`、`judgments.md` 和对 `briefs/` 的改动。

### 低

**2. 新记录的 `round` 没有和交出参数比对**
- 文件：`delegate.mjs:204-216`
- 证据：逐条核对里查了 `mode/head/base/previous/model/gateway/providers`，没有 `record.round !== task.round` 的检查；答案文件路径用的也是 `record.round`（`:224-227`）。补跑任务（`--round 2`）交回 round-1 的记录不会被拒。文档（model-review.md delegate 一节）说“新记录的 mode、head、base、previous、模型、服务方都和交出时一致”，漏了 round。
- 建议：补一条 `round` 比对，或文档说明 round 不校验。

**3. `wait` 的 git 失败被静默吞掉，与“没动静”不可区分**
- 文件：`delegate.mjs:240-243`（`remoteHead`，`allowFail: true` 失败返回 `""`）、`:226-233`（`waitForBranch`：`if (sha && sha !== tip)`，空串当没变）
- 证据：`git ls-remote` 持续失败（断网、远端仓库被删）时，wait 不会报错，会一直空转到 90 分钟然后报 `DELEGATION_WAIT_TIMEOUT`，exit 3。`check` 里的 git 失败则正确地以 `DELEGATE_GIT_FAILED` 抛出（`:179-184`）。文档没写 wait 对 git 失败的行为。
- 顺带：文档说“90 分钟没变”，实际最后一次轮询在第 88 分钟（`tries = ceil(90*60/120) = 45`，轮询时刻 t=0,2,…,88 分钟），88–90 分钟之间的移动会被误报超时。极小。
- 建议：`remoteHead` 失败时至少区分“查询失败”和“没变”；文档补一句。

**4. `wait` 的 `--minutes`/`--interval-seconds` 未校验，NaN 会变成“立即超时”**
- 文件：`delegate.mjs:297-298`（只 `Number(take())`）、`:224`（`Math.max(1, Math.ceil(NaN)) = NaN`，`attempt < NaN` 为假，一次都不轮询直接返回未移动 → exit 3）。
- 建议：像其他字段一样校验正整数。

**5. `gatewayRequiredProblem` 只验代理变量非空，不验值合法**
- 文件：`opencode-review.mjs:2426`：`PROXY_ENV.some((name) => (env[name] ?? "").trim() !== "")`。设一个乱值 `HTTPS_PROXY=x` 即可通过 `no-proxy` 门。属启发式，真正的花钱防线是本机无密钥且 `gateway=magpie` 必须有配置，推测实际利用价值小。

**6. `provider !== "none"` 豁免是无必要的放宽**
- 文件：`delegate.mjs:222`。`none` 是保留 id（`gateway.mjs:69`），真实记录（`gatewayRecordFields`，`opencode-review.mjs:2576-2599`）不会产生它；豁免让伪造记录可以塞一个 `none` 条目绕过服务方白名单，无实际服务方含义，影响极小。

**7. 测试覆盖缺口（读代码证实）**
- `delegate.mjs` 的 `main()`（退出码 3/5/2 的接线、输出行）无测试——文档把“以 3 结束/以 5 结束”当成契约；`remoteHead` 的真实 `ls-remote` 路径（wait 用例全用注入的 `lsRemote`）；`checkResult` 的 fetch 失败（`DELEGATE_GIT_FAILED`）；`DELEGATION_NO_NEW_RECORDS`、`DELEGATION_LEDGER_INVALID` 分支；`parseTask` 对 `check`/`wait` 子命令的完整解析。已有 13 条 delegate 用例确凿覆盖了 rewritten/改代码/改旧账本/字段不匹配/缺答案文件/本地前移，这部分是好的。

## 侧重检查（普通使用流程走查）

流程：① Mac 线程提交材料+记录目录并推送 → ② `delegate.mjs prompt`（validateTask → reviewArgv → parseArgs 二次校验 → 模板拼装；4 组用例覆盖校验、字节稳定、防注入）→ ③ 桌面应用 `start_session`（仓库外，未核实）→ ④ 云端跑 `opencode-review.mjs --require-gateway …`（parseArgs 校验、main 代理门在 `readFileSync(brief)`/`readGatewayConfig`/安装之前——有 spawnSync 反向用例）→ ⑤ 云端提交推送（`check:gitleaks` 只在 prompt 里口头要求，无强制）→ ⑥ `delegate.mjs wait`（waitForBranch 有注入时钟用例；真实 ls-remote、退出码接线无测试）→ ⑦ `delegate.mjs check --apply`（fixture 覆盖主要拒绝路径；main 接线、fetch 失败、NO_NEW_RECORDS 无测试）→ ⑧ Mac 线程逐条判断、`--assert-reviewed`（未改动，但接住 check 放过的 verdicts.jsonl——见中危 1）。
结论：脚本的纯函数层覆盖较好，CLI 接线层（退出码、真实 git 调用）完全没有测试；文档与代码总体一致，仅“90 分钟/round”两处偏差。

## 必答问题

1. **请求开头只追加？** 是。改动只涉及参数解析（`--require-gateway`）、main 里的一道门（在读材料 `opencode-review.mjs:2797`、读网关配置 `:2789`、安装之前，`:2787-2788`）、新文件 delegate.mjs、测试和文档；`buildPrompt`、历史组装、遮盖、usage 记录格式都没动，已发给模型的内容不受影响。`delegationPrompt` 是给云端 Claude 会话的全新一条消息（本身就是最后一条），不含逐轮变化的值。
2. **同一段文字会变字节吗？** 会变的源头没有新增。`delegationPrompt` 无时间字段，测试断言同参数逐字节相同（review-delegate.test.mjs 第 33–35 行）；所有插值都过了正则/枚举校验。`usage.jsonl` 的序列化逻辑未改动。`toFixed(4)` 等输出确定。
3. **有自动检查吗？反向用例会失败吗？** 有。13 条新 delegate 用例用临时 git 仓库真实构造强推、改代码、改旧账本、字段伪造、缺答案文件、本地前移，全部断言被拒及拒绝码；gateway 新用例反向断言 `GATEWAY_REQUIRED not-magpie`/`no-proxy`/`ARG_NOT_FOR_SUBCOMMAND`/自检豁免，并有一条真实 spawn 的反向用例。“210 条通过、九处改坏都失败”无法运行验证，**未核实**。
4. **每个新值的两端核对：** `--require-gateway`：产生于 parseArgs（`:2461`），消费于 `gatewayRequiredProblem`、main 门、reviewArgv 生成、子命令守卫（`given` 集合，`:2440`/`:2525`）——各端一致，测试覆盖。`GATEWAY_REQUIRED *` 错误码与文档一致（exit 2）。`delegate.mjs prompt/check/wait` 与 `DELEGATION_*`/退出码 3/5 与文档一致（exit 2 未写进文档，属遗漏不是矛盾）。brief 路径：`briefPathFor` 产生，`validateTask` 强制相等，消费端是 opencode-review 的 `--brief` 读文件和 prompt 第 0 步存在性检查——一致。`refs/remotes/origin/<branch>` 强制更新 refspec 无其他消费方。缺口：`round` 两端（见问题 2）；verdicts.jsonl 的产生端（云端）与消费端（`--assert-reviewed`）之间没有 check 把关（见中危 1）。
