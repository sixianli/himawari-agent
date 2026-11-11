# PR 412 复核结论

改动范围核对（读代码证实）：`git diff --stat` 显示只改了 `test/fixtures/chromium-launch.ts`（新增 15 行）和 7 个 `test/integration/*.test.ts`，作者「只改 test/ 下文件」属实；43 条 `it(` 用例计数与作者说法一致（静态计数；是否在容器里通过、lint/tsc 是否通过，我未运行，标「未核实」）。

## 按严重度排列

**低 | test/fixtures/chromium-launch.ts:11 | 回退判定依赖 Playwright 英文报错文案**
- 证据：`const missing = error instanceof Error && error.message.includes("Executable doesn't exist")`。Playwright 版本锁定 1.62.1（package.json:108），仓库里留有真实报错样本证实该文案（test/qualification/evidence/web-refactor-2026-09-10/browser-regression/browser.json:6：`browserType.launch: Executable doesn't exist at ...`）。
- 读代码证实：此前六个文件靠 `existsSync` 先判存在，不依赖任何报错文案；重构后它们改为依赖这条英文子串。Playwright 升级若改文案，回退会静默失效（退化为抛原始错误），测试在只有 /opt/pw-browsers 的环境里会失败——是可见失败，不是假通过。
- 建议：在 fixture 顶部注释写明该文案与 Playwright 版本绑定，升级 Playwright 时需核对；或升级该检查到 Playwright 暴露的结构化字段（若未来有）。

**低 | test/integration/decision-chain-browser.test.ts:78 等 6 处 | 默认浏览器与预装浏览器并存时，所用二进制改变**
- 证据：旧逻辑（本次 diff 删除的行）是 `HIMAWARI_CHROMIUM_PATH ?? (existsSync(bundled) ? bundled : undefined)`，即预装路径存在就优先用预装；新逻辑是先按默认配置启动、报「找不到」才回退到 `/opt/pw-browsers/chromium`（chromium-launch.ts:8-13）。两者都存在时，从预装换成默认，二进制版本可能不同，浏览器级测试结果可能随之变化。
- 作者已声明这是有意统一（对齐 proactive-production 的 PR 410 行为），且称容器内 43 条通过。CI 环境（PLAYWRIGHT_BROWSERS_PATH=.ci-output/browsers，README.md:64 安装 chromium）里 /opt/pw-browsers 大概率不存在，实际行为不变。容器内是否同时装了两套浏览器、新顺序实际走的是哪条分支：未核实。
- 建议：接受即可；若想消除歧义，可让容器统一用 `HIMAWARI_CHROMIUM_PATH` 指定。

**提示 | test/fixtures/chromium-launch.ts:7 | 空字符串环境变量语义变化**
- 证据：旧六个文件用 `??`，`HIMAWARI_CHROMIUM_PATH=""` 会被当成配置值传给 `executablePath` 而启动失败；新代码 `process.env["HIMAWARI_CHROMIUM_PATH"] || undefined` 把空串当未配置，走默认/回退。与 proactive-production 原实现一致，属良性变化，但与被替换代码行为不同，记录在案。

**提示 | test/fixtures/chromium-launch.ts（整个文件）| fixture 本身没有直接测试**
- 证据：仓库内搜不到对 `launchChromium` 的单元测试；它只被 7 个集成测试间接使用（grep `launchChromium` 共 8 处命中，全在 fixture 与 7 个测试文件）。
- CI 里的实际覆盖：这 7 个文件命中 `test/integration/**/*.test.ts`（ci/policy.json:159），integration 项目在 check 门里运行（ci/policy.json:108 `projects` 含 "integration"，scripts/ci/run.mjs:242 `await vitest(check.projects)`）。所以「回退被删掉会失败」这类回归在缺默认浏览器的环境会被 CI 拦住；但「回退条件写反（configuredPath 时也回退）」这类回归，CI 不设 `HIMAWARI_CHROMIUM_PATH`，不会被发现。
- 建议：可接受；若在意，加一条 tooling 级单测直接调 `launchChromium`（stub BrowserType）覆盖三条分支。

**提示（范围外，不动结论）| scripts/demo/record-email-decision.mjs:68-70、scripts/check-layout-audit.mjs:412-420 | 旧「先判存在」逻辑仍留在 scripts/ 里**
- 证据：grep 显示 `pw-browsers` 还出现在这两个脚本（另有 `HIMAWARI_LAYOUT_AUDIT_CHROMIUM` 第三种选法）。本次 PR 明确只针对 test/，不算问题，但仓库现在并存两种选浏览器策略，将来有人抄脚本时可能抄错。

## 侧重检查

走的流程：`npm run check` → scripts/ci/run.mjs 跑 vitest `check.projects` → integration 项目（vitest.workspace.ts:158-159，global-setup）→ 七个文件的 `beforeAll` → `launchChromium`（chromium-launch.ts）→ Playwright 默认路径启动 / 报错回退 / 直接抛错。
- 有测试覆盖：fixture 的「默认启动成功」主路径（CI 装了 chromium 时七条用例全走这里）。
- 无测试覆盖：fixture 的回退分支（chromium-launch.ts:13）与三个 rethrow 条件（:11）没有直接用例，只在缺默认浏览器的环境被走到；`HIMAWARI_CHROMIUM_PATH` 非空分支 CI 也不会走到。
- 文档与规则一致性：docs/ui-ux-design-guide.md:249 只描述 `scripts/test-run-approval-browser.mjs` 的 `HIMAWARI_CHROMIUM_PATH` 用法，与本次改动不冲突；未发现文档声称六个测试用「先判存在」策略，无文档失配。

## 必答问题

1. **会不会改变模型已见过的请求开头？** 不会。改动只涉及测试里本地 Chromium 进程怎么拉起（读代码证实：diff 全部在 test/ 下，`executablePath` 只进 Playwright launch 参数，不进任何发给模型的 payload）。发给模型的内容不受影响，谈不上「只在末尾追加」的破坏。
2. **会不会让同一段文字在不同请求里变成不同字节？** 不会。新增的三个值（env 变量、`existsSync` 结果、报错文案匹配）只决定本地用哪个浏览器二进制，不进入任何序列化给模型的字节（读代码证实）；推测：即便某次测试因浏览器版本不同而渲染差异，也只影响测试断言，不影响产品对模型的请求字节。
3. **有没有对应的自动检查，反向用例会不会真的失败？** 七个用例本身在 check 门的 integration 项目里跑（读代码证实，见上）。主路径回归会被拦；但「回退条件写反」没有反向用例能拦（CI 不设 `HIMAWARI_CHROMIUM_PATH`），fixture 无直接单测（读代码证实）。
4. **每个新值的两端核对？** 逐一核对如下（读代码证实）：`HIMAWARI_CHROMIUM_PATH`——生产者是运维/CI 环境，消费者现在是 fixture 与 3 个 scripts，各处语义已列出（空串语义有差异，见上）；`/opt/pw-browsers/chromium`（现名 `PREINSTALLED_CHROMIUM`）——该路径由容器镜像提供，仓库内无创建处，只有消费处（fixture、check-layout-audit.mjs、record-email-decision.mjs），是否存在属外部事实，未核实；报错文案 `"Executable doesn't exist"`——生产者是 Playwright 1.62.1，消费者是 fixture，仓库内样本证实当前版本匹配（见第 1 条发现，绑定版本的风险已列）。

**作者说法核对汇总**：「只改 test/ 下文件」属实；「43 条测试」静态计数属实，「容器里通过」未核实；「lint 与 tsc 通过」未核实；「此前六个文件是先判断存在再选路径，现在统一为先启动、找不到才回退」与 diff 一致，属实。
