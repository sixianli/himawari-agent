## 结论

未发现高、中严重度缺陷。改动把七个浏览器集成测试的选路径逻辑收敛到 `test/fixtures/chromium-launch.ts`，代码行为与作者描述的 PR 410 后逻辑一致；新增单测覆盖了主要分支和 4 条反向用例。以下是低严重度/信息级问题。

## 问题（按严重度从高到低）

### 低-1 单测用被测常量构造假错误，错误文案契约没有被独立验证

- 文件：`test/tooling/chromium-launch.test.ts:6,48,57`
- 问题：测试从被测模块导入 `MISSING_BROWSER_MESSAGE`，再用它拼出假 Playwright 错误。若有人把常量改成真实 Playwright 错误里不存在的字符串，6 条单测仍然全绿，而回退逻辑在真实环境会失效；这属于 I-73 那类“值只在两端之一被验证”的风险，只是发生在 test/ 下，严重度低。
- 证据：

```ts
// test/fixtures/chromium-launch.ts
5: export const MISSING_BROWSER_MESSAGE = "Executable doesn't exist";
15: const missing = error instanceof Error && error.message.includes(MISSING_BROWSER_MESSAGE);

// test/tooling/chromium-launch.test.ts
6: import { launchChromium, MISSING_BROWSER_MESSAGE } from "../fixtures/chromium-launch.ts";
48: new Error(`browserType.launch: ${MISSING_BROWSER_MESSAGE} at x`),
57: const fake = fakeChromium([new Error(MISSING_BROWSER_MESSAGE), null]);
```

- 建议：假错误改用固定字面量 `"Executable doesn't exist"`，并加一条 `expect(MISSING_BROWSER_MESSAGE).toBe("Executable doesn't exist")` 的契约断言；或保留一条用真实 Playwright 报错样本的用例。

### 低-2 `PREINSTALLED_CHROMIUM` 默认值本身没有被单测覆盖

- 文件：`test/fixtures/chromium-launch.ts:4,9`；`test/tooling/chromium-launch.test.ts:42,51,65,77`
- 问题：所有单测都显式传入临时 `preinstalled` 路径，默认值 `/opt/pw-browsers/chromium` 从未进入单测。若默认常量被改错，只有“默认浏览器缺失且容器存在 `/opt/pw-browsers/chromium`”的集成环境才会暴露；默认浏览器可用的环境里不会失败。
- 证据：

```ts
4: export const PREINSTALLED_CHROMIUM = "/opt/pw-browsers/chromium";
9:   preinstalledPath: string = PREINSTALLED_CHROMIUM,

42: expect(await launchChromium(fake.type, preinstalled)).toBe(fake.browser);
```

- 建议：加一条独立断言固定默认常量，或把默认路径改成可注入的 options，让单测能验证“未传第二参数时使用默认值”。

### 低-3 六个集成测试的浏览器选择语义确实变了，不只是抽函数

- 文件：`test/fixtures/chromium-launch.ts:11-17`
- 问题：旧逻辑是“`HIMAWARI_CHROMIUM_PATH` 未设置且预装路径存在时，直接使用预装路径”。新逻辑是“先尝试默认浏览器，只有错误文案像找不到浏览器且预装路径存在时才回退”。如果默认浏览器已安装但损坏，且错误不含 `"Executable doesn't exist"`（例如缺少共享库），旧逻辑会直接使用已知存在的预装路径，新逻辑不会回退，测试可能从通过变成失败。作者已提示这一行为变化，但它是本次改动中唯一可能影响既有测试稳定性的语义变化。
- 证据（diff）：

```diff
-    const executablePath =
-      process.env["HIMAWARI_CHROMIUM_PATH"] ?? (existsSync(bundled) ? bundled : undefined);
-    browser = await chromium.launch(executablePath ? { executablePath } : {});
+    browser = await launchChromium(chromium);
```

```ts
11: const configuredPath = process.env["HIMAWARI_CHROMIUM_PATH"] || undefined;
13: return await chromium.launch(configuredPath ? { executablePath: configuredPath } : {});
15: const missing = error instanceof Error && error.message.includes(MISSING_BROWSER_MESSAGE);
16: if (configuredPath || !missing || !existsSync(preinstalledPath)) throw error;
```

- 建议：如果目的只是让容器稳定，可先用 `chromium.executablePath()` 加 `existsSync` 判断默认浏览器是否真的存在，再决定是否尝试默认；如果确实要保留“其他启动错误原样抛出”，请在 PR 说明和测试环境说明里写明这一行为变化。

### 低-4 空白 `HIMAWARI_CHROMIUM_PATH` 仍被当作显式配置

- 文件：`test/fixtures/chromium-launch.ts:11`；`test/tooling/chromium-launch.test.ts:62-66`
- 问题：`||` 只把空字符串当作未配置，空白字符串（例如 `"   "`）仍会变成 `configuredPath`，启动失败后不会回退。反向用例只覆盖了 `""`。
- 证据：

```ts
11: const configuredPath = process.env["HIMAWARI_CHROMIUM_PATH"] || undefined;
...
63: process.env["HIMAWARI_CHROMIUM_PATH"] = "";
```

- 建议：按需 `trim()` 后再判断，或补一条空白字符串用例明确当前行为。

### 信息-1 作者“只改 test/ 下文件”的表述与 diff 不完全一致

- 文件/证据：`git diff dd49c411..e5365b9f --stat` 还列出了 `.agents/reviews/pr-412/round-1/*`、`.agents/reviews/pr-412/usage.jsonl`。
- 问题：如果“只改 test/”指代码改动，则正确；如果指字面上的全部改动，则不准确。这些是复核记录，不影响功能，但建议表述为“代码只改 test/ 下文件”。
- “七个文件 43 条测试在容器里通过”“lint 与 tsc 通过”无法在本次只读复核中独立运行验证，标为未核实。

## 读代码证实的

- `launchChromium`、`HIMAWARI_CHROMIUM_PATH`、`PREINSTALLED_CHROMIUM`、`MISSING_BROWSER_MESSAGE` 的使用范围全部在 `test/` 下；没有生产代码或模型请求组装逻辑引用它们。
- 七个集成测试都只调用 `launchChromium(chromium)`，没有传第二参数，因此都使用默认预装路径。
- 新增单测确实有 6 条用例，其中 4 条名带 `[reverse]`。
- 从代码静态推理：删掉 `if (configuredPath || ...)` 中的 `configuredPath` 后，显式配置用例会走到预装路径并成功返回，`rejects.toThrow` 会失败，所以作者说“删掉显式配置不回退判断后反向用例失败”在逻辑上成立。
- `test/tooling/**/*.test.ts` 会被 `ci/policy.json` 的 `tooling` 项目收集；CI 的 `policy` 和 `coverage` 会运行它。

## 推测的

- “默认浏览器损坏但预装路径可用时，原来六个测试会通过、现在会失败”是基于旧代码和新条件的推断，没有在真实容器里复现。
- 空白环境变量不回退的行为是从 `||` 语义推断的，没有专门测试验证。
- 作者声称的容器内 43 条测试、lint、tsc 通过，未实际运行核实。

## 侧重检查

- 错误路径：默认启动成功、默认启动报“找不到浏览器”后回退成功、显式配置失败不回退、空配置回退、非“找不到浏览器”错误不回退、预装路径不存在不回退，均有单测覆盖。
- 不可信输入：`HIMAWARI_CHROMIUM_PATH` 被直接当作可执行文件路径使用。这是测试环境变量，不是用户输入；与旧行为一致，没有新增生产暴露面。若 CI 环境变量本身不可信，则等同于执行任意二进制，但这是既有测试约定。
- 安全：没有新增日志、密钥、网络请求或权限提升；没有把环境变量内容写入输出。
- 资源耗尽：失败路径最多启动两次浏览器；单测创建临时目录和文件，并在 `afterEach` 中用 `rm(directory, { recursive: true })` 清理，没有循环或无限重试。
- 不可撤销操作：只有单测清理自己用 `mkdtemp` 创建的临时目录；没有删除用户数据或仓库文件。
- 规则/文档一致性：本次不触碰系统提示、工具定义、历史、遮盖或压缩，`prompt-prefix` 规则不受影响；没有需要同步修改的规则文档。唯一的文档性问题是作者“只改 test/”的表述需要限定。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。本改动只新增/修改测试夹具和浏览器集成测试，`launchChromium` 及相关常量只被 `test/` 下文件使用；没有改动系统提示、工具定义、历史消息、遮盖结果或请求组装。发给模型的内容仍然只在末尾追加，本次也没有新增任何“每轮变化”的值。未重新审查整个 prompt 组装链路，只确认本 PR 未触及它。

2. **会不会让同一段文字在不同请求里变成不同的字节？** 不会。改动不序列化任何模型内容，也不涉及遮盖、时间字段或集合顺序。唯一的运行时差异是测试进程读取 `HIMAWARI_CHROMIUM_PATH` 来选择浏览器可执行文件，与模型请求字节无关。

3. **有没有对应的自动检查，反向用例是否真的会失败？** 有：`test/tooling/chromium-launch.test.ts`，会被 CI 的 `tooling` 项目收集。4 条反向用例分别覆盖显式配置、空配置、其他错误、预装路径不存在。按代码静态推理，删除对应的 `configuredPath`、`!missing`、`!existsSync` 判断都会让相应反向用例失败；但没有实际运行验证。另需注意：本地 `npm run check` 的 `check:steps` 没有直接引用这个文件，它主要靠 CI 的 `policy`/`coverage` 或手动运行，若要求本地总检查也覆盖，需要把它挂到某个 check 脚本里。

4. **改动产生或修改的每个值，每个使用它的地方都能接受吗？**
   - `PREINSTALLED_CHROMIUM`：字符串，作为默认参数传给 `existsSync` 和 `chromium.launch({ executablePath })`，两端都接受；但单测没有覆盖默认值本身（低-2）。
   - `MISSING_BROWSER_MESSAGE`：字符串，实现里用于 `error.message.includes`，测试里用于 `new Error` 和 `toThrow`，两端都接受；但测试用同一常量构造错误，缺少对真实 Playwright 文案的独立校验（低-1）。
   - 新增参数 `preinstalledPath`：类型 `string`，七个集成测试都不传，使用默认值；单测传临时文件路径，`existsSync` 和 `launch` 都接受。没有发现两端类型或校验不一致。
   - 新导入路径 `../fixtures/chromium-launch.ts`：从 `test/integration` 和 `test/tooling` 都能解析到真实文件；根 `tsconfig.json` 的 `include` 覆盖 `test/**/*.ts`。
   - 提交里的 `Layer-0-tests: test/tooling/chromium-launch.test.ts`：文件存在，且匹配 `ci/policy.json` 中 `test/tooling/**/*.test.ts` 的收集规则，`check-layer0-tests.py` 能把它识别为已收集测试。

## 更好的方案（建议）

保留共享夹具的方向是对的，但可以进一步降低测试和真实 Playwright 之间的耦合：

1. 把 `MISSING_BROWSER_MESSAGE` 用固定字面量在测试里固定住，或者用一个真实的 Playwright 错误样本做契约测试，避免“实现常量改了、测试跟着改”的自证循环。
2. 把 `launchChromium` 的参数改成 options 对象（包含 `preinstalledPath` 和可选的环境读取函数），这样单测不用修改全局 `process.env`，也能覆盖默认值逻辑。
3. 如果希望避免“启动失败两次”和依赖错误文案，可以先检查 `chromium.executablePath()` 是否存在，再决定是否优先使用默认浏览器；这比先启动再靠错误字符串判断更确定。
