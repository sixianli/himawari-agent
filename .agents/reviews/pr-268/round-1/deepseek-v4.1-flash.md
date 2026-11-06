## 一、读代码证实的问题（按严重度排序）

### 高 · 把 `￿` 从共享规则里排除，导致含 `￿` 的真实秘密不再被遮

- **文件:行**：`packages/sensitive-capture/src/machine-secrets.ts:25`、`packages/sensitive-capture/src/redaction.ts:63-64`
- **问题**：作者说排除填充字符是为了“任何规则都不会吞掉填充字符”，但这两条规则是**全局规则**，不只用于 trusted 视图。它们同时被 `redactMachineSecrets`、`scanMachineSecrets`、`assertMachineSecretFree`、`redactTracePayload` 等所有调用方使用。于是攻击者只要在真实秘密里插入一个 `￿`，就能绕过检测：
  - `密码：￿hunter22abc`：旧值类 `[^\s,，;；]+` 会把 `￿hunter22abc` 整个遮掉；新值类 `[^\s,，;；\uFFFF]+` 从 `￿` 开始就匹配失败，**整个密码原样发出**。
  - 私钥块里插入 `￿`：旧的 `[\s\S]*?` 会跨过它匹配；新的 `[^\uFFFF]*?` 不会匹配，`assertMachineSecretFree` 用的又是同一条被削弱的规则，因此也不会拒绝，**私钥原样发出**。
- **证据**：

  ```ts
  // packages/sensitive-capture/src/machine-secrets.ts:25
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[^\uFFFF]*?-----END ...

  // packages/sensitive-capture/src/redaction.ts:63-64
  /((?:密码|...)\s*(?:[:：=＝]|是|为|為|は)\s*)(?!\[)([^\s,，;；\uFFFF]+)/giu
  ```

  ```ts
  // packages/application/src/services/model-egress.ts:217
  assertMachineSecretFree(result.text);
  ```

  `assertMachineSecretFree` 内部调用的是 `scanMachineSecrets`，所以私钥里含 `￿` 时这里也不会拦住。`trustedSpans` 的 `input.includes(TRUSTED_FILLER)` 只让“清单失效”，并没有恢复规则的检测能力。
- **建议**：不要把 `￿` 从共享规则里移除。更安全的做法是：保留旧规则对原文的完整检测；只在 trusted 视图上使用专门的填充识别逻辑；如果某条规则吞掉了填充字符，应该抛 `EgressRedactionError`（fail closed），而不是放行。至少要补反向用例：`密码：￿secret`、含 `￿` 的私钥、`redactTracePayload` 对这类值的处理。

### 中 · trusted 替换会让“密码：”后紧跟固定文字时的密码规则失效

- **文件:行**：`packages/sensitive-capture/src/redaction.ts:172-227`、`packages/sensitive-capture/src/redaction.ts:270-275`
- **问题**：`redactForEgress` 先把 trusted 文字原地换成同长度的 `￿`，再跑密码规则。若密码值以 trusted 文字开头，密码规则看到的是 `密码：￿￿￿...`，值类无法匹配，结果**整段不遮**：

  ```ts
  // redaction.ts:209
  view += input.slice(cursor, start) + TRUSTED_FILLER.repeat(end - start);

  // redaction.ts:270
  text = text.replace(PASSWORD_ASSIGNMENT, (_match, lead, value) => {
    ...
  });
  ```

  新测试自己就固定了这个行为：

  ```ts
  // packages/sensitive-capture/test/trusted-text.unit.test.ts:69-70
  const password = `密码：${FIXED}`;
  expect(redactForEgress(password, { trusted: [FIXED] }).text).toBe(password);
  ```

  如果在固定文字后面紧贴一个真实密码，例如 `密码：${FIXED}hunter22abc`，旧实现至少会把 values 从 `密码：` 后开始的那一段当密码处理；新实现因为第一个字符是填充而完全不匹配。机制上已证实；“用当前目录里的哪段固定文字能实际构造出无分隔符的值”尚未逐一核实。
- **建议**：不要用“先把值替换成另一种字符再跑规则”的方式处理密码这种依赖值边界的规则。至少应让“与 trusted 区间相交”的密码匹配仍然被遮或拒绝，而不是跳过；更好的方案是范围化扫描：在原文上跑规则，只有完全落在 trusted 区间内的命中才丢弃，跨边界的命中按安全优先处理。

### 中 · 私钥块里含固定文字时不再遮，随后整个请求被 `assertMachineSecretFree` 拒绝

- **文件:行**：`packages/application/src/services/model-egress.ts:216-220`、`packages/sensitive-capture/src/machine-secrets.ts:25`
- **问题**：`redactForEgress` 在 trusted 视图里因为填充字符无法跨过私钥块，所以不遮；但换回原文后，`assertMachineSecretFree(result.text)` 又会看到完整的私钥块并拒绝请求。也就是说，原本“遮掉后发送”的路径变成了“拒绝发送”。新测试只验证了底层函数不抛错，没有验证生产路径：

  ```ts
  // packages/sensitive-capture/test/trusted-text.unit.test.ts:64-69
  const key = `${fence("BEGIN")}\n${FIXED}\n${fence("END")}`;
  expect(redactForEgress(key, { trusted: [FIXED] }).text).toBe(key);
  ```

  ```ts
  // model-egress.ts:216-220
  try {
    assertMachineSecretFree(result.text);
  } catch {
    refuse("sensitive material remained after redaction");
  }
  ```

- **建议**：明确策略并补生产路径测试：要么对“与 trusted 区间相交的机器秘密”仍遮掉，要么明确记录为拒绝；不能让测试只覆盖 `redactForEgress` 而漏掉 `ModelEgress` 的二次检查。

### 低 · 页面把“后台 user 消息”绑在硬编码 purpose 清单上；未知 purpose 仍显示“你的话”

- **文件:行**：`apps/control-center/src/components/sensitive-interceptions.tsx:99-115`、`apps/control-center/src/components/sensitive-interceptions.tsx:249-258`
- **问题**：`where()` 只根据 `purpose` 是否在页面自己的 `MESSAGE_PURPOSES` 里来判断要不要隐藏 `owner_message`：

  ```ts
  const part =
    item.purpose !== null &&
    item.purpose !== "chat" &&
    MESSAGE_PURPOSES.has(item.purpose) &&
    item.part === "owner_message"
      ? null
      : message(`sensitive.part.${item.part}` as MessageId);
  ```

  页面自己的清单是 `MODEL_USAGE_PURPOSES` 的复制品。当前两端一致，但没有任何自动一致性检查。以后后台新增一个 purpose、页面没有同步时，会静默落到 `其他 · 你的话`，正是 I-78 想修的现象。新测试甚至固定了这个行为：

  ```ts
  // apps/control-center/test/sensitive-interceptions.unit.test.ts:94-96
  item({ id: "4".repeat(64), source: "background", purpose: "something-new" }),
  ...
  expect(html).toContain("对话「家里网络设置」 · 其他 · 你的话");
  ```

- **建议**：按 `item.source` 判断后台来源（例如 `source === "background"` 或 `source === "memory_capture"`），不要依赖硬编码 purpose；或者从共享契约派生 purpose 清单并加两端一致性测试。若目标确实是“后台调用的 user 消息不再显示成你的话”，这个未知 purpose 用例应该改为不出现“你的话”。

### 低 · I-78 的门槛文档与实际脚本不一致

- **文件:行**：`docs/incidents-and-gates.md:116`、`package.json:44`
- **问题**：I-78 行写“挂在 `npm run check:prompt-catalog`”，但 `check:prompt-catalog` 只新增了 `apps/agent-service/test/trusted-prompt-egress.unit.test.ts`：

  ```json
  "check:prompt-catalog": "vitest run ... apps/agent-service/test/trusted-prompt-egress.unit.test.ts ..."
  ```

  `packages/sensitive-capture/test/trusted-text.unit.test.ts` 和 `apps/control-center/test/sensitive-interceptions.unit.test.ts` 都不在 `check:prompt-catalog`，也不在 `check:steps` 的命令串里；它们只会在更广的 `npm test` / CI test 项目里跑（具体由 `ci/policy.json` 和 `vitest.workspace.ts` 的 browser/unit 项目覆盖，未逐项核实执行命令）。另外，I-78 行引用的复现“对 `MEMORY_CAPTURE.text` 跑 `findSensitiveValues` 返回 `1000`”在修复后仍然成立，因为：

  ```ts
  // packages/sensitive-capture/src/redaction.ts:372-375
  export function findSensitiveValues(input: string): readonly EgressRedactionSighting[] {
    const found: EgressRedactionSighting[] = [];
    redactForEgress(input, { observe: (sighting) => found.push(sighting) });
    return Object.freeze(found);
  }
  ```

  它没有传 `trusted`，所以底层复现命令仍然返回 `1000`；真正被修的是 `ModelEgress` 路径。
- **建议**：把 `trusted-text.unit.test.ts` 加入 `check:prompt-catalog`（或 `check:egress-redaction`），把页面用例加入一个 `check:steps` 会跑的脚本；同时修正 I-78 行对复现命令和“挂在哪个 check”的描述。

## 二、推测 / 未核实

- **`trustedSpans` 的贪心重叠策略**：排序后按起点取、同起点取更长，这是确定的，但“一个更早开始、较短”的 trusted 文字会压掉“稍后开始、更长”的 trusted 文字。若目录里存在这种部分重叠的固定文字，较长文字的一部分会被当外来内容检查。未发现当前目录里有这种实际重叠，属推测。
- **性能/资源耗尽**：每条消息、每个字符串都会对整份清单做 `indexOf` 扫描；清单约 100+ 条且包含数 KB 的固定文字。没有用户可控的清单，未发现无界放大，但没有做基准测试，CPU 常数开销是否可接受未核实。
- **未来固定文字含机器秘密样式**：`assertMachineSecretFree` 在换回原文后仍会检查固定文字。当前目录没有 `Bearer`、`sk-`、私钥块等，所以没触发；但以后提示词里若出现示例密钥，所有含该提示词的请求都会被拒绝。属潜在问题。
- **`密码：${FIXED}secret` 的端到端可利用性**：机制已从代码和测试证实；能否用当前目录里的某段固定文字构造出“无空格、无逗号、无分号”的连续值，未逐一核实。

## 三、侧重检查

- **错误路径**：检查了 `EgressRedactionError` 的抛出与恢复逻辑、`ModelEgress` 的 `assertMachineSecretFree` 二次检查、`report` 抛错。发现私钥含 trusted 文字时从“遮后发送”变成“拒绝发送”。
- **不可信输入/绕过**：重点查了 `￿`、trusted 文字夹在关键词与值之间、私钥块跨 trusted 区间。`￿` 绕过是确定的；trusted 夹在密码关键词与值之间的失效机制也是确定的。
- **安全**：确认 `redactForEgress` 的 trusted 选项对 `messages`、`system`、`tool_result`、`embedding` 等所有经过 `ModelEgress` 的字符串生效，因此不可信内容中只要出现目录固定文字就可能影响相邻敏感值的识别。
- **资源耗尽**：只发现清单扫描的常数级 CPU 开销；没有发现新的无界队列、无界重试或用户可控清单增长。
- **不可撤销操作**：本 diff 没有新增不可撤销操作；页面“清除记录”的确认流程未改。
- **规则/文档/代码一致性**：`.claude/rules/prompt-prefix.md` 的新增说明与实现思路基本一致；`docs/kv-cache-guide.md` 第 11 条与实现一致；I-78 行“挂在 check:prompt-catalog”与实际脚本不一致（见上）。
- **改动值的产生端/使用端**：`trusted` 从 `ModelEgressOptions` 传到 `EgressRedactionOptions`，类型兼容；`packages/application` 已声明 `prompt-catalog` 依赖；`MACHINE_SECRET_RULE_IDS` 未变但规则语义对所有使用方都变了；页面 purpose 清单与 `MODEL_USAGE_PURPOSES` 当前一致但没有自动校验。

## 四、必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？

**结构上没有改变追加机制，也没有把每轮变化的值挪出最后一条消息。** 时间、运行时环境等仍然是 `last-user-message` 层，工具定义仍然由 `maskRequest` 跳过，顺序没有改。

**但字节层面，对已有对话不再是严格的“只在末尾追加”。** 因为 `trusted` 被传给 `messages` 里的每一条消息，不只是最后一条：

```ts
// packages/application/src/services/model-egress.ts:191-197
const text = (value: string, part: SensitiveInterceptionPart): string => {
  const result = redactForEgress(value, {
    ...
    trusted: this.#options.trusted ?? TRUSTED_PROMPT_TEXTS,
  });
```

所以：

- 已有对话中任何一条历史消息，只要包含目录里 ≥24 字符的固定文字，且旧代码曾把这部分误遮，重新发送时就会变成未遮的原文。这是**历史消息中段变化**，不是末尾追加。作者只提到“历史里贴过整段固定指令时变一次”，实际触发面更大：任何目录文字片段都可能触发。
- 系统提示也会经过同一层。以当前目录逐条搜索，`system`/`tools` 层没有发现会被旧规则误遮的数字；唯一的 `尾号1111` 例子本来就被 `尾号` 保护跳过，所以当前聊天系统提示大概率不变，但我没有对旧版本做逐字节对比，属未完全核实。
- 整理记忆后台请求的第一条 user 消息确实会从 `[验证码#…]` 变回 `1000`，这是作者已承认的一次缓存失效。
- 每轮变化的值仍在最后一条消息里；这一点没有因本次改动而改变。

### 2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？

**同一构建、同一整段输入下，确定性基本保持**：清单用 `Set` 去重、按长度和字典序排序；`trustedSpans` 按起点和长度排序；没有时间字段、随机数或无序集合。

**但新增了两个跨请求差异源：**

- **构建/目录版本**：清单来自当前提示词目录，目录一改，同一段历史消息可能被遮成不同字节。作者已在新规则和 I-78 中承认这一点。
- **`￿` 全局开关**：`trustedSpans` 只要发现输入任意位置含 `￿` 就返回 `[]`：

  ```ts
  // redaction.ts:178
  if (trusted.length === 0 || input.includes(TRUSTED_FILLER)) return [];
  ```

  因此同一段中间文字，可能因为同一字符串后面出现了一个 `￿` 而改成“按外来内容检查”。这仍然是确定于整条消息的，不是随机的，但满足不了“同一段文字在任何请求里都同字节”的最强解释。

- 原有的 `known` 前后文例外仍然存在，不是本次新增，但会让同一条消息依赖前面的消息。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

有，但不完整：

- `apps/agent-service/test/trusted-prompt-egress.unit.test.ts` 在 `npm run check:prompt-catalog` 中，且包含 `trusted: []` 的反向用例；把默认清单改成空时，第一条用 `createProductionModelEgress` 的用例会失败，这个反向门槛成立。
- `packages/sensitive-capture/test/trusted-text.unit.test.ts` 有反向性质的覆盖（空 trusted、输入含 `￿` 时不启用清单、清单顺序无关等），但**没有被 `check:prompt-catalog` 或 `check:steps` 明确包含**。
- `apps/control-center/test/sensitive-interceptions.unit.test.ts` 的 `[I-78]` 页面用例存在，旧页面代码确实会失败；但它同样不在 `check:prompt-catalog` 中，只在页面/浏览器测试项目里。
- **缺少的关键反向用例**：
  - `密码：￿secret`、私钥块内含 `￿`：应验证不漏遮。
  - `密码：${FIXED}secret`：应验证 trusted 夹在关键词和值之间时仍能遮或拒绝。
  - `ModelEgress` 对“私钥块内含 trusted 文字”的生产路径：现在只测了 `redactForEgress` 不抛错，没测随后会被 `assertMachineSecretFree` 拒绝。

### 4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？

逐项核对结果：

- **`trusted` 选项**：`ModelEgressOptions.trusted?: readonly string[]` → `EgressRedactionOptions.trusted?: readonly string[]`，类型一致；`ModelEgress` 的现有构造方都是可选参数，不传也能编译；`packages/application` 已声明 `@himawari-agent/prompt-catalog` 依赖。**两端可接受。**
- **`TRUSTED_PROMPT_TEXTS`**：由 `trustedPromptTexts` 从目录导出生成，类型为 `readonly string[]`；`ModelEgress` 默认使用，测试覆盖。**两端可接受。**
- **`TRUSTED_TEXT_MINIMUM_LENGTH`**：只在 `trustedPromptTexts` 和测试中使用，**两端可接受。**
- **`MACHINE_SECRET_RULE_IDS` 未变，但两个正则的语义变了**：所有使用 `redactMachineSecrets`/`scanMachineSecrets` 的地方（出口、trace 持久化、邮件/记忆扫描）都会接受同一类型，但**安全性语义变差**，尤其 `￿` 输入。这是最需要修的使用端影响。
- **页面 `purpose`/`part`/`threadId`**：产生端是 `MODEL_USAGE_PURPOSES` 和 `SENSITIVE_INTERCEPTION_PARTS`，消费端是页面的 `MESSAGE_PURPOSES` 和 `sensitive.part.*`。当前所有 purpose/part 都有对应 i18n 文案，测试覆盖了主要组合；但页面清单是复制品，缺自动一致性校验，新增 purpose 会静默落到 `其他 · 你的话`。
- **I-78 文档门槛**：文档写的是“挂在 `check:prompt-catalog`”，实际只挂了一个测试文件；`findSensitiveValues` 的复现命令仍返回 `1000`。这是文档/门槛两端的校验不一致。
- **低层 `redactForEgress` 的其他调用方**：`findSensitiveValues`、`credentialFindings`、`maskSensitiveText`、`locateMaskedValues` 都不传 `trusted`。它们处理的是邮件正文、记忆文本等外来内容，当前用法下可接受；但要注意，它们仍然会把提示词目录文字当敏感内容，I-78 里那条 `findSensitiveValues(MEMORY_CAPTURE.text) === 1000` 的复现依然成立。
