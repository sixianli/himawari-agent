## 复核结论（第 3 轮增量 1ccb5152..3af08b66）

### 问题一（中）：机器密钥配对只按“最早出现位置”排序，可能把两个不同密钥的 `[密钥]` 位置配反

- **严重度**：中
- **文件:行**：`packages/sensitive-capture/src/redaction.ts:341-356`、`packages/sensitive-capture/src/redaction.ts:384-397`
- **问题**：`machinePositions` 对每个 sighting 用 `input.indexOf(sighting.value, next)` 找“该值在原文中最早出现的位置”，再按这个猜测位置排序；随后把排序结果按顺序配给 `marked` 里出现的每个 `[密钥]`。如果同一密钥值有一次出现被更早的机器密钥规则整体吞掉（例如 Bearer 令牌里含 `sk-...`，整段 Bearer 先被遮掉），而同一 `sk-...` 又在后面单独出现，那么 `indexOf` 会指向前一次“已被吞掉的”位置。若两者之间还有别的机器密钥，排序就会和 `[密钥]` 的实际顺序不一致，返回非 null 但值配反。最后的 `text !== redactForEgress(input).text` 只校验正文，不校验每个 span 的 `sighting`，所以拦不住这种值错配。
- **证据（亲自读到）**：
  - `locateMaskedValues` 用 `machinePositions(input, machine)` 得到顺序，然后：
    ```ts
    const sighting = id === undefined ? ordered[machineIndex++] : tagged.get(id);
    ...
    if (machineIndex !== ordered.length || text !== redactForEgress(input).text) return null;
    ```
    这里只比较正文和数量，没有校验机器 span 的 identity。
  - `machinePositions` 的定位方式：
    ```ts
    const position = input.indexOf(sighting.value, next.get(sighting.value) ?? 0);
    if (position < 0) return null;
    next.set(sighting.value, position + sighting.value.length);
    placed.push({ position, sighting });
    ...
    return placed.sort((left, right) => left.position - right.position).map(({ sighting }) => sighting);
    ```
  - 机器规则确实是按规则顺序先后替换、后面的规则看不到已被前面替换掉的文本：`packages/sensitive-capture/src/machine-secrets.ts:67-71` 和 `redaction.ts:208-213`。
- **可复现的思路**（读代码推导，未实际运行）：输入同时含
  `Bearer sk-AAA...(16+)、ghp_BBB...、sk-AAA...`
  Bearer 规则先整体遮掉第一段，OpenAI 规则只看到并遮掉最后那段，但 `indexOf("sk-AAA...")` 找到的是 Bearer 里的那次。排序后两个 `[密钥]` 的值会互换，`locateMaskedValues` 仍返回非 null。于是 `sentBodyValues` 在“一个在窗口内、一个在窗口外”时会上报错的密钥值、漏掉真正发送的密钥值。
- **建议**：不要用 `indexOf` 猜位置。最稳妥的是让 `redactMachineSecrets` 在替换前把每个 match 的原文偏移一并交给 `observe`（或返回 `{text, occurrences:[{start, end, sighting}]}`），按真实偏移排序配对；或者在 `locateMaskedValues` 的标记轮里也给机器密钥生成可定位的带编号占位符（像非机器规则一样），彻底不依赖回查原文。补一个“同一机器密钥一次被前置规则吞掉、一次独立出现且中间夹有别的机器密钥”的用例。

---

### 问题二（中低）：用 run 是否存在来推断“对话是否已删”，会误丢仍然存在的对话的记录

- **严重度**：中低
- **文件:行**：`packages/persistence-sqlite/src/sqlite-sensitive-interception-operations.ts:138-156`
- **问题**：新逻辑在 `threadId === null && runId` 时查 `runs`，查不到就一律 `skipped`，注释/作者说法的前提是“删对话会连 runs 一起删”。但仓库里还有**单独删除 run、删除 task/monitor 时连带删 run** 的路径，这些路径不会删 `threads`。这时 run 已经不在了、对话还在，但带 runId 的后台调用（当前只给动作复核打开 `egressRunScoped`）产生的拦截记录会被当成“对话已删”丢掉。
- **证据（亲自读到）**：
  - 新判定：
    ```ts
    if (
      run === undefined ||
      (item.threadId !== null &&
        !threadExists.get(input.ownerId, input.agentId, item.threadId))
    ) {
      skipped += 1;
      continue;
    }
    ```
  - 可单独删 run、线程保留：`packages/persistence-sqlite/src/sqlite-governed-deletion.ts:791-807`（`objectType === "run"` 只 `DELETE FROM runs WHERE id = ?`，没有删 thread），`sqlite-governed-deletion.ts:843-845`（删 task 时按 `run_id` 删 runs，未删 thread）。
  - `egressRunScoped: true` 只出现在 `apps/agent-service/src/production-model-composition.ts:335`，而该 transport 的 model 只在 `apps/agent-service/src/service-main.ts:799` 交给自动复核（`production-model-composition.ts:333` 也写明 `purpose: "action-review"`），所以确实是“真实 run 的后台调用”。
- **建议**：不要用 run 存在性代替 thread 存在性。动作复核路径在上报时就应携带真实的 `threadId`（`AutomaticReviewRequest`/调用方若能提供），或在 `runs` 行仍能查到时就解析；只有在拿不到任何 thread 归属且 run 也不存在时才丢弃。至少给“run 单独删除、thread 仍存在”的用例。

---

### 已核对、未发现会出错的点

- **`record` 的其余分支**：`threadId` 非空时仍走 `threadExists`；`runId` 为空/`threadId` 非空时行为与之前一致（`sqlite-sensitive-interception-operations.ts:138-153`）。
- **`sentBodyValues` 的窗口过滤**：`start`/`end` 是 UTF-16 offset，`pointAt` 用 `for (const point of located.text)` 累计 `point.length`，单位一致；`pointAt(start) < head || pointAt(end) > length - tail` 与 `windowMailBody` 的保留区间一致（`proactive-mail-check-service.ts:191-214`，`proactive-mail-body.ts:10-32`）。未发现边界错误。
- **`mailBodyWindow` 抽取**：与 `windowMailBody` 使用同一 `HEAD_SHARE` 和 marker 长度，未见行为变化（`proactive-mail-body.ts:10-31`）。
- **`egressRunScoped` 的开关方向**：`PiModelTransport` 只有打开时才把 `request.runId` 拼进 egress context，未打开时原样传 context（`pi-model-transport.ts:284-288`）；测试同时断言了两条分支（`packages/runtime-pi/test/pi-model-transport.unit.test.ts:512-522`）。对模型请求字节无影响。
- **“去重键迁移”不成立的理由**：`sensitive_interceptions` 表确实是本 PR 新增的 `0078_sensitive_interceptions.sql`，仓库内没有更早的同名迁移（`packages/persistence-sqlite/src/migrations/0078_sensitive_interceptions.sql:1`，`migration-engine.ts:621`）。“是否已上线”属部署事实，**未核实**。
- **“清除迟到上报”不成立的理由**：`clear` 前会调用 `beforeRead`（即 `flushSensitiveInterceptions`），见 `production-sensitive-interceptions-control.ts:94-96`、`service-main.ts` 的 `beforeRead: () => flushSensitiveInterceptions(repository)`。理论上仍有“flush 之后、clear 之前/并发入队”的窄竞态，但那是极小窗口，不构成作者说法错误。
- **“第 5 条 try 缺测试”不成立的理由**：`#reportMasked` 自身包在 try/catch 里（`proactive-mail-check-service.ts:375-389`）；且提示词组装 `proactivePrompt`/`masked(item.body)` 在 `#reportMasked` 之前执行（同文件 514-530），能让扫描抛错的输入会先让提示词组装抛错。该理由成立。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？发给模型的内容是否仍只在末尾追加、每轮变化的值是否都在最后一条消息里？

**不会。** 本轮改动对模型内容没有影响：
- `locateMaskedValues` 只在 `#reportMasked` 里用于“上报”，实际发给模型的正文仍由 `maskSensitiveText`/`redactForEgress(input).text` 生成，`locateMaskedValues` 还额外校验重建正文与 `redactForEgress(input).text` 逐字相同（`redaction.ts:397`）。
- `egressRunScoped` 只影响 egress 上报 context，不进入请求体（`pi-model-transport.ts:284-288`，`model-egress.ts` 里 `report` 只读不写请求）。
- 仍有覆盖请求前缀的自动检查：`packages/runtime-pi/test/prompt-prefix.compat.test.ts:447-477` 的新用例断言“带记录与不带记录发出的 bodies 相同”，并断言每轮上报 context 一致；同文件原有 `[I-66]` 用例继续逐字节比较相邻请求的 `messages`。
- 关于“每轮会变的值只在最后一条消息里”：本轮没有新增进入提示词的值；`proactivePrompt` 的 `now/timeZone/today` 仍放在最后的 `MAIL_JUDGMENT_NOW` 段（`proactive-mail-check-service.ts:264-270`），未被本轮改动。更全面的前缀结论有测试保障，我未逐条重读整套系统提示/工具定义，**这一层未完全核实**。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**本轮的这两处改动不会。**
- 实际发送文本的遮盖路径没变；`locateMaskedValues` 的 `spanTag` 是纯函数、按 mask 顺序递增，只用于内部定位，不进入请求体（`redaction.ts:331-339`、`365-377`）。
- 邮件截断由 `mailBodyWindow` 依长度确定计算，无时间/随机量（`proactive-mail-body.ts:10-18`）。
- `reportMasked` 的指纹用 HMAC，同一值稳定（`model-egress.ts:484-505`）。
- 但需要区分：**同样的原文在不同请求里的“上报配对”**（不是发给模型的字节）可能因上面的机器密钥配对 bug 而不同，这属于记录错误，不是提示词字节变化。

### 3. 改动有没有对应的自动检查？反向用例是否真的会失败？

- **有检查**：
  - `locateMaskedValues` 的正向与“已有占位符时返回 null”用例：`packages/sensitive-capture/test/redaction.unit.test.ts:242-263`。
  - 邮件“按遮盖后的位置决定是否上报”的用例：`test/integration/proactive-mail-check.test.ts:504-523`（SI-3），期望被丢到中间的值不报、留在头部的值报。
  - run 存在性丢弃用例：`test/integration/sensitive-interceptions.test.ts:218-240`。
  - `egressRunScoped` 两分支：`packages/runtime-pi/test/pi-model-transport.unit.test.ts:512-522`。
- **反向力评估**：
  - SI-3 有反向力（读代码可推：撤回修复改用“原文先截断再扫描”时，15 张卡会把 `shiftpass99` 推到开头 70% 之外，`reported` 将不含它而失败）。
  - `locateMaskedValues` 的“已有 `[密钥]` 返回 null”是真正的反向用例。
  - **缺口**：没有“同一机器密钥一次被前置规则吞掉、一次独立出现”的配对用例，所以本报告问题一不会被现有测试发现；也没有“run 单独删除但 thread 仍存在”的用例，问题二同样无覆盖。
  - `reportMasked` 的 try/catch 失败路径在 `model-egress.unit.test.ts` 有“report 抛错不影响发送字节”的用例（`model-egress.unit.test.ts` 新增的 `reporting(true)` 用例），但 `#reportMasked` 自身的异常吞掉路径没有直接用例；按作者理由，该场景会先被提示词组装覆盖，可接受。

---

## 读代码证实 vs 推测

- **读代码证实的**：`machinePositions` 的回查/排序方式、最终校验只比正文；`record` 的 `run === undefined` 丢弃逻辑；`runs` 可被单独删除而 `threads` 保留的删除路径；`egressRunScoped` 只在动作复核 transport 打开；`windowMailBody`/`sentBodyValues` 的边界公式一致；测试位置与断言内容；`0078` 为本 PR 新表；`clear` 前会 flush。
- **推测（未实际运行）**：问题一的具体错配输入能否在真实邮件中出现、以及问题二“run 单独删除发生在记录落库前”的实际触发频率；测试撤回修复后“必定失败”我只做了逻辑推导，没有运行（工具限制），标为未运行验证。
- **未核实**：是否已上线；`runs` 是否有独立保留期清理（我只看到显式删除路径）；系统提示/工具定义的完整前缀链路我只依据现有 `prompt-prefix` 测试，未逐文件重审。
