我只读了代码和 `git diff/show/log`，没有运行测试；下面关于“测试会不会失败”的判断来自核对测试代码与实现路径，不是执行结果。

## 读代码证实的问题（按严重度）

### 中：新增的 OpenDesign 没有被自检或自动测试真正碰到，文档推荐的验证步骤会误报通过

- 文件:行：`scripts/model-review/opencode-review.mjs:2021-2027`、`scripts/model-review/opencode-review.mjs:1712-1720`、`scripts/model-review/opencode-review.mjs:2708`、`.agents/instructions/model-review.md:124`
- 问题：`--self-check-only --gateway magpie` 虽然读入真实 `gateway.json`，但自检启动 Magpie 时把服务方和成员换成了本机假服务方 `probe`；随后在 `if (options.selfCheckOnly) return;` 处直接返回，根本不会走真实配置的 `startLiveGateway` 预检。也就是说，新增 `opendesign` 的 URL、模型名、密钥占位符、真实 `/v1/models` 都没有被自检验证。
- 证据：
  ```js
  // opencode-review.mjs:2021-2027
  if (gateway)
    live = await probeGateway({
      gateway,
      root: join(workRoot, "gateway-probe"),
      upstreams: [probeUpstream("probe", port)],
      members: probeMembers("probe"),
    });
  ```
  ```js
  // opencode-review.mjs:1712-1720
  const live = await startGateway({
    install: gateway.install,
    config: gateway.config,
    root,
    models: Object.keys(members),
    providers: upstreams,
    members,
  });
  ```
  ```js
  // opencode-review.mjs:2708
  if (options.selfCheckOnly) return;
  ```
  文档却写着：
  > `.agents/instructions/model-review.md:124`：改完跑 `--self-check-only --gateway magpie` 和 `test/tooling/review-gateway.test.mjs`，按代码复核流程合并。
- 建议：增加一个不花钱的真实服务方探针：用真实 `providers`/`members` 启动 Magpie，只查 `/v1/models`，确认每个成员都在；或至少把 `opendesign` 的 URL 和模型清单做成可注入的测试，并加一条“模型名不匹配必须失败”的反向用例。否则以后改 `opendesign` 的模型名，自检仍会 `SELF_CHECK_OK`，第一次真实复核才报错。

### 中：文档仍按“两家服务方”描述，与三家代码不一致

- 文件:行：`.agents/instructions/model-review.md:126`、`.agents/instructions/model-review.md:129`、`.agents/instructions/model-review.md:121`、`docs/adr/0178-review-model-calls-through-a-local-magpie.md:54`、`docs/adr/0178-review-model-calls-through-a-local-magpie.md:102`
- 问题：代码已经是 CodeBuddy → OpenDesign → Go，但操作说明仍写着“退回只用 Go”，凭证清单也漏了 OpenDesign 的主机。
- 证据：
  - `.agents/instructions/model-review.md:129`：
    > 剩余减去预留低于 20，或查不到，就这次不用 CodeBuddy、只走 Go……带着 CodeBuddy 启动 Magpie 失败时，同样退回只用 Go……只用 Go 也启动失败，才以 `GATEWAY_PREFLIGHT_FAILED` 停下。
    但代码只丢掉 `creditProvider`，组里仍有 OpenDesign：
    ```js
    // opencode-review.mjs:2558
    let drop = uid ? [] : [config.creditProvider];
    // opencode-review.mjs:2590
    live.addGroups(drop);
    ```
    `groupArgs` 只过滤被丢掉的服务方：
    ```js
    // gateway.mjs:331-333
    const list = (members ?? entry.members).filter(
      (member) => !dropProviders.includes(member.split("/")[0]),
    );
    ```
    `gateway.json:20-24` 的成员仍是 `workbuddy-ai/...`、`opendesign/...`、`opencode-go/...`，所以去掉 CodeBuddy 后先走 OpenDesign，不是“只走 Go”。
  - `.agents/instructions/model-review.md:126` 只列了 `www.workbuddy.ai` 和 `opencode.ai` 两条网络密钥，新增的 `amr-link.open-design.ai` 没列；撤销或轮换 OpenDesign 凭证时按这段文字会漏掉。
  - `.agents/instructions/model-review.md:121` 仍说“新增或调整服务方只改这个文件”，但下一段 `:122-123` 已改成“两步：网络密钥 + `gateway.json`”。
  - `docs/adr/0178...:54` 仍写“CodeBuddy 在前、Go 在后”；`:102` 仍写“新增服务方只改 `gateway.json`”。PR 只在“后续”里加了 OpenDesign，正文没有同步。
- 建议：把 `:126`、`:129`、`:121` 和 ADR 正文统一成三家服务方；明确“去掉 CodeBuddy 后先 OpenDesign、再 Go”；补上 `amr-link.open-design.ai` 网络密钥；把“只改 gateway.json”改成“网络密钥 + gateway.json 两项”。

### 中：自定义服务方的 `models` 清单没有和路由成员交叉校验，配置错误会拖到第一次真实请求才暴露

- 文件:行：`scripts/model-review/gateway.mjs:101-105`、`scripts/model-review/gateway.mjs:117-128`、`scripts/model-review/gateway.mjs:628-640`、`scripts/model-review/opencode-review.mjs:2594-2600`
- 问题：`kind: "custom"` 只检查 `url` 是字符串、`models` 是数组；没有检查数组元素是否非空字符串，也没有检查 `members` 里的 `opendesign/<模型名>` 是否真的在 `provider.models` 里。成员校验只检查服务方 id：
  ```js
  // gateway.mjs:121-127
  members.some(
    (member) =>
      typeof member !== "string" ||
      !ids.includes(member.split("/")[0]) ||
      !member.includes("/"),
  )
  ```
  真正把这些值交给 Magpie 的地方是：
  ```js
  // gateway.mjs:636-637
  "key=probe",
  `models=${provider.models.join(",")}`,
  ```
  开跑前预检只看 Magpie 的 `/models`：
  ```js
  // opencode-review.mjs:2594-2598
  const missing = models.flatMap((model) =>
    config.models[model].members.filter(
      (member) => !drop.includes(member.split("/")[0]) && !ids.has(member),
    ),
  );
  ```
  对 custom 服务方，这个 `/models` 很可能就是 Magpie 按同一份 `provider.models` 生成的，属于自己校验自己；仓库里没有代码去查 `amr-link.open-design.ai/v1/models`。因此 `models: []`、模型名拼错、成员写了未注册的模型名，都可能通过 `GATEWAY_CONFIG_INVALID` 和自检，最后在真实复核时才失败。这正是 I-73 提醒的“清单里的 id 能不能过后端校验”。
- 建议：在 `gatewayConfigProblems` 里校验每个 `models` 元素是非空字符串，并要求 custom 服务方的每个成员 `<id>/<model>` 的 `<model>` 出现在 `provider.models` 中；加一条“成员模型名不在 provider.models 时必须报 `GATEWAY_CONFIG_INVALID`”的反向用例。真实上游 `/models` 的校验应放进不花钱的预检探针。

### 低中：测试隔离只在显式使用 workspace 配置时成立，直接跑 vitest 会继承云端环境变量

- 文件:行：`vitest.workspace.ts:6-14`、`vitest.workspace.ts:47`、`test/tooling/opencode-review.test.mjs:1033-1057`
- 问题：`HIMAWARI_REVIEW_GATEWAY: ""` 只加在 `project.id === "tooling"` 的 `env` 里；如果不用 `--config vitest.workspace.ts` 跑（例如 `npx vitest run test/tooling/opencode-review.test.mjs`），这个覆盖不生效。`opencode-review.test.mjs` 的真实自检又是不带 `--gateway`、直接继承 `process.env`：
  ```js
  // test/tooling/opencode-review.test.mjs:1039-1057
  spawnSync(process.execPath, [
    "scripts/model-review/opencode-review.mjs",
    "--self-check-only",
    ...
  ], {
    env: { ...process.env, GITHUB_TOKEN: secret, AWS_SECRET_ACCESS_KEY: secret },
  })
  ```
  在云端 `HIMAWARI_REVIEW_GATEWAY=magpie` 时，这条用例会改成走 Magpie，不再测试它名字所说的“直连 + 环境里有密钥”的路径，还可能因为 Magpie 未安装或网络失败而失败。作者说的“用 workspace 配置跑时子进程读到空”是对的，但“测试结果不受云端环境影响”只在 workspace 路径下成立。
- 建议：在这条 spawn 的 `env` 里显式写 `HIMAWARI_REVIEW_GATEWAY: ""`，或改用全局 setup/测试文件清空；再加一条用例：设置 `HIMAWARI_REVIEW_GATEWAY=magpie` 后 spawn，断言仍走预期分支。

### 低中：固定顺序和 `routing=order`、`stays=session` 的测试是同义反复

- 文件:行：`test/tooling/review-gateway.test.mjs:154-164`
- 问题：DeepSeek 的组测试用 `config.models[deepseek].members.join(",")` 和 `config.routing`、`config.stays` 作为期望值，等于拿配置和配置自己比。把成员顺序改成 OpenDesign → CodeBuddy → Go，或把 `routing` 改成 `smart`，这些断言仍然通过。唯一带字面量的是“去掉 CodeBuddy 后是 OpenDesign → Go”，它只能证明 OpenDesign 在 Go 前面，不能证明 CodeBuddy 在 OpenDesign 前面。
- 证据：
  ```js
  // test/tooling/review-gateway.test.mjs:154-161
  expect(groupArgs(config, deepseek)).toEqual([
    "group",
    "add",
    "review-deepseek-v4.1-flash",
    `models=${config.models[deepseek].members.join(",")}`,
    "routing=order",
    "stays=session",
  ]);
  ```
  但 `routing=order` 和 `stays=session` 也是直接用 `config.routing`、`config.stays` 生成的（`gateway.mjs:340-341`），所以测试没有验证配置里真的是这两个值。
- 建议：直接断言字面量成员数组和字面量 `routing=order`、`stays=session`；再加三条：不去掉任何服务方时期望 CodeBuddy 第一、去掉 CodeBuddy 后 OpenDesign 第一、去掉 CodeBuddy 和 OpenDesign 后 Go 第一。

### 低：`main` 读环境变量这条接线没有自动测试

- 文件:行：`scripts/model-review/opencode-review.mjs:2610-2613`、`test/tooling/review-gateway.test.mjs:137-146`
- 问题：测试只验证了 `parseArgs(base, { defaultGateway: "magpie" })`，没有验证 `main()` 真的把 `process.env.HIMAWARI_REVIEW_GATEWAY` 传进去。如果以后有人删掉 `defaultGateway: process.env...`，现有测试不会失败。
- 建议：把“命令行/环境变量/默认值”的决策抽成可测试的函数，或加一条 spawn 用例：设置 `HIMAWARI_REVIEW_GATEWAY=magpie`，用能走到网关选择但不会花钱的路径（例如自检加标记），断言出现 Magpie 启动或对应错误码。

### 低：文档说容器里只放 `proxy-injected`，自定义服务方代码用的是 `probe`

- 文件:行：`.agents/instructions/model-review.md:126`、`scripts/model-review/gateway.mjs:24`、`scripts/model-review/gateway.mjs:636`
- 问题：`PLACEHOLDER` 是 `"proxy-injected"`，preset 和 CodeBuddy 桌面登录文件都用它；custom 分支却写死 `key=probe`。两者都是假密钥，但文档的“容器里只放假凭证 `proxy-injected`”对 OpenDesign 不成立。如果出口代理是按占位符值匹配再替换，`probe` 还可能导致鉴权失败；作者的手工实测表明代理可能按主机替换，但仓库里没有证据。
- 建议：custom 分支改用 `PLACEHOLDER`，或把文档改成“custom 服务方使用 `probe`，preset/插件使用 `proxy-injected`”，并在云端实测一次。

### 低/风险：开跑前预检把第三个上游变成硬依赖

- 文件:行：`scripts/model-review/opencode-review.mjs:2594-2600`、`scripts/model-review/gateway.json:20-24`
- 问题：预检要求本次要跑模型的每个成员都在 Magpie 的 `/models` 里；加入 OpenDesign 后，只要 OpenDesign 的模型清单暂时不可用，整次复核就 `GATEWAY_PREFLIGHT_FAILED`，即使 CodeBuddy 和 Go 都正常。这是文档写明的行为，不是新代码缺陷，但新增了一个可用性风险。
- 建议：如果希望“前一家用不了才换下一家”也适用于开跑阶段，可以在预检失败时只丢掉该服务方并重建组，而不是整次停下；如果坚持严格预检，应在文档里明确“OpenDesign 不可用会阻止整次复核”。

## 推测与未核实

- 云端环境 himawari-cloud 是否真的设置了 `HIMAWARI_REVIEW_GATEWAY=magpie`：仓库里没有证据，未核实。
- `https://amr-link.open-design.ai/v1` 是否真的提供 `deepseek-v4.1-flash`、`glm-5.3-flash`，是否支持复核需要的工具调用、流式输出和 usage 字段：作者说手工请求 200，但仓库里没有自动证据，未核实。
- 云端网络密钥里是否已为 `amr-link.open-design.ai` 配好 `Authorization: Bearer`，出口代理是否会替换 Magpie 发出的 `Bearer probe`：未核实。
- Magpie 的 `provider add ... models=...` 是否会在添加时查询上游 `/models` 并校验模型名：未核实。如果它不查，上面“预检是自校验”的问题就成立；如果它查，则模型名错误会在预检阶段失败，但仍不是本仓库的自动测试覆盖的。
- OpenDesign 的条款、数据保留和源代码外发风险：ADR 只写了 CodeBuddy 的条款风险，没有 OpenDesign 的；作者说 Andy 已开套餐并确认，但仓库里没有对应说明，未核实。
- 作者说 `npm run check` 41 步通过：这 41 步里没有 `test/tooling/review-gateway.test.mjs`（`package.json:27` 的 `check:steps` 没有对应步骤），该测试属于 tooling 项目，由 `npm test`/CI 的 tooling project 跑。因此 `npm run check` 不能作为新增网关测试已执行的证据；作者另说的“review-gateway.test.mjs 41 条通过”未独立核实。

## 侧重检查

- 错误路径：核对了 `parseArgs` 的 `--gateway` 值校验、环境变量非法值、`--gateway direct` 删除、`--report`/`--assert-reviewed` 提前返回、自检模式、真实预检失败和 Magpie 启动失败。结论：非法环境变量会报 `ARG_INVALID HIMAWARI_REVIEW_GATEWAY`；命令行优先；`direct` 等于关闭网关；子命令确实在应用默认值之前返回，不受环境变量影响。未发现错误路径上的逻辑错误。
- 不合规范/不可信输入：环境变量是外部输入，已白名单校验；`gateway.json` 是仓库内可信配置，但 custom 服务方的 `models` 元素和 URL 只做了很浅的校验，模型名与成员清单没有交叉校验。见上面的“中”级问题。
- 安全：仓库里没有真实密钥；OpenDesign 用假密钥 `probe`，CodeBuddy 桌面登录用 `proxy-injected`，符合“不放真密钥”。但新增了一个默认会把复核材料和源代码发给 `amr-link.open-design.ai` 的第三方服务方，文档没有写它的数据条款；这是新增的外发面。假密钥占位符与文档不一致，见“低”级问题。
- 资源耗尽：没有新增无界循环；`readStableUsage` 仍是有限次等待。新增风险是开跑前预检多依赖一个外部服务方，且 Magpie 默认化后会自动安装/执行 Magpie（锁文件有 SHA-256，已有完整性检查）。未发现新的资源耗尽缺陷。
- 不可撤销操作：本次改动没有新增删除、覆盖或不可逆写入；Magpie 安装/升级仍是原有逻辑。默认切到 Magpie 后，云端每次复核都可能自动下载并执行 Magpie，这是既有的、有摘要锁的操作，不是本 PR 新增的不可逆操作。
- 规则/文档/代码一致：发现多处不一致：`model-review.md:126` 漏 OpenDesign 网络密钥、`:129` 仍说“只走 Go”、`:121` 与 `:122-123` 自相矛盾；ADR 0178 正文 `:54`、`:102` 仍是两家服务方；`model-review.md:124` 推荐的自检并不能验证新服务方。作者“文档与代码一致”的说法不完全成立。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会因为本改动在“每轮”改变脚本生成的提示词。`buildPrompt`（`opencode-review.mjs:275-303`）不包含网关、服务方或模型名；每轮会变的 `head`、`base`、`previous`、`brief` 仍然只出现在末尾的“本次材料”里。网关只影响 `reviewConfig`/`launchModel`（`:115-146`、`:164-202`），即 OpenCode 使用的 provider/model ID。
   但有一个跨运行的变化：从直连切到 Magpie 后，OpenCode 自己写进系统消息的模型名会从 `opencode-go/deepseek-v4.1-flash` 变成 `magpie/group/review-deepseek-v4.1-flash`（测试 `asDirect` 正是为这个差异做的归一化，`opencode-review.mjs:1735-1758`）。这是一次性的、按运行固定的变化，不是每轮追加；每次复核本来就是新会话，规则第 6、8 条允许模型变化时换新。工具定义、历史消息、遮盖结果没有因本改动在轮次间变化；CodeBuddy 的 11128 改写仍是 ADR 0178 的受控例外。
   结论：脚本提示词仍然只在末尾追加；网关选择本身不会在同一个运行内引入每轮变化的值。

2. **会不会让同一段文字在不同请求里变成不同的字节？**
   不会因为本改动在模型请求里引入新的不确定性。`gateway.json` 的数组顺序固定，`groupArgs` 按 `members` 数组顺序生成（`gateway.mjs:328-343`），`reviewConfig` 按固定的 `REVIEW_MODELS` 顺序生成，`asDirect` 也是确定性的 split/join。
   唯一要注意的是账本的 `providers` 对象：`summarizeGatewayUsage` 按 Magpie 用量文件的行顺序插入键，`gatewayUsageLine` 再按 `Object.entries` 打印（`gateway.mjs:411-453`、`opencode-review.mjs:2505-2513`），所以不同运行的 `usage.jsonl` 或 `GATEWAY_USAGE` 文本键顺序可能不同。这不是发给模型的内容，不影响 KV 缓存；如果要求账本也逐字节稳定，可以按服务方 id 排序后再序列化。

3. **有没有对应的自动检查？反向用例真的会失败吗？**
   有，但不完整。`parseArgs` 的四个新断言是有效的反向用例：去掉默认值逻辑、去掉 `direct` 删除、去掉非法环境变量校验、把默认值应用提前到子命令返回之前，对应用例都会失败。`opendesign` 加入成员也有部分覆盖：`gatewayConfigProblems(config, REVIEW_MODELS)` 会因成员引用不存在的服务方而失败，`dropProviders` 的字面量断言会因删掉 OpenDesign 而失败。
   缺口是：没有测试 `main` 是否真的读取 `HIMAWARI_REVIEW_GATEWAY`；没有测试 workspace 的环境清空是否生效；没有字面量测试“CodeBuddy 第一”和 `routing=order`、`stays=session`；没有 custom 服务方 `models` 校验的反向用例；没有自检或测试真正启动 `opendesign` 或查询它的 `/models`。所以作者的手工实测覆盖了当前值，但不能替代自动门槛。

4. **每个新值的使用方都能接受吗？**
   仓库内的使用方都能接受，外部后端未核实：
   - `opendesign` id：`gateway.mjs:91` 的 id 正则接受；`gateway.mjs:124` 的成员检查接受；`gateway.mjs:412` 的 `known` 集合接受；`opencode-review.mjs:1401-1415` 的 `providersValid` 接受；`providerMoneyUsd` 会把它算进美元，`creditsPerUsd` 会把它排除。账本不会因这个 id 被拒。
   - `opendesign/deepseek-v4.1-flash`、`opendesign/glm-5.3-flash`：`groupArgs` 会原样拼进 `models=`；`startGateway` 的 custom 分支会把 `provider.models` 拼进 `provider add`；预检只查 Magpie 的 `/models`。仓库内两端名字一致，但没有和真实 OpenDesign `/v1/models` 的自动比对。
   - `url`：只在 `gateway.mjs:635` 作为 `url=` 传给 Magpie；没有 URL 格式校验，外部是否接受未核实。
   - `models` 数组：只在 `gateway.mjs:637` 拼接；元素没有逐项校验，也没有和 `members` 交叉校验，见上面的“中”级问题。
   - `HIMAWARI_REVIEW_GATEWAY`：只在 `opencode-review.mjs:2612` 读取；`parseArgs` 只接受 `magpie`/`direct`；`direct` 会被删除；子命令提前返回不受影响。仓库内一致。
   - `GATEWAY_CHOICES`：只在 `parseArgs` 使用；账本仍用 `GATEWAYS` 校验 `gateway` 字段，不会把 `direct` 写进账本，正确。
   - `routing`/`stays`：`groupArgs` 原样传给 Magpie；配置校验允许 `smart` 等其他值，测试没有锁定 `order`/`session`，见测试缺口。
   - `cost`：`reviewConfig` 和 `summarizeGatewayUsage` 都用它；OpenDesign 按 Go 单价记账，与作者说法和文档一致。
   - 外部后端：`amr-link.open-design.ai` 的真实模型名、工具/流式/usage 支持、网络密钥替换 `Bearer probe` 均未核实，只有作者手工实测的陈述。
