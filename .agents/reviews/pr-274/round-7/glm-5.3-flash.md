# 代码复核报告（PR #274 第 7 轮，316eaf2b494274a230b2aa34f5cced3537755077 vs 7281d941）

## 侧重检查（先写的部分）

我走的流程：用户让 Pi 跑一条 bash 命令 → `pi-coding-request.ts`/runner 执行 → 前台结果 `formatForegroundPiResult`（`packages/platform-node/src/files/pi-host-publication.ts:55-138`）→ 完整输出走 `exportPiOutputFile`（`pi-output-export.ts`，先 `redactForEgress` 再 base64，带上 `redacted: true`）→ 结果存回对话（原文）→ 下一轮请求经 `pi-model-transport.ts:314` 的 `exchange.wrapFetch` → `ModelEgress.#prepare` → `maskTree` → `redactForEgress`（含残缺私钥、data: 收紧）→ `assertMachineSecretFree` 自检 → 发出。沿线各步在本次改动里都有测试：`production-foreground-result.unit.test.ts`（用 `test/fixtures/model-egress.ts` 真走一遍出口遮盖）、`product-path-browser.test.ts` 的三个 [R2-T14] 场景、`pi-coding-program.unit.test.ts`。没有测试覆盖的路径：`host-file-read-service.ts`（服务层删掉扫描后，`production-file-read-workflow.unit.test.ts` 没补“含密钥文件也能读”的正向用例；平台层 `constrained-file-system.unit.test.ts:660-669` 补了）。`redacted: true` 字段没有任何生产消费者（见问题 6）。

## 发现的问题（按严重度从高到低）

**1.（中）`packages/application/src/services/model-egress.ts:420` — data 网址跳过用的密钥检测和新的残缺私钥规则不一致，形如 data 网址的字符串可以整段绕过残缺私钥遮盖。**
证据：跳过条件是 `if (BASE64_DATA_URL.test(value) && scanMachineSecrets(value).length === 0) return value;`，而 `scanMachineSecrets`（`packages/sensitive-capture/src/machine-secrets.ts:47-54`）只按 `RULES` 匹配——私钥规则只认完整 BEGIN…END 块（machine-secrets.ts:24-25）；残缺私钥检测（`KEY_HEAD`/`KEY_TAIL`）只存在于 `redactPrivateKeyFragments`，只在 `redactForEgress` 里被调用（`redaction.ts:300`）。`BASE64_DATA_URL` 的正则允许 base64 段内含换行（model-egress.ts:411 的 `[A-Za-z0-9+/\r\n]*`），所以字符串 `"data:text/plain;base64,-----BEGIN [拆开] PRIVATE KEY-----\nMIIE…" `（真实换行，JSON 层会被转义）能通过该正则、又不含完整块，于是整个跳过、不进 `redactForEgress`；最后第 224 行的 `assertMachineSecretFree` 也只跑 `scanMachineSecrets`，不会拦。这是作者问的第 1 个问题（“有没有哪条路径的文字到模型之前不经过出口遮盖”）的一个真实答案：有，被当作 data 网址跳过的字符串。
建议：跳过条件改用和遮盖一致的检测，比如把“存在 `PRIVATE KEY-----` 标记”作为跳过的否定条件，或给 sensitive-capture 暴露一个“含残缺私钥”的判定函数给这里用。

**2.（中，属于流程/许可范围）data 网址收紧这一条也会改变已发过的历史字节，但 Andy 的同意只记录在残缺私钥这一条上。**
证据：改动前 maskTree 对任何以 `data:` 开头的字符串一律原样放行（旧代码 `value.startsWith("data:") return value`，见本次 diff 删除行）；改动后 data: 前缀但非 base64 形状、或形状匹配但认出机器密钥的字符串，第一次会被遮成 `[密钥]` 等（model-egress.ts:419-422、redaction.ts:300-304）。这改变既往请求里该消息的字节。规则文件 `.claude/rules/prompt-prefix.md:35` 把出口遮盖列为唯一例外、`:52` 要求遮法确定；作者说法里引用的 Andy 2026-11-07 同意仅针对“对所有发给模型的文字都遮残缺私钥”，data 网址收紧没有对应记录（本仓库 docs 里也没有找到这两条同意的落档，仅 `.agents/reviews` 的评审记录）。是推测还是证实：ollen范围对照是读代码证实的；“仓库里没有同意记录”也是我 grep docs 没找到的证实；“Andy 实际是否口头同意过”未核实。
建议：把两条规则的“已发内容会变一次”一起记入同意记录（或把 data 网址收紧挪到有记录的后续改动里）。

**3.（低）`packages/sensitive-capture/src/machine-secrets.ts:94-115` — 结尾残块的回看窗口会把结尾标记前最多 19200 字符内所有“长得像正文”的普通行整段遮掉。**
证据：`KEY_TAIL_WINDOW = KEY_LINES * 160`，`from = Math.max(floor, marker.index - KEY_TAIL_WINDOW)`，`KEY_LINE` 只要求行首前缀可空、随后 ≥16 个 `[A-Za-z0-9+/=]` 字符到行尾。也就是说：一段引用了 `-----END RSA PRIVATE KEY-----` 的普通文本（hex dump、id、时间戳样的字母数字行）只要在窗口内就会被合并成一块遮掉。测试自己也把这个当预期行为（`private-key-fragments.unit.test.ts:61-67`，20000 字符的 `A` 行遮到只剩 18000 字符差）。代价是误遮普通内容、丢文本；概率受“必须出现结尾标记”限制。这是读代码证实的行为描述，是否可接受是取舍（推测 Andy 之前看过 window 语义）。
建议：在 commit 或 casebook 里把“误遮窗口”记为已知取舍即可，不必改。

**4.（低）行数超过 120 的私钥片段盖不住。**
证据：`KEY_LINES = 120`、`KEY_HEAD` 的 `(?:…){0,120}` 和 `KEY_TAIL` 的 `{1,120}` 上限；开头残块超过 120 行正文时，第 121 行起不遮且没有结尾标记可比对，会以明文发出（自检也扫不到，见问题 1 的同源说明）。真实密钥（4096 位 RSA 约 25 行、8192 位约 50 行）远低于 120 行，这是读代码证实的边界、实际风险为推测等级。
建议：不修，写进已知边界。

**5.（低）文档与代码已经不一致（作者说文档在后续 PR，这里只列证据）。**
- `docs/architecture-v0.1.md:82`、`docs/runbooks/install-start-stop-runbook.md:316`、`authority-transfer-runbook.md:227`、`backup-restore-runbook.md:214`、`hermes-control-center-upgrade-runbook.md:172` 仍写“输出含机器秘密（包括只剩开头行或结尾行的私钥片段）时只交出说明和真实退出码”；现在 `pi-host-publication.ts` 的 `withhold` 已删除（diff 确认），输出改由出口遮盖。
- `docs/backlog/BL-20261017-001.md:22` 写“现在线上的第四次变更同样存在（发布阶段扫描后抛 PI_RESULT_SECRET_REJECTED）”；本次 PR 删掉了发布阶段的扫描（`production-file-preparation.ts`、`pi-host-publication.ts`），该描述过时。
- `packages/sensitive-capture/README.md:11` 对 machine-secrets.ts 的函数清单没有补 `redactPrivateKeyFragments`。
全部是读文件证实。
建议：后续 PR 处理时以这份清单为起点。

**6.（信息）`packages/platform-node/src/files/pi-output-export.ts:60` 新增的 `redacted: true` 字段目前没有任何生产代码消费，只有测试断言它存在。**（读代码证实）
建议：确认后续消费方（比如显示端提示“已遮”）再交付，或留注释说明这是给外部观察者的标记。

**7.（信息，推测）入向流式遮盖 `machineSecretHoldStart`（machine-secrets.ts:189-215）只在结尾缺完整块时扣“-----BEGIN”开头，没有扣“只剩结尾行”的片段，`StreamingMachineSecretRedactor.flush`（:234-238）也只跑 `redactMachineSecrets`。**
这是内部记录/显示方向（`pi-model-transport.ts:336`、`execution-live-feed.ts`），按 Andy 的原则内部允许原文，所以不是回归，但和“同一形状在出口遮、向内不遮”的差异值得在措辞里讲清楚。

## 作者说法逐条核对结果

说法 1（去掉 10 处整段拦下）：与 diff 逐一相符，证实（含 NUL 的两处检查确实保留：`host-read-only-executor.ts:138-140`、`production-file-preparation.ts:46` 等）。说法 2（字节原样）证实。说法 3（完整输出先遮再编码 + redacted 标记 + `REDACTOR_ONLY_FILES`）证实，`redacted` 字段的 `byteLength`/`digest` 都按遮后字节算（测试 `production-foreground-result.unit.test.ts:221-228`）。说法 4（残缺私钥）证实，规则先于其他机器密钥规则执行、认得 diff/grep/JSON 转义、只有标记不遮，均有用例。说法 5（withheld）证实且端口枚举此前已有 `withheld`（`ports/sensitive-interceptions.ts:35`）。说法 6（登记表）证实，实际计数与登记一致（exa 2、deepseek 1、model-egress `{assertMachineSecretFree:1, scanMachineSecrets:1}`、pi-output-export 1——“已核对的事实”两条也证实）。说法 7（data 收紧）证实，但存在问题 1 的不一致和问题 2 的许可范围缺口。说法 8（截断首字符）证实（`model-output-budget.ts:31,69-70`）。

## 必答问题

1. **会不会改变已见过的请求开头：会，一次性、可预期，且范围里有一条超出已记录的同意。** 发送侧仍然只在末尾追加：历史存原文（规则 5 的遮盖例外不变），本次改动只改遮盖规则、不改结构、不重排历史、没有新增每轮会变的值（`fitOutput` 的去头只依赖输出本身；`redacted: true` 属于本次工具结果）。两条新规则（残缺私钥、data 收紧）都会让“以前发过的、含相应形状文字的消息”在新版本第一次发送时字节变一次：残缺私钥已获口头同意（仓库内查无落地记录，未核实）；data 收紧没有记录同意（问题 2）。
2. **同一段文字会不会在不同请求里变成不同字节：不会。** 残缺私钥遮盖只依赖字符串自身（`maskKeyTails` 的窗口边界也只看同一段文字内的标记），data 收紧判定也只看值自身；`named-earlier` 这类依赖“之前内容”的规则没被本次改动触碰。跨请求持续不一致的来源（时间字段、无序集合）没有新增。
3. **有没有自动检查、反向用例会不会真的失败：登记表这份有，且反向用例真实存在**——`test/tooling/egress-redaction-check.test.mjs:187-299` 包含“新增未登记调用会报错”“登记与代码计数不一致会报错”“别名会报错”，而且 :187 的 `findSensitiveGateViolations()` 直接对本仓库跑，登记计数错一行就会挂。行为层面的反向由正向断言反证（`raw).not.toContain(...)` 若遮盖撤销即失败）。缺的是：没有静态门槛能发现“遮盖规则本身倒退”（比如有人改坏 `KEY_TAIL`），这块依赖单元测试本身不被删。另有一个检查覆盖不住的缝：scanMachineSecrets 与 redactPrivateKeyFragments 的不一致（问题 1）。
4. **每个新值两端核对：** `outcome:"withheld"`（端口枚举已有，`sensitive-interception-recorder.ts:77` 消费，有单测）、`redacted:true`（无消费者，问题 6）、`SENSITIVE_GATE_CALLS` 删改（计数与代码一致并被 :187 的本仓库断言守住）、`REDACTOR_ONLY_FILES` 增加（脚本 :228 唯一的红名单）、`PI_OUTPUT_SECRET_REJECTED`→`PI_OUTPUT_FILE_REJECTED`（全仓库无残留引用，grep 证实）、`OUTPUT_REDACTED` 失败类型（全仓库无残留引用）。唯一两端不对齐的就是问题 1。

未核实的部分：magpie/网关路径下是否真的不存在 `file`/`input_file`/`document` 类型块（我在 `packages/runtime-pi/src` 里 grep 不到这三种 type 的生成，与作者“已核对事实”相符，但没查 Magpie 侧组装）；Andy 同意记录未入库；各单元测试未实际运行（本环境只读）。
