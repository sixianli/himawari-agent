# 交接：main 上 CI 新暴露的失败（2026-11-04）

接手前先读 AGENTS.md、`.claude/rules/`、`.agents/instructions/`（尤其 delivery-mode.md、model-review.md）。本文件只为交接，**PR 合并前删除它**。

- [现状](#status)
- [已做的改动](#changes)
- [未解决的问题和证据](#open)
- [要 Andy 决定的事](#owner)
- [接手后的下一步](#next)
- [复现方法和注意事项](#howto)

<a id="status"></a>
## 现状

- 分支 `claude/tender-bardeen-3uc0r6`，draft PR：https://github.com/sixianli/himawari-agent/pull/243
- 已合并 main 到 9d271df（含 #232、#235、#237、#239），无冲突。合并后在云端容器跑过：`npm run build` 通过，`npm run check` 32 步通过，定向测试 147 条通过。
- 交接时 PR 上的 CI 刚开始（只有 `policy` 在跑），没有评论。预计不会全绿，原因见[未解决的问题](#open)，大部分在 main 上同样失败，不是本 PR 造成的。
- 合并前还没做 OpenCode 代码复核（`node scripts/model-review/opencode-review.mjs --mode code-review`，见 `.agents/instructions/model-review.md`）。Andy 还没说“合并”。

<a id="changes"></a>
## 已做的改动（按提交）

| 提交 | 内容 | 验证 |
|---|---|---|
| e753684 | 浏览器 ja-320：定位器 `button[title]` 同时匹配附件和发送两个按钮（发送按钮也有 title），改为 `.attach-button`。修好后发现两个界面问题并修：手机上长模型名把模型按钮撑到 308px、超出 320px 屏幕（`rounded.css` 手机规则加 `max-width: 100%`）；附件按钮手机上被压成 36px，去掉覆盖回到 40px（ui-ux-design-guide 第 23 条）。按已批准设计更新用例：圆润设计（ADR 0137）手机上模型在输入框下一行；手机上“设置”在侧栏里；ADR 0095 起配置读完前显示“正在进入 Himawari…”入口页；“新建对话”侧栏和顶栏各一个。 | 改前复现同样的 strict mode 报错；改后 `node scripts/test-mobile-composer-browser.mjs chromium <目录>` 11 例通过 |
| 0a914b3 | security / Semgrep：`packages/platform-node/src/files/constrained-file-system.ts` 的 `readonly import("@himawari-agent/application").PermanentDeletionTarget[]` 让锁定的 Semgrep 1.152.0 只解析一部分（PartialParsing 警告），CI 带 `--strict` 时退出码 3，`scripts/ci/check-security.mjs` 只接受 0/1，于是报 `SEMGREP_TOOL_FAILED`。改为 `import type`。按项目规则删了该文件原有 11 行注释。 | 用 `semgrep==1.152.0`、CI 相同参数、同一组 672 个文件扫描：改前退出码 3、唯一错误在此文件；改后退出码 0、无命中。定向测试 44 条通过 |
| ab3158d | 4 条与平台无关的过期测试：gateway-v2 兼容样例补 #226 新增的 `proactive.weekly.read`、`proactive.weekly.snapshot`、`proactive.observation.start`；构建清单测试不再写死 16 个包，改为和 apps/*、packages/* 下有 package.json 的目录逐个比较（现在 17 个，多了 calibration）；PG-10 补 #215 新增的 `decidedAt`、`reviewedAt`；`installable-node-services` 的 `schemaSequence` 不再写死 65，改为取迁移目录最大序号（现在 74）。 | 前两条改前本机复现失败、改后通过；PG-10 37 条通过；`installable-node-services` 要 CI 构建的上线包，本机没跑，只核对了最大序号 74 与 mac 报告实际值一致 |
| 8de22e1 | 产品修复：自动审查进行中、或处于 `reconciling_external_result` 时，收起的过程区写成“正在思考”。`execution-process.tsx` 的 liveStep 先看这两种状态。依据 ui-ux-design-guide 第 46、51 条。 | 新增 `[UI-46]` 单元测试，改前失败、改后通过，含反向用例 |
| cacbaa7 | 浏览器用例跟上已批准的设计（只改测试脚本）：执行链用例按测试记录时间固定页面时钟（原来记录是 9 月、真实时间 11 月，页面一直显示“暂未收到新的进展”）；第 46 条按整秒、不画时间条、当前步骤在 `.process-live-step`；ADR 0087/0105/0110；CSRF 用例不再假设两次上传一前一后；第 38、44、7、11、16 条。 | `node scripts/test-execution-chain-browser.mjs chromium <目录>` 12 例通过 |
| 8165343 | 合并 main 9d271df | 见上 |

<a id="open"></a>
## 未解决的问题和证据

### 1. 浏览器资格验证仍不过（chromium、firefox 都停在同一处）

- 命令：`node scripts/qualify-control-center-browser.mjs chromium --static-root apps/control-center/dist --report-directory <目录>`（CI 由 `scripts/ci/browser.mjs` 调用）。
- 停在 `scripts/qualify-control-center-browser.mjs` 约 596-638 行：`/tasks/job-repository-monitor`、`/inbox`、`/memory/memory-01`、`/trace`、`/sessions` 现在都显示“找不到这个页面”。
- 证据：`apps/control-center/src/app.tsx` 约 610-624 行只渲染对话、审批/能力/授权、健康这几类页面，src 里已没有这些页面的组件；但 `control-center-inventory.ts:167` 等处仍标 `integrationPolicy: "allowed"`，测试服务器也装了对应操作。没找到批准下线这些页面的文档（只有 `docs/execution/specs/2026-09-15-control-center-v4-design.md:25` 说侧栏不放入口）。**要 Andy 定**：有意下线就改断言为“应显示找不到页面”并把 inventory 改一致；否则是功能倒退。
- 后面还有一批过时断言没跑到（约 636-684 行）：`.topbar-controls button`、`.settings-content select`、`.list-pane`、标题“Sessions and devices”；以及“界面语言存在 localStorage、改语言不发请求”，这条与 ui-ux-design-guide 第 24 条（账户设置存服务端）和 ADR 0122 矛盾。
- webkit：本机缺系统库（libgtk-4、libgraphene、libevent 等）启动不了，要 `npx playwright install-deps`，会改容器系统软件包，没执行。
- 本机跑浏览器前要先 `npx playwright install --only-shell chromium`（项目锁定的版本，容器自带的版本对不上），改了 `apps/control-center/src` 后要 `npm run build:browser`。
- 顺带发现、没改的：审查行仍显示“1.5s”这种小数（`execution-process.tsx` 约 270 行用 `duration()`），未进时间线的工具状态也有“· 9.4s”，`thread-interactions.unit.test.ts:1640` 断言了它，与第 46 条“按秒计时”不一致；合并后的“搜索网页”行不能展开，搜索失败时什么都不显示，设计文档没说清是否有意。

### 2. security / Gitleaks（没登记任何例外）

- 555 条命中，507 条未登记：当前文件 250 条、历史 257 条。用锁定的 gitleaks 8.30.0 本地复跑与 CI 报告逐条一致。main 上 f91950b、f2d91e6 两次运行结果相同，不是本 PR 造成的。
- 规则配置 `ci/rules/gitleaks.toml` 只有默认规则、无白名单；`gitleaks:allow` 注释、`.gitleaksignore`、基线文件都被脚本禁用（`scripts/ci/check-security.mjs` 约 369-382 行）。历史扫描扫 head 的全部祖先，所以**只改当前测试数据不会变绿**。
- 例外按（规则、路径、字面量 sha256）匹配，从 main 上的 `ci/security-exceptions.json` 读（`scripts/ci/security-exceptions.mjs` 约 200-209 行），`synthetic-secret` 例外只允许在 test 路径下、字面量要有 `HIMAWARISYNTHETICONLY` 或属于 5 种固定分类之一。
- 分组（值只给前 4 位和长度）：

| 组 | 当前/历史 | 内容 | 判断 |
|---|---|---|---|
| G1 | 240/240 | `test/qualification/evidence/workspace-authorization-lifecycle/*` 冻结证据 JSON 里的 `"<文件名>.ts": "<64 位十六进制>"`，键名带 secret/credential 被当成 API key | 文件 SHA-256，不是密钥 |
| G2 | 0/3 | 已删除的 `.agents/tasks/round2-tool-execution/evidence.jsonl` 里的 git blob SHA-1 | 不是密钥 |
| G3 | 3/3 | `tokenValue: "0123…"`（32 位），`test/fixtures/product-path-harness.ts:969`、`queued-live-worker.ts:47`、`test/integration/production-invocation-authority.test.ts:41` | 合成值，符合现有 `synthetic-boot-token` 分类 |
| G4 | 4/4 | Web Push `auth: "BTBZ…"`（22 位），`production-web-push-control.test.ts`、`gateway-v2.fixture.ts:52` | RFC 8291 公开测试向量 |
| G5 | 1/1 | `Bearer R2T1…`，`apps/agent-service/test/production-foreground-result.unit.test.ts:139` | 合成值 |
| G6 | 1/2 | `test/fixtures/memory-capture-eval/dataset.json:2562` 的 `ghp_…` | 已离线核对是假令牌 |
| G7 | 1/1 | `probe.sh:111` 的 `tmpfs-size=1048576` | 误报 |
| G8 | 0/2 | 已删除的 `apps/agent-service/test/production-reminder-push.unit.test.ts:10/60` 的 `deviceKey: "F5u4…"`（22 位），提交 f73b0b76 引入、9dcdb6e 删除 | **不确定**，格式像真实 Bark key，要 Andy 比对 |
| G9 | 0/1 | 已删除的 `scripts/operations/cache-zero-diagnosis/README.md:8` 的线程 UUID | 不是密钥 |

- 建议（都要 Andy 批准，按规定走只含规则改动的独立 PR）：G1+G2 在 gitleaks.toml 加一条只对 generic-api-key、只放行“文件名 → 40/64 位十六进制”形式的白名单（本地实测当前 273→33、历史 282→39，正好只去掉这 483 条）；G3 按现有分类登记例外；G4/G5/G6/G7/G9 按精确值放行；G8 先确认。
- 另发现：gitleaks 配置读的是被测提交里的 `ci/rules/gitleaks.toml`（`check-security.mjs` 约 648 行），PR 能在自身里放宽规则，和设计文档“同一 PR 不能自行降低阈值”不符。

### 3. 51 条安全例外 2026-11-23 到期

- `ci/security-exceptions.json` 里 13 条 `synthetic-secret` + 38 条 `published-synthetic-fixture`，`expiresAt` 是 `2026-11-23T00:00:00Z`（JST 09:00）。到期后 `SECURITY_EXCEPTION_EXPIRED_OR_INVALID`，security 在扫描前就失败，build 的报告发布也会失败（见 docs/backlog/BL-20261003-001）。
- 续期：Andy 逐条确认；`proposedAt` 改为不晚于当天，`expiresAt` 不超过 `proposedAt + 30 天`，只改日期，合进 main 才生效。PR 4 上那 26 条审批另算，12-03 到期。

### 4. Linux 的 test、coverage、node-floor 一直没有结果：是超时，不是推送取消

- 证据：main 运行 41809144490（`main.yml` 的 `cancel-in-progress: false`）里，三项从开始到取消分别约 30、15、30 分钟，正好等于 `ci.yml` 的 `timeout-minutes`。
- 本机限制到 2 核模拟：unit 370 秒、integration 1672 秒，光这两项就超过 30 分钟（当时机器上还有浏览器测试在跑，数字偏大）。integration 最慢的文件是 `sqlite-sandbox-execution-v2.test.ts`（2 核 725 秒，mac 249 秒）。
- 结构问题：`scripts/ci/test.mjs` 内部预算取 `ci/policy.json` 的 `timeoutMinutes`（30），和 job 超时相同，job 先被 GitHub 杀掉，`result.json` 来不及写，报告丢失。
- #229 把 CI 换到 Hermes 自托管 runner，可能缓解；要等它试跑结果。

### 5. macOS test 的 14 条

- 已修（Linux 上也失败的 4 条）：见 ab3158d。
- 只在 mac 上出现，#229 暂停 mac 检查后可不管：`linux-host-guardian`（断言 Linux）、`sandbox-preparation-control` 4 条（写死 `/lib`、`/lib64`）、`r2t10-not-started`（mac 的 sleep 在 `/bin/sleep`）、`sandbox-control-evidence`（mac 上按设计尽力而为）、R2-D20（疑似 mac 时序，`process-output.ts` 约 45-71 行主进程退出后 100ms 无输出就结束等待；Linux 未复现）。
- 没修：
  - PG-12 `proactive-production`：test job 没装浏览器（只有 browser job 有“安装锁定 Playwright 对应引擎”这一步，`scripts/ci/run.mjs` 约 156 行把浏览器目录设成空的 `.ci-output/browsers`），Linux 上也会失败。本机把 `PLAYWRIGHT_BROWSERS_PATH` 指向空目录可复现。要改工作流，可能和 #229 冲突。
  - R2-L5 `production-http-composition-process`：标题生成和记忆提取两次模型调用报 `PORT_INVALID_OPERATION`，计费记录成 unknown。原因未定位，要用 CI 上线包在 Linux 上实跑。
  - `jarvis-test/live-harness`：mac 上清理时删 `sales.csv` 报 EACCES，本机是 root 掩盖了权限问题，未查。
- 已由 #239 解决：`sandbox-preparation-control` 3 条与 #234 的 `JOB_HOST_SECCOMP_HELPER_NOT_IN_USE` 冲突。

### 6. static 的 `check:layout` 缺 Chromium

修复在 #229 的 085049a7，等 #229 合并。开着的 PR 的 `policy` 报 `CI_PR_MERGE_IDENTITY_MISMATCH` 同样等 #229 的 b114b1b2。

### 7. 其他

- AGENTS.md 说 GitHub Actions 已关闭，但 CI 实际在跑，说法与事实不符（未改，属于项目指令，要和 Andy 确认）。
- `docs/incidents-and-gates.md` 没有加新行：这些都是 CI 首次跑到后面的检查才看到的旧问题，不是生产事故。Semgrep 一行写法让整项安全检查失败，可作为工程案例库候选，没写。

<a id="owner"></a>
## 要 Andy 决定的事

1. `/tasks`、`/inbox`、`/memory`、`/trace`、`/sessions` 是有意下线，还是要补回来？（最优先，不定浏览器检查过不了）
2. 旧提交里的 Bark 设备 key（开头 `F5u4`）是不是真的？是就要在 Bark 里重置。
3. Gitleaks 507 条：是否批准上面的白名单和例外方案。
4. 51 条例外 11-23 前逐条确认续期。
5. CI 超时：调大时限 / 内部预算低于 job 超时，还是等 #229 换到 Hermes 后再看。
6. test job 要不要装 Chromium（改工作流，可能和 #229 冲突）。

<a id="next"></a>
## 接手后的下一步

1. 订阅 PR #243 的动态（`subscribe_pr_activity`），看这轮 CI 结果。属于本 PR 的失败直接修；属于上面已知原因的，在 PR 上留一条说明。
2. 等 Andy 定第 1 项后改 `qualify-control-center-browser.mjs` 约 596-684 行，跑通 chromium、firefox。
3. 按 `.agents/instructions/model-review.md` 做合并前代码复核，**删除本交接文件**，等 Andy 说“合并”。
4. 上一线程设了一个 50 分钟后的自检提醒（trigger `trig_01BZQjdxdZFjjFqhfiD4urcu`），它会回到上一个线程，不会到新线程。

<a id="howto"></a>
## 复现方法和注意事项

- 格式工具是 biome（`npx biome format --write <文件>`），不要用 prettier（它按 80 列重排，`format:check` 会失败）。
- CI 报告：GitHub MCP 的 `actions_list`（`list_workflow_run_artifacts`）和 `actions_get`（`download_workflow_run_artifact`）拿临时下载链接，用 curl 下载。报告名 `report-<run>-1-<检查>-<矩阵>`；运行被取消时没有报告。
- Semgrep 复现：建一个临时 venv 装 `semgrep==1.152.0`，参数照 `scripts/ci/check-security.mjs` 约 519-536 行，配置 `ci/rules/semgrep.yml`，目标是 `git ls-files` 里匹配 `^(apps|packages)/[^/]+/src/.*\.(c?m?js|jsx|ts|tsx)$` 或 `^scripts/ci/.*\.mjs$` 的文件。
- Gitleaks 历史扫描要完整克隆（这个仓库检出是浅克隆）。原始结果含完整密钥值，不要上传或提交。
- 上一线程的中间证据都在它自己容器的临时目录里，新线程拿不到，需要时按上面的方法重新生成。
