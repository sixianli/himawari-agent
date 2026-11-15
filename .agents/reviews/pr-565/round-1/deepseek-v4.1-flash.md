未发现阻断性、安全性或模型请求方面的问题。改动本身是把已有的选择器搬进测试清单，选择器字符串逐字一致；只有一条低严重度的可维护性问题：新清单项没有被任何自动检查验证其值，未来 `UI.turn` 变化时会静默失配。

### 1（低）`settledTurn` 复制了 `UI.turn` 的前缀字面量，清单漂移时 `npm run check` 发现不了

- 文件:行：`apps/control-center/test/release-walkthrough-ui.ts:31-32`、`test/integration/product-path-browser.test.ts:6028`、`apps/control-center/test/release-walkthrough.unit.test.ts:405-407`
- 问题：新值把 `.chat-turn` 又写了一遍，而不是从 `turn` 派生。若以后界面类名改了、`UI.turn` 跟着改而 `settledTurn` 忘改，`npm run check` 里没有任何一步会失败：单元测试只用 `UI.turn` 查轮次，定位清单测试只检查“`locator(` 后面不是字面量”，`settledTurn` 在单元测试里一次也没被使用。只有真实浏览器发布验收才会暴露，而它在默认 `check` 中被跳过（`product-path-browser.test.ts:54-55` 的 `productDescribe` 需 `HIMAWARI_PRODUCT_PATH_E2E=1`）。这正是 I-08 记录的“界面改了，走查没跟到、出包才失败”的形态。
- 证据（读代码证实的）：
  ```ts
  // release-walkthrough-ui.ts:31-32
    turn: ".chat-turn",
    settledTurn: ".chat-turn:not(.chat-turn-outgoing)",
  ```
  ```ts
  // product-path-browser.test.ts:6028
          const sentTurn = phone.locator(UI.settledTurn).filter({ hasText: text }).last();
  ```
  ```ts
  // release-walkthrough-locators.test.mjs:30-34
      for (const part of parts) {
        expect(part).not.toMatch(/getByRole\(/);
        expect(part).not.toMatch(/locator\(\s*["'`]/);
        expect(part).not.toMatch(/getByText\(\s*["'`][^"'`]*["'`]\s*\)/);
      }
  ```
  ```ts
  // release-walkthrough.unit.test.ts:405-407
      const turns = body.querySelectorAll(UI.turn);
      expect(turns.length).toBeGreaterThan(0);
      const turn = turns[turns.length - 1] as HTMLElement;
  ```
  全仓 `settledTurn` 只有上述产生处和一处使用处，单元测试没有引用它。另：`chat-turn-outgoing` 这个类名本身有 `thread-interactions.unit.test.ts:2068` 等用例在查，缺的是 `UI.turn` 与 `settledTurn` 之间的派生关系。
- 推测：只有将来有人修改 `UI.turn` 时才会触发；当前提交不会造成任何行为差异。
- 建议：在清单里先定义共享常量再拼接（必要时用 `as const` 保持字面量类型），或在 `release-walkthrough.unit.test.ts` 加一条断言，例如 `expect(UI.settledTurn).toBe(\`${UI.turn}:not(.chat-turn-outgoing)\`)`，让漂移在 `npm run check` 里就失败。若认为发布验收已足够，也可明确记录这是有意的取舍。

**核对作者说法（读代码证实的）**

- “改后选择器字符串与原来逐字相同，行为不变”：属实。原式 `${UI.turn}:not(.chat-turn-outgoing)` 展开即 `.chat-turn:not(.chat-turn-outgoing)`，新值逐字相同；`chat-history.tsx:190` 的提交轮是 `chat-turn`，`:350` 的乐观发送轮是 `chat-turn chat-turn-outgoing`，选中集合不变。
- “`release-walkthrough.unit.test.ts` 不需要新增断言：它不逐项遍历 UI 清单”：前半句事实正确（该文件只按具体键取用，未出现 `Object.keys/entries`），但“因此不需要”不等于“新项已被验证”；新项确实没有任何自动检查验证其值，见意见 1。
- “这个改动不涉及发给模型的请求”：属实。改动只在 `apps/control-center/test/` 和 `test/integration/`，`RELEASE_WALKTHROUGH_UI` 全仓只被测试文件导入，没有产品代码引用。
- 旧代码确实会被定位清单门槛拦下：`phone.locator(\`...\`)` 中 `locator(` 后紧跟反引号，命中 `release-walkthrough-locators.test.mjs:32` 的 `/locator\(\s*["'`]/`。
- `check:release-walkthrough` 确实包含定位清单测试：`package.json:76` 同时跑 `release-walkthrough.unit.test.ts`、`release-walkthrough-locators.test.mjs`、`release-walkthrough-coverage.test.mjs`。

**未核实**

- 作者声称“`npm run check` 56 步全过”“去掉修改时定位测试失败、加上后通过”：本环境不能运行测试，未实际验证；只按代码静态核对。
- `.agents/reviews/pr-565/briefs/brief-round1.md` 在 diff 中显示为二进制（`Binary files ... differ`），且本环境的 `git show` 对该路径返回拒绝读取；其内容未核实，不影响上述代码结论。

**侧重检查**

- 错误路径：改动不新增运行时错误分支；`sentTurn` 找不到时仍是原有 `toBeVisible` 超时（120 秒），与改前一致。
- 不合规范/不可信输入：新值来自测试常量，测试文本也是常量，没有外部输入进入选择器。
- 安全：只改测试定位，不涉及凭据、网络请求、权限或生产数据。
- 资源耗尽：没有新增循环、轮询或超时；等待上限未变。
- 不可撤销操作：无写入、删除、迁移或发布动作。
- 规则/文档一致性：`docs/incidents-and-gates.md` I-08、ADR 0107 要求走查定位只从 `release-walkthrough-ui.ts` 取，本改动符合；未发现文档要求每个清单项必须被单元测试逐项覆盖，因此意见 1 是加固建议而非违规。

**必答问题**

1. 不会。本改动没有改任何系统提示、工具定义、历史消息、遮盖或序列化代码；`RELEASE_WALKTHROUGH_UI` 只被测试导入。发给模型的内容仍然只在末尾追加，本次改动也没有把会变的值放进请求开头。依据 `prompt-prefix.md` 第二节第 4 条、第四节第 10 条。
2. 不会。`settledTurn` 是固定的常量字符串，测试发送文本也是常量；没有依赖前后文的遮盖、时间字段或无序集合，同一段文字每次是相同字节。
3. 有对应的定位清单门槛，且反向用例成立：恢复旧写法会被 `release-walkthrough-locators.test.mjs:32` 的正则命中而失败（静态核对）。但新清单项的值本身没有自动检查：`npm run check` 不验证它与真实 DOM 的一致性，只有默认跳过的真实浏览器验收会验证，见意见 1。
4. 逐个核对通过：产生处 `release-walkthrough-ui.ts:32` 是字符串，满足 `satisfies` 的 `string` 分支；使用处 `product-path-browser.test.ts:6028` 的 Playwright `.locator()` 接受字符串；`target()` 只接受 `WalkthroughTarget`，此处没有误用；定位清单正则允许 `locator(UI.settledTurn)`；没有后端校验、序列化或其他枚举清单的消费者。唯一的“两端不一致风险”是产生处复制了 `turn` 的前缀而没有派生关系，已列为意见 1。

结论：改动可以合并；当前行为正确，建议后续补一条 `UI.turn` 与 `settledTurn` 的派生或断言，避免 I-08 式漂移。
