## 读代码证实的

### 高｜分类查询会把受限或敏感正文降级成 private 再发给模型
- 位置：`apps/agent-service/src/production-memory-control.ts:1004-1010`；`apps/agent-service/src/production-memory-classification.ts:200-205`；`production-memory-control.ts:230-237`
- 问题：`memory.classify.read` 对任意传入的 `contentRef` 只做 `readText`，不检查 `payload.dataClassification`；分类器又硬编码 `dataClassification: "private"`。于是同 owner/agent 的 sensitive 甚至 restricted 受保护正文，只要不是确定性检测命中的格式，就会被当作 private 内容送进模型。`#createMemory` 在 1069-1070 明确拒绝 restricted，分类路径没有同样的拒绝，两个入口的校验不一致。
- 证据：
  - `for (const ref of query.payload.contentRefs) texts.push(await this.readText(ref));`
  - `const result = await this.options.model.generate({ ... dataClassification: "private" });`
  - `readText` 只取 `payloads.get(ref)` 后直接 `unprotect`，没有分类判断。
- 建议：先取 `payload.dataClassification`，高于 `private`（或高于该模型 `allowedDataClassifications`）的条目不要发送模型，直接返回 `UNCLASSIFIED`（敏感、失败）；或者把实际最高级别一路传到 `generate`，让模型披露校验真正生效。并补反向用例：restricted/sensitive ref 不得进入模型 prompt。

### 高｜服务端“只升不降”只覆盖健康/财务和确定性检测，模型判出的其他敏感类别可被网页或客户端存成 private
- 位置：`apps/agent-service/src/production-memory-control.ts:1071-1076`
- 问题：是否升高只看 `sensitiveCategory(input.category)`（仅 health/finance）或 `deterministicallySensitive(text)`，完全不看 `input.topic`，也不服务端复核模型结论。一个客户端只要发 `category: "other"`、`payload: private`、`topic: "beliefs"/"intimacy"/"legal"/"location"/"third_party"`，服务端就会忽略 topic，把模型本应判敏感的内容存成 private。当前网页代码本身会正确报 sensitive，但服务端无法防“网页少报/被改过的客户端少报”，与“敏感级别只升不降”的约束不一致。
- 证据：
  - `const raised = classificationRank(payload.dataClassification) < classificationRank("sensitive") && (sensitiveCategory(input.category) || deterministicallySensitive(text));`
  - 新增集成测试也把这一行为固化了：`add("payload-bp-topic", "preference", "health", ...)`，期望结果是 `"t5-topic": { dataClassification: "private", topic: null, raised: false }`（`test/integration/production-memory-capture.test.ts:3383,3400`）。也就是说 `topic` 本身不会触发升高。
- 建议：至少把非空 `topic` 视为敏感信号并升高（或拒绝 private+topic）；更稳妥的是让 `memory.create`/`memory.import.commit` 使用服务端签发、绑定 `contentRef` 的分类结论，而不是信任网页传来的 category/topic。补 beliefs/intimacy/legal/location/third_party 的反向测试。

### 中｜每日额度不是硬上限：进程内计数、重启清零、与主动检查各算一份
- 位置：`apps/agent-service/src/production-memory-classification.ts:137-162`；`apps/agent-service/src/service-main.ts:1847`；`apps/agent-service/src/production-proactive.ts:207-210`
- 问题：分类器用 `#day/#spentMicros` 在内存里计数，重启或多副本各自从 0 开始；同时它拿的是主动检查的同一个 `dailyCostMicros`，但“单独计数”。因此分类调用和主动检查可以各自花掉一份上限，进程重启/多副本还能再多花。ADR 0260 已承认重启清零，但“总上限”并不成立。
- 证据：
  - `#day = ""; #spentMicros = 0;`
  - `if (this.#spentMicros + estimateMicros > this.#options.dailyLimitMicros) return false;`
  - `dailyLimitMicros: proactiveConfiguration.dailyCostMicros`
- 建议：若要让 `dailyCostMicros` 成为真实总上限，需要与主动检查共享同一计数或落库；不改表的前提下，至少在文档和界面把它标成“分类与主动检查各自的上限”，并接受重启/多副本的额外开销。当前行为与 ADR 描述一致，属于已知风险而非隐藏绕过。

### 中｜网页分类会在受保护内容里留下 private 级别的副本，且不会清理
- 位置：`apps/control-center/src/memory.ts:178-184, 287-290, 310-313`
- 问题：`classify` 为每条文字先 `protectText(text, classificationWithIdentifiers(text, "private"))`；随后 `create`/`importCommit` 再 `protectText` 一次。分类用的 private 副本不会删除。模型判为 sensitive 但确定性检测没命中的文字，因此会在 payload store 里留下一份 private 级别明文副本；重复解析/导入还会累积副本。ADR 0260 只提到“网页先存的那份普通级别内容仍在”，但这里的分类副本是新增的额外一份。
- 证据：
  - `client.protectText(text, classificationWithIdentifiers(text, "private"))`
  - `contentRef: await client.protectText(text, sensitive ? "sensitive" : classificationWithIdentifiers(text, "private"))`
- 建议：私有结果可以直接复用分类返回的 `contentRef`（快照里已有）；或给分类副本加可清理标记并在分类后删除；至少不要把模型判敏感的文字长期留在 private 级别。

### 中｜确定性检测覆盖不到所有证件号/密钥格式，分类器 prompt 仍可能包含
- 位置：`packages/sensitive-capture/src/identifiers.ts:3-7,10-18,30-35`；`production-memory-classification.ts:216-218`
- 问题：只有命中 `mentionsSensitiveMaterial`、`containsRestrictedIdentifier`（中国身份证、16-19 位数字）或 `containsCredential`（machine-secret/password/verification-code）的条目才不发给模型。护照号、SSN、部分 12/13 位证件或卡号、无标签的密钥等不在这些集合里，仍会进入分类器 prompt。测试只验证了 18 位中国身份证。模型传输层是否会再次出口遮盖这些格式，我没有读到对应证据，标“未核实”。
- 证据：
  - `const RESTRICTED_IDENTIFIER = /(?<![0-9])(?:[1-9][0-9]{5}(?:19|20)...|[0-9]{16,19})(?![0-9])/u;`
  - `if (deterministicallySensitive(text)) results[index] = DETERMINISTIC_SENSITIVE; else pending.push(...)`
- 建议：明确证件号和密钥的格式白名单并补测试；若依赖传输层出口遮盖，应在 ADR/测试里写明并验证真实请求体。

### 低｜`topic` 改为必填是破坏性契约变更，外部客户端无法确认都已更新
- 位置：`packages/gateway-contracts/src/contracts-v2.ts:1765,1794`；`packages/gateway-contracts/src/validation.ts:179-181`
- 问题：`object()` 对每个键都要求存在，缺 `topic` 会直接 `missing required field`。仓库内网页、fixture 和集成测试都已改到；但仓库里没有 iPhone 客户端代码，无法确认旧客户端是否会因缺少 `topic` 被拒。
- 证据：`if (!Object.hasOwn(record, key)) fail(`${path}.${key}`, "missing required field");`
- 建议：若还有仓库外客户端，把 `topic` 设为可选、缺省 null，或给契约做版本兼容；至少确认 iPhone 端已同步。

### 低｜新增 prompt 的清单来源写成 ADR 0249，实际应指向 ADR 0260
- 位置：`packages/prompt-catalog/prompt-manifest.json:563`
- 问题：`"changedIn": "ADR 0249"`，但 `memory.classification` 是 ADR 0260 新增的提示词；现有测试只校验 `changedIn` 非空，不会发现引用错了 ADR。
- 证据：`"memory.classification": { ... "changedIn": "ADR 0249", "reason": "新增..." }`
- 建议：改为 `ADR 0260`，并考虑让检查校验该 ADR 文件存在且包含该 prompt id。

### 低｜自动检查有，但关键反向路径没覆盖
- 位置：`apps/control-center/test/memory-interactions.unit.test.ts:265-278`；`apps/control-center/src/components/memory-page.tsx:2034`
- 问题：网页测试的 `memory.classify.read` mock 立即 resolves，因此“分类未完成时提交按钮禁用”没有任何测试会在去掉 `classifying` 条件时失败。服务端也缺“模型漏掉某个 id 必须按敏感”的直接用例，缺“beliefs/intimacy 等非健康财务敏感类别不能被少报”的反向用例。
- 证据：mock 直接返回 `payload.items`；提交按钮条件是 `disabled={memory.busy || classifying || !chosen.length || !source}`。
- 建议：用一个 deferred promise 让分类保持 pending，断言提交按钮禁用、复选禁用；补模型漏项、无 classifier、非健康财务敏感类别的反向测试。

## 推测/未核实

- 外部 iPhone 客户端是否发送 `memory.create`/`memory.import.commit`（缺 `topic` 是否会坏）——仓库里没有该代码，未核实。
- 分类器 prompt 中的护照号、SSN、部分密钥是否会被 `pi-model-transport` 的出口遮盖挡住——未核实；但分类器自己生成的 prompt 字节里确实包含这些文字。
- 多副本生产部署下额度实际会超多少——代码上确定是每进程独立计数，具体部署形态未核实。
- 新增 prompt 是否进入出口遮盖的“固定文字清单”从而影响遮盖——未找到 `sensitive-capture` 引用 prompt catalog 的证据，标未核实；对话请求路径本身没有被改动。

## 侧重检查

- 错误路径：确定性命中直接标敏感；批次失败、解析失败、模型漏项、每日额度失败、分类器未装配、读取失败、网页查询失败，均落到 `UNCLASSIFIED`（敏感、失败）或“默认不勾选”。这部分是 fail-closed，读代码成立。
- 不可信输入：模型输出只接受 `private|sensitive`、类别/ topic 白名单，未知类别归 other，非法 classification 丢弃，重复/未知 id 忽略；最多 500 refs。分类文本本身是可注入的自然语言，但输出被白名单限制，最坏是把某条判错，不是直接执行指令。
- 安全/分级：发现“受限/敏感正文按 private 送模型”和“非健康财务敏感类别可被少报”两个实际缺口；新增失败日志只写 code，没有写记忆原文。
- 资源耗尽：单查询最多 500 refs，每 ref 最大 64KB；批大小 6000 字，但单个超大条目不会被切开；额度能挡住大部分模型费用，但网页分类副本会累积存储。
- 不可撤销：敏感级别升高后 `#setCategory` 会锁定，符合“只升不降”；分类副本和 `memory-raised:` 副本没有网页侧删除入口。
- 规则/文档一致：ADR 0260 与代码主体一致；prompt manifest 的 `changedIn` 写错；敏感 topic/类别列表在 `application`、`gateway-contracts`、网页和分类器里各有一份，目前值相同但没有门禁保证永远同步。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。分类是独立的 background 调用（`packages/prompt-catalog/src/memory.ts:84-99` 的 `layer: "background"`），通过 `createRealEvalModel` 新起 prompt，不碰对话的系统提示、工具定义、历史或已有遮盖；新增的 `memory.classify.read` 只进入网页操作清单，不进入对话 prompt。新记忆生效后改变的是以后对话最后一条消息里的记忆块，属于既有“只追加”行为，不是请求开头。唯一未核实的是固定文字/出口遮盖清单是否因新增 prompt 间接变化，未找到关联代码。

2. **同一段文字会不会在不同请求里变成不同字节？** 分类 prompt 由固定文字加 `JSON.stringify({items})` 组成，items 顺序由输入顺序决定，没有时间、日期或无序集合；`memory-raised:sensitive:${contentRef}` 也是确定的。同样的输入在请求层会产生相同字节。模型输出本身不保证确定，因此同一段文字可能这次被判 private、下次被判 sensitive，进而影响存储级别；这是模型判断的非确定性，不是请求开头字节的不确定。

3. **有没有自动检查，反向用例真的会失败？** 有：新 prompt 有 manifest 校验和解析器契约测试，分类器有分批、额度、失败码不回显模型输出的单元测试，集成测试覆盖“证件号不进 prompt”“健康/证件升高为敏感”“解析失败按敏感”，网页测试覆盖默认改由服务端判断。但“分类未完成禁止提交”“模型漏项”“非健康财务敏感类别被少报”“缺 topic 的契约反向用例”没有覆盖；现有 mock 会让这些测试无法在回归时失败。

4. **每个新值两端都能接受吗？** 仓库内基本能：
   - `memory.classify.read` / `memory.classify.snapshot`：契约、fixture、服务端 query、网页调用一致。
   - `topic`：契约枚举、网页生产、服务端 `#createMemory`/`#importCommit` 消费一致；但仓库外客户端未核实，且服务端对 topic 只存不校验。
   - `classifying/ready/unclassified`：`memory-import.ts` 产生，`memory-page.tsx` 消费，三种语言的 `memory.page.importFlag` 都有对应分支。
   - `memory.page.autoCategory`：message id 和三种语言资源都已加。
   - prompt id `memory.classification`：catalog、manifest、parser 映射都在；manifest 的 `changedIn` 写错 ADR。
   - `MEMORY_SENSITIVE_TOPICS` 与 `SENSITIVE_MEMORY_TOPICS`、`SENSITIVE_CATEGORIES` 与 `MEMORY_SENSITIVE_CATEGORY_NAMES` 是重复清单，当前值一致，但没有自动检查防止以后分叉。
