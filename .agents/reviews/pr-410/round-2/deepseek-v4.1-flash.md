## 复核结论

改动本身很小：提交 `14372f8b` 只改了 `test/integration/proactive-production.test.ts` 的浏览器启动方式，另外按流程提交了 `.agents/reviews/pr-410/round-1/` 记录。没有产品代码、提示词、工具定义或序列化格式改动。下面是按严重度排列的问题。

### 1. 【中】回退分支没有任何自动检查，CI 永远走不到它

- 文件:行：`test/integration/proactive-production.test.ts:631-638`
- 问题：这是本次改动的核心逻辑，但现有自动检查不会执行到 `catch` 回退分支；把回退删掉，CI 仍会通过。
- 证据：
  ```
  631: const bundled = "/opt/pw-browsers/chromium";
  632: const configuredPath = process.env["HIMAWARI_CHROMIUM_PATH"] || undefined;
  633: const browser = await chromium
  634:   .launch(configuredPath ? { executablePath: configuredPath } : {})
  635:   .catch((error: unknown) => {
  636:     if (configuredPath || !existsSync(bundled)) throw error;
  637:     return chromium.launch({ executablePath: bundled });
  638:   });
  ```
  CI 的集成测试作业显式装的是 headless shell，并把浏览器目录指到工作区：
  ```
  .github/workflows/ci.yml:265  PLAYWRIGHT_BROWSERS_PATH: ${{ github.workspace }}/.ci-output/browsers
  .github/workflows/ci.yml:278-279  安装集成测试用的 Chromium
                                    node node_modules/playwright/cli.js install --only-shell chromium
  ```
  因此 CI 里第一次 `launch({})` 就会成功，`catch` 不执行。`ci/policy.json:158-159` 的 integration 项目确实包含这个文件，说明它平时是跑的，但跑的永远是"默认浏览器存在"那条路。
- 建议：把"选浏览器路径"抽成一个可单测的小 helper（例如放在共享测试工具里），注入 `existsSync`/launch，覆盖四种分支：env 有值优先、env 无值且 bundled 存在时回退、bundled 不存在时抛原错、env 有值但启动失败时不得回退。或者让容器验收明确成为一条可重复执行的检查，而不是只在某台云端容器里手工通过。

### 2. 【低】捕获所有启动错误并丢弃原始错误，可能掩盖真正原因

- 文件:行：`test/integration/proactive-production.test.ts:635-637`
- 问题：`.catch` 不区分 "Executable doesn't exist" 和其他失败。若默认浏览器是因缺系统库、权限、资源不足、启动超时而失败，也会照样回退到 `/opt/pw-browsers/chromium`；如果回退也失败，抛出的只是第二次错误，第一次的根因丢失，排查时会误导。测试带 20 秒超时（`:664`），默认启动若卡到超时，回退根本没机会执行。
- 证据：同上 `635-637` 行；本测试超时设置：
  ```
  664: }, 20_000);
  ```
- 建议：只在错误确实是"可执行文件不存在"时回退；或者把两次错误一起保留（`AggregateError([error, fallbackError])` / `cause`），至少让第一次失败可见。若想简单一些，可以沿用另外六个测试的"先判断 bundled 是否存在"的写法，避免双次启动。

### 3. 【低】`existsSync` 只能证明"存在"，不能证明 Playwright 能执行它

- 文件:行：`test/integration/proactive-production.test.ts:636-637`
- 问题：代码用 `existsSync(bundled)` 判断能否作为 `executablePath`，但 Playwright 的 `executablePath` 要求指向一个可执行的浏览器二进制。若该路径是目录、悬空/错指符号链接、或没有执行权限，`existsSync` 仍可能为真，第二次 `launch` 才失败。
- 证据：
  ```
  636: if (configuredPath || !existsSync(bundled)) throw error;
  637: return chromium.launch({ executablePath: bundled });
  ```
  作者的事实"容器里 `/opt/pw-browsers/chromium` 是符号链接、设 `HIMAWARI_CHROMIUM_PATH` 指向它时测试通过"在当前检出中无法运行验证，**未核实**；另外六个测试用的是同一路径：
  ```
  test/integration/decision-chain-browser.test.ts:78-81
  78: const bundled = "/opt/pw-browsers/chromium";
  79: const executablePath =
  80:   process.env["HIMAWARI_CHROMIUM_PATH"] ?? (existsSync(bundled) ? bundled : undefined);
  81: browser = await chromium.launch(executablePath ? { executablePath } : {});
  ```
- 建议：校验是否可执行（如 `statSync` 后 `accessSync(X_OK)`），或干脆让 Playwright 抛错并在错误里带上候选路径。至少加注释说明这个硬编码路径的可执行性前提。

### 4. 【低】作者"同样的回退写法"的说法与代码不一致

- 文件:行：`test/integration/proactive-production.test.ts:631-638`；对照 `test/integration/decision-chain-browser.test.ts:78-81` 等六个文件。
- 问题：材料说"另外六个浏览器集成测试已有同样的回退写法 `HIMAWARI_CHROMIUM_PATH ?? (existsSync(bundled) ? bundled : undefined)`"。实际上另外六个文件是**启动前**根据 `existsSync` 选择路径（急切选择），本次改动是**先按默认启动、失败后再重试**（惰性回退），两者语义不同，不是"同样的写法"。这也让同一个问题在仓库里出现了两种实现。
- 证据：见上面 `decision-chain-browser.test.ts:78-81` 与 `proactive-production.test.ts:633-638`。grep 确认另外五个同类文件（`decision-email-browser`、`memory-source-browser`、`muse-reference-browser`、`review-prereview-browser`、`sensitive-interceptions-browser`）都是急切写法。
- 建议：要么统一成现有的急切写法（更简单、只启动一次），要么抽出共享 helper 并迁移全部七个调用点，避免下次修容器问题时再分叉。

### 5. 【信息】硬编码路径被执行的安全面（既有问题，非本次引入）

- 文件:行：`test/integration/proactive-production.test.ts:631,637`
- 问题：测试会无条件执行固定文件系统路径 `/opt/pw-browsers/chromium`。在共享/多租户容器里，如果 `/opt/pw-browsers` 可被非特权用户写入，测试会执行该位置的内容。这个模式另外六个测试和 `scripts/check-layout-audit.mjs:412-420` 已有，本次只是延续。
- 建议：不阻塞本 PR；部署上确保该目录 root 所有、不可被测试账号写入即可。

### 6. 【信息】"不改变其他环境的行为"并非字面成立

- 文件:行：`test/integration/proactive-production.test.ts:635-637`
- 问题：在"默认浏览器存在但启动失败、且 `/opt/pw-browsers/chromium` 存在"的环境里，改动前测试失败，改动后会用预装浏览器继续跑。这是回退的本意，但严格说改变了这一类环境的失败/通过结果。正常的"默认浏览器可用"和"env 已设置"环境行为未变。
- 建议：无需改代码，但材料里"不改变其他环境的行为"应写成"不改变默认浏览器可用或已设 env 的环境行为"。

---

## 侧重检查

- **错误路径**：`configuredPath` 有值时错误直接抛出，不回退（`:636`），语义正确。无值且 bundled 不存在时抛原错，正确。无值且 bundled 存在但不可执行时的二次失败未覆盖（见问题 3）。两次启动都失败时原始错误丢失（见问题 2）。
- **不合规范/不可信输入**：`HIMAWARI_CHROMIUM_PATH` 直接进 `executablePath`，与基线一致；空字符串用 `||` 归一为 undefined，基线用真值判断也是同样效果，未引入新差异。路径值没有进一步校验，但这是测试配置，风险有限。
- **安全**：固定路径执行属既有模式（见问题 5），未发现新增的密钥、日志或网络暴露。
- **资源耗尽**：单次失败只会重试一次，不会无限重试。若默认启动一直阻塞到 20 秒测试超时，回退不会发生，且理论上可能留下启动中的进程/临时目录；这是推测，未核实。
- **不可撤销操作**：没有；改动只影响浏览器启动。
- **规则/文档/代码一致性**：没有改动规则或文档；仓库内未读到 `.claude/rules/prompt-prefix.md`（工具未返回该目录下文件），规则原文未核实。材料中"只改一个测试文件"就代码而言成立；`14372f8b` 同时新增了 7 个 `.agents/reviews/pr-410/round-1/` 记录文件，按仓库规则这些应随 PR 提交，不算代码改动。材料中"同样的回退写法"不成立（问题 4）。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。代码改动只在 `test/integration/proactive-production.test.ts:631-638` 的浏览器启动；没有触碰系统提示、工具定义、历史消息、遮盖或请求组装。这个测试使用假模型脚本，产品发给模型的内容没有变化，"只追加、每轮变化值在最后一条消息"的性质不受影响。依据的 `.claude/rules/prompt-prefix.md` 原文当前未读到，未核实。

**2. 同一段文字会不会在不同请求里变成不同字节？**
不会。没有新增序列化、排序、时间字段或依赖前后文的遮盖；只改变了启动哪个浏览器。

**3. 有没有对应的自动检查？反向用例真的会失败吗？**
没有。CI 的集成测试作业装了 `--only-shell` 的 headless shell，`PLAYWRIGHT_BROWSERS_PATH` 指向工作区（`.github/workflows/ci.yml:265,278-279`），默认启动即成功，回退分支在 CI 永远不执行。把回退逻辑删掉，CI 仍然通过；只有目标云端容器里手工运行才会重新失败。`HIMAWARI_CHROMIUM_PATH` 设置但无效时"不得回退"的反向用例也没有。

**4. 改动产生/修改的每个值，所有使用方都能接受吗？**
改动涉及 `configuredPath`（来自 env，空串归一为 undefined）、常量 `bundled`、两次 `executablePath`。消费方都是 Playwright `chromium.launch({ executablePath })`，接受字符串路径；`configuredPath` 的语义与基线一致。与另外六个测试和 `scripts/check-layout-audit.mjs` 使用的是同一个常量值。唯一两端不匹配的是：生产方用 `existsSync` 判断"存在即可用"，消费方要求的是"可执行的浏览器文件"（问题 3）；作者关于该路径可执行的容器事实未核实。没有标识、清单项、配置键结构或序列化格式改动，不涉及 I-73 那种"清单 id 过不了后端校验"的问题。
