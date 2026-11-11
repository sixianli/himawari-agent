## 发现（按严重度从高到低）

### 低 | `test/fixtures/chromium-launch.ts:6-14` | 新增的共享函数没有自己的自动检查，三条反向路径都未被直接覆盖

问题：这个改动抽出了一个带分支的启动函数，但没有针对它本身的测试；现有七个测试只会走“默认启动成功”或“默认找不到后回退”这两条路，无法证明另外几条错误路径符合预期。

证据：`grep launchChromium` 只命中 7 个集成测试的 import/调用和 fixture 自身，没有任何 `*.test.ts` 直接测试它。

```ts
export async function launchChromium(chromium: BrowserType): Promise<Browser> {
  const configuredPath = process.env["HIMAWARI_CHROMIUM_PATH"] || undefined;
  try {
    return await chromium.launch(configuredPath ? { executablePath: configuredPath } : {});
  } catch (error) {
    const missing = error instanceof Error && error.message.includes("Executable doesn't exist");
    if (configuredPath || !missing || !existsSync(PREINSTALLED_CHROMIUM)) throw error;
    return chromium.launch({ executablePath: PREINSTALLED_CHROMIUM });
  }
}
```

至少以下反向用例应能失败并锁定行为：①显式配置了 `HIMAWARI_CHROMIUM_PATH` 时，即使错误是“找不到浏览器”也不得回退；②错误不是“找不到浏览器”时不得回退；③回退路径不存在时必须抛原错误。

建议：增加一个不启动真实浏览器的单元测试，用一个假的 `BrowserType` 记录 `launch` 调用次数和参数，并把回退路径存在性做成可注入参数或可覆盖的依赖，逐条断言上述分支。

### 低 | `test/fixtures/chromium-launch.ts:9,12` | 六个原有测试的选择优先级发生变化，不再是纯重构

问题：旧六个文件是“`/opt/pw-browsers/chromium` 存在就优先用它”，新实现是“先按默认路径启动，只有报找不到浏览器且 `/opt` 存在才回退”。因此如果本机默认 Playwright 缓存里已有 Chromium，测试将改用默认浏览器而不是 `/opt` 下的固定二进制；如果默认启动因缺库、权限等非“找不到浏览器”原因失败，而 `/opt` 明明可用，现在会直接抛错而不再尝试 `/opt`。

证据：旧代码（`dd49c411`，例如 `test/integration/decision-chain-browser.test.ts:78` 附近）：

```ts
const bundled = "/opt/pw-browsers/chromium";
const executablePath =
  process.env["HIMAWARI_CHROMIUM_PATH"] ?? (existsSync(bundled) ? bundled : undefined);
browser = await chromium.launch(executablePath ? { executablePath } : {});
```

新代码：

```ts
return await chromium.launch(configuredPath ? { executablePath: configuredPath } : {});
...
return chromium.launch({ executablePath: PREINSTALLED_CHROMIUM });
```

作者已在说明里点出这个变化，且容器里测试通过，所以严重度低。建议在 fixture 上方写清楚优先级，或确认 CI 的 `PLAYWRIGHT_BROWSERS_PATH` 始终指向预期的固定版本；如果测试可能在不同浏览器版本下结果不同，保留“`/opt` 优先”会更可复现。

### 低 | `test/fixtures/chromium-launch.ts:11-12` | 回退判断依赖 Playwright 的英文错误串，比较脆弱

问题：是否回退完全取决于 `error.message.includes("Executable doesn't exist")`。这是对第三方错误文案的隐式契约；文案变化或包装层改写消息时，回退会静默失效，测试会表现为直接失败。

证据：

```ts
const missing = error instanceof Error && error.message.includes("Executable doesn't exist");
if (configuredPath || !missing || !existsSync(PREINSTALLED_CHROMIUM)) throw error;
```

这是 PR 410（`2041c0cb`）已经选用的做法，本次只是推广到六个测试，因此不是新引入的高风险问题。建议至少用单元测试把这个字符串契约固定下来；如果 Playwright 提供可判定的错误码或更稳定的判定方式，优先使用。

## 侧重检查

- **错误路径**：读了 `test/fixtures/chromium-launch.ts:6-14`。显式配置时直接抛错；非“找不到浏览器”错误直接抛错；回退路径不存在时抛原错误；只有“未配置 + 找不到浏览器 + 回退路径存在”才重试一次。逻辑与 PR 410 的 `proactive-production` 原实现一致。
- **不可信/不合规输入**：唯一外部输入是环境变量 `HIMAWARI_CHROMIUM_PATH`，最终作为可执行文件路径交给 Chromium。该能力在改动前就存在，且只影响测试进程，不进入生产代码或模型请求；没有新增日志泄露或网络行为。
- **安全**：改动全部在 `test/` 下，未触及生产认证、序列化、遮盖或模型调用。`@playwright/test` 在 fixture 中是 `import type`，运行时会被擦除；`proactive-production` 仍从 `playwright` 导入实际的 `chromium`。
- **资源耗尽**：最坏情况是首次启动失败后再尝试一次回退，最多两次启动尝试；没有循环或无限重试。七个调用点都会在 `afterAll` 或 `closers` 中关闭浏览器（已逐一 grep 到 `browser?.close()` / `browser.close()`）。
- **不可撤销操作**：没有。仅启动/关闭测试浏览器。
- **规则、文档一致性**：`.claude/rules/prompt-prefix.md` 管的是模型请求开头，本改动不涉及模型请求，规则不适用。`docs/ui-ux-design-guide.md:249` 记录的同名环境变量语义仍兼容。另发现同一路径常量还硬编码在 `scripts/check-layout-audit.mjs:413` 和 `scripts/demo/record-email-decision.mjs:68`；本次目标只覆盖 `test/`，可接受，但 `/opt` 路径若变化仍需改三处。

## 读代码证实的 / 推测的

**读代码证实的：**

- diff 只涉及 8 个文件，全部在 `test/` 下；没有生产代码、提示词、工具定义或遮盖逻辑改动。
- 新 helper 与 PR 410 合并后的 `proactive-production` 启动逻辑等价；`2041c0cb` 的提交信息也确认“只在找不到浏览器时才回退”。
- 七个调用点都只使用返回的 `Browser`，并负责关闭；没有把新值写进任何序列化协议、配置清单或后端校验。
- 按 `it(` 计数：六个浏览器测试共 27 条，`proactive-production.test.ts` 16 条，合计 43 条，与作者“43 条测试”的数字一致。
- `@playwright/test` 与 `playwright` 在 `package-lock.json` 中都是 1.62.1（`@playwright/test` 依赖 `playwright` 1.62.1），因此 fixture 的 `BrowserType` 与 `proactive-production` 从 `playwright` 导入的 `chromium` 类型应结构兼容。

**推测或未核实：**

- 作者称容器里 43 条测试、lint、`tsc -p tsconfig.json` 通过；我没有运行权限，**未核实**实际结果。
- CI/容器是否设置了 `PLAYWRIGHT_BROWSERS_PATH`、默认浏览器缓存中是否存在另一份 Chromium，**未核实**；这决定“默认优先”是否真的会改变实际启动的版本。
- Playwright 未来版本是否仍使用 “Executable doesn't exist” 文案，**属于推测风险**；当前锁定 1.62.1，影响有限。

## 作者说法核对

- “只改 `test/` 下文件”：**正确**，`git diff --name-only` 8 个文件均在 `test/`。
- “行为与 PR 410 合并后的 proactive-production 用例一致”：**正确**，逻辑等价。
- “七个浏览器集成测试”：**基本正确**；严格说 `proactive-production.test.ts` 是集成测试，只有其中一个 `[PG-12]` 用例启动浏览器，不影响结论。
- “43 条测试”：**计数正确**；是否执行通过未核实。
- “此前六个文件是先判断存在再选路径，现在统一为先启动、找不到才回退”：**正确**，且这正是上面“低”严重度发现里的行为变化。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。改动只涉及 `test/` 下的浏览器启动辅助函数和七个测试的调用点；没有修改系统提示、工具定义、历史消息、遮盖结果或请求组装代码。发给模型的内容是否“只在末尾追加”不因本改动改变；这些测试本身也不向真实模型发请求（`proactive-production` 使用脚本化模型端口）。

2. **会不会让同一段文字在不同请求里变成不同字节？** 不会。这个改动不生成、序列化或遮盖任何发给模型的文本；唯一的环境相关差异是启动哪个 Chromium，不进入模型请求字节。

3. **有没有对应的自动检查，反向用例是否真的会失败？** 没有专门针对 `launchChromium` 的自动检查；现有七个集成测试只间接覆盖启动成功/回退的成功路径。显式配置不得回退、非“找不到浏览器”错误不得回退、回退路径不存在时抛原错误这三类反向用例目前没有测试，因此无法证明“改坏了会失败”。建议补单元测试。

4. **每个产生或修改的值，每个使用它的地方都能接受吗？** 能。
   - `PREINSTALLED_CHROMIUM`：只在 fixture 内使用，最终交给 `chromium.launch({ executablePath })`，该字段接受字符串路径；没有外部校验。
   - `HIMAWARI_CHROMIUM_PATH`：读取后在 `launch` 中使用，与旧代码语义一致；显式配置时错误直接抛出，使用端没有额外假设。
   - `launchChromium` 及其模块路径：七个调用点全部存在且路径层级正确；返回值统一按 `Browser` 使用，并在测试结束时关闭。
   - 没有新增标识、清单项、配置键、序列化格式或后端校验字段，因此 I-73 那种“清单 id 过不了后端校验”的两端不一致问题在这里不存在。

## 总体结论

未发现中、高严重度问题。改动确实实现了测试内去重，且与 PR 410 的行为一致；主要不足是共享函数缺少自身单元测试和反向用例，以及六个测试的浏览器选择优先级从“`/opt` 优先”变为“默认优先”这一已被作者披露的行为变化。
