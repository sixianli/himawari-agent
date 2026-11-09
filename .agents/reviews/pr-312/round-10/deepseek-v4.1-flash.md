## 一、读代码证实的发现（按严重度）

**高：无。中：无。**

**低 1｜`scripts/model-review/opencode-review.mjs:571`｜`LANG` 回退分支没有任何用例覆盖**
- 证据（原文）：`const ctype = env.LC_CTYPE ?? env.LC_ALL ?? env.LANG;`
- 新增/改动的用例只喂了 `LC_CTYPE` 或 `LC_ALL`：`opencode-review.test.mjs:1234-1235`（LC_ALL+LC_CTYPE）、`:1260`（只有 LC_ALL）、`:1331`（LANG+LC_ALL）。没有一条只带 `LANG`。
- 影响：如果实现退化成 `LC_CTYPE ?? LC_ALL`（丢掉 `LANG` 这支），现有测试全绿，但父进程通常恰恰只有 `LANG`。这是测试缺口，不是当前代码错误。
- 建议：为 `opencodeChildEnv({ parentEnv: { PATH, LANG: "ja_JP.UTF-8" } })` 和 `gitChildEnv({ PATH, LANG: "ja_JP.UTF-8" })` 各加一条断言 `LC_CTYPE === "ja_JP.UTF-8"`。

**低 2｜`scripts/model-review/opencode-review.mjs:622`、`:634`｜`extraEnv` 里的 `LC_CTYPE` 现在会被父环境悄悄压掉，行为与改前不同**
- 证据：`...extraEnv,` 在前，`...englishMessages(parentEnv),` 在后；`englishMessages` 只要父环境有 `LC_CTYPE/LC_ALL/LANG` 就一定写 `LC_CTYPE`。改前 `opencodeChildEnv` 只在末尾固定 `LC_MESSAGES`/`LANGUAGE`，父环境没有 `LC_CTYPE` 时 `extraEnv` 的 `LC_CTYPE` 会保留，父环境有时则 `extraEnv` 覆盖父环境。
- 影响：目前生产调用方（`gatewayOpencodeEnv`、`runOne`、自检）都不传 `LC_CTYPE`，所以实际无影响；但“`extraEnv` 有时能覆盖、有时不能”是隐性规则，且没有用例。
- 建议：明确 `extraEnv` 是否允许设置字符类；若要允许，就让它排在 `englishMessages(parentEnv)` 之后，或直接从合并后的 `env` 计算 `ctype`，并补一条用例。

**低 3｜`scripts/model-review/opencode-review.mjs:571-573`｜空串 `LC_CTYPE`/`LC_ALL` 会挡住回退，可能把字符类退回 C**
- 证据：`??` 只认 `undefined/null`；`LC_CTYPE=""` 时 `ctype` 取空串，且 `ctype === undefined` 为假，会写出 `LC_CTYPE: ""`，不再回退到 `LC_ALL`/`LANG`。`gitChildEnv` 尤其明显：旧实现会把 `LC_ALL` 原样交给 git，`LC_ALL=""`+`LANG=ja` 时 git 仍能按 `LANG` 取字符类；新实现变成 `LC_CTYPE=""` 且丢掉 `LC_ALL`。
- 影响：只有父进程把 locale 变量显式设成空串的边界场景，属于推测性影响，但新单元测试的“三个都没有”用例没有覆盖“三个里有空串”。
- 建议：若把空串视为未设置，用 `env.LC_CTYPE || env.LC_ALL || env.LANG`（或显式过滤空串），并加一条空串用例。

**低 4｜`scripts/model-review/opencode-review.mjs:687-690`｜包装脚本 `unset LC_ALL` 后不再补回字符类，当前只靠 `opencodeChildEnv` 提前转换**
- 证据：包装脚本仍是 `unset LC_ALL` / `export LC_MESSAGES=C` / `export LANGUAGE=C`，没有 `LC_CTYPE`。生产路径上 `opencodeChildEnv` 已把 `LC_ALL` 转成 `LC_CTYPE`，所以没问题；但直接调用包装脚本（现有集成用例就是直接调用）且父环境只有 `LC_ALL`、没有 `LANG` 时，`bash -r` 的字符类会退回 C。
- 建议：要么在包装脚本里也按 `LC_CTYPE:-LC_ALL:-LANG` 显式导出 `LC_CTYPE`，要么在注释/文档里写明“包装脚本假定调用方已把字符类放进 `LC_CTYPE`”。注意 `noTemplateCurlyInString`，写法要避开 `${...}` 或按上一轮的做法处理。

**低 5｜`.agents/instructions/model-review.md:76`｜说明文档的白名单描述与代码不完全一致**
- 证据（原文）：“只留 `PATH`、`HOME`、`LANG` 和固定的 git 设置”。实际 `gitChildEnv` 还保留 `TERM`，并新增 `LC_CTYPE`、`LC_MESSAGES`、`LANGUAGE` 三个固定值。
- 影响：纯文档一致性问题，不影响运行；但这是本轮改白名单后最容易被下一位读者误读的地方。
- 建议：改成“保留 `PATH`、`HOME`、`LANG`、`TERM`，并固定 `LC_MESSAGES=C`、`LANGUAGE=C`、`LC_CTYPE`（从父环境字符类推导）”。

## 二、推测 / 未核实

- 我无法运行测试（工具只有 git 与读文件），作者“170 条全过、lint 通过”的说法**未核实**；下面关于反向用例的判断是读代码推出来的。
- `.agents/reviews/pr-312/round-9/*` 读不到（git 替身按 records-path 拒绝），只看了提交说明里的四条判断。
- 作者提到的“真 git 打印的字真的变英文”无法在本容器验证；新增用例只验证了传给 git 的环境变量，作者自己也承认了这一点。

## 三、侧重检查（错误路径、不可信输入、安全、资源耗尽、不可逆操作、规则/文档一致性）

- **错误路径**：`englishMessages` 在三个变量都缺失时不写 `LC_CTYPE`（`ctype === undefined` 分支），不会造出 `undefined` 键；`opencodeChildEnv` 的 `delete env.LC_ALL` 仍在，`extraEnv` 带入的 `LC_ALL` 会被清掉。未发现新增的异常路径。
- **不可信输入**：`LC_*`/`LANG` 来自父进程，属操作环境而非被复核仓库内容；不是密钥，不在 `isSecretEnvName`/代理凭据检查范围。`englishMessages` 不改写 Prompt、不落盘，无注入面。
- **安全**：删掉 `LC_ALL` 比保留更收紧；`gitChildEnv` 仍只保留白名单加固定值，没有新增外部命令执行路径；包装脚本新增的只是 `export LANGUAGE=C`，没有打开重定向/`cd` 等限制。
- **资源耗尽**：本轮没有循环、没有按输入扩大的分配，只有固定三个键的对象展开。
- **不可逆操作**：没有新增删除、覆盖、写入；测试里新增的也只是 `env` 探测。
- **规则/文档一致性**：`.claude/rules/prompt-prefix.md` 我按 `1a3a1ef` 读到了，本轮改动不涉及请求组装；`.agents/instructions/model-review.md:76` 的白名单描述偏旧（低 5）。
- **作者的正则判断**：我核对后同意“不采纳”是安全的。现模式 `^(?:\S*\/)?(?:ba)?sh: (line \d+: )?[^\n]*: restricted` 对 `Author: f: restricted` 这类行不匹配；唯一会漏的是 `command -v bash` 返回含空格路径的机器，但没有证据本项目会在那种机器上跑复核。真的出现时方向是“自检多失败/漏掉 allowed 探针被误挡的告警”，不会把真实拒绝当成放行（write/read 探针会以 `PROBE_NOT_REFUSED` 失败，仍是 fail-closed），所以我认为不构成本轮的中/高问题，留作已知局限即可。

## 四、总体结论

本轮增量没有中、高严重度问题；没有发现新增的“真实拒绝被漏判”或“正常输出被误判”路径，也没有发现新增的空转断言。上面 5 条都是低/文档/测试覆盖问题，不阻塞合并。

## 五、必答问题

1. **会不会改变模型已经见过的请求开头？** 本轮增量不会。改动只涉及子进程的环境变量（`englishMessages`、两个白名单、包装脚本）和测试断言；`buildPrompt`（`opencode-review.mjs:277-305`）不读环境变量，系统提示、工具定义、历史、遮盖逻辑均未动，仍是“只在末尾追加”。整个 PR 的其它文件我也看了本轮可见的 diff：`production-sandbox-tool-result.ts` 只改新生成的上限说明文字，不是改写已发历史；没有把每轮变化的值塞进系统提示或工具定义。

2. **会不会让同一段文字在不同请求里变成不同字节？** 不会。`englishMessages` 的输出是固定键顺序的固定值，`LC_CTYPE` 在同一进程/同一轮内取自同一父环境；没有时间字段、没有无序集合、没有前后文相关的遮盖。`limitBytes` 的换算是确定性的。

3. **有没有对应的自动检查，反向用例是否真的会失败？** 有，且逻辑上非空转：
   - `opencode-review.test.mjs:1122-1129`：父环境给 `LC_ALL/LC_MESSAGES/LANGUAGE=ja`，断言 `env` 输出没有 `LC_ALL=`，且整行出现 `LC_MESSAGES=C`、`LANGUAGE=C`。删掉 `unset LC_ALL` 或 `export LANGUAGE=C` 都会失败。
   - `:1250-1268`：`LC_ALL`-only 与三者皆无两种父环境；去掉 `env.LC_ALL` 回退或去掉 `undefined` 保护都会失败。
   - `:1310-1339`：`gitChildEnv` 的精确对象断言；去掉 `englishMessages` 或把 `LC_ALL` 放回白名单都会因多键/少键失败。
   - 未覆盖：上面低 1 的 `LANG`-only 分支、低 3 的空串分支。未发现任何断言变成“永远成立”。

4. **本轮产生/修改的每个值，两端都接受吗？** 逐个核对：
   - `LC_MESSAGES=C`、`LANGUAGE=C`：生产方 `englishMessages`；消费方 opencode、真 git、受限 bash。都是普通环境变量，代码里没有任何键名校验会拒绝它们。
   - `LC_CTYPE`：生产方 `englishMessages`；消费方同上。opencode/git/bash 都按 libc 规则接受；白名单测试 `:1183` 只禁止 `TOKEN/SECRET/KEY/PASS`，`LC_CTYPE` 能通过。
   - `LC_ALL`：从 `GIT_KEPT_ENV` 和 `OPENCODE_KEPT_ENV` 移除。`opencodeChildEnv` 本来就 `delete env.LC_ALL`，所以 opencode 侧净效果不变；`gitChildEnv` 侧不再把父值原样交给 git，改由 `LC_CTYPE` 承载字符类；`gateway.mjs` 的 `GATEWAY_KEPT_ENV` 是另一条链，仍保留 `LC_ALL`，不受影响。
   - 新导出 `englishMessages`：只被 `gitChildEnv`、`opencodeChildEnv` 使用；`opencodeEnv` 的直接调用只有测试。
   - 包装脚本新增 `export LANGUAGE=C`：被 `bash -r` 及其子进程接受，无校验点。
   - 唯一的两端小偏差是低 2 的 `extraEnv` `LC_CTYPE` 优先级问题；目前没有生产调用方传这个键，不影响本轮合并。

## 六、对作者三问的直接回答

1. **有没有引入“真实拒绝漏判”或“正常输出误判”？** 没有。git 替身的拒绝标记是硬编码 ASCII；受限 bash 现在 `LC_MESSAGES=C` + `LANGUAGE=C`，只会更稳定地输出英文 `restricted`；opencode 自己的拒绝话术不受 locale 影响；`env` 只是测试探测。
2. **有没有把断言变成永远成立？** 没有。新断言的三个条件分别依赖 `unset LC_ALL`、`export LC_MESSAGES=C`、`export LANGUAGE=C`，删掉对应行都会红；`toContain` 是数组整元素匹配，不是子串匹配。
3. **两个函数逐键差异**：`opencodeChildEnv` 只在父环境“有 LC_ALL/LANG 但没有 LC_CTYPE”时新增 `LC_CTYPE`，其余键不变；`gitChildEnv` 去掉了 `LC_ALL`，新增了 `LC_CTYPE`、`LC_MESSAGES=C`、`LANGUAGE=C`，其余（PATH/HOME/LANG/TERM/GIT_ENV）不变。没有发现消费端因为多这三个键或少了 `LC_ALL` 而拒绝或行为异常；唯一未声明的差异是低 2 的 `extraEnv` `LC_CTYPE` 优先级。
