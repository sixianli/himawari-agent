## 读代码确认的问题（按严重度）

### 1. 高：新扫的 `.github` 里 `arch: x64` 完全没进清单
- **文件:行**：`scripts/check-platform-assumptions.mjs:47`；`.github/workflows/ci.yml:126,180,186,192`
- **问题**：`arch-x64` 正则要求 `x64` 两侧有引号：`/\barch\s*(?:[!=]==?|:)\s*["']x64["']/g`。YAML 里写成裸标量 `arch: x64` 时不匹配，所以这次新加进扫描目录的 `.github` 中 4 处 x64 平台假设没有进入 `scripts/platform-assumptions.json`。作者说 `arch-x64（比较或对象字段）` 已覆盖，实际没有覆盖 YAML 对象字段。
- **证据**：
  - `scripts/check-platform-assumptions.mjs:47`：`"arch-x64": /\barch\s*(?:[!=]==?|:)\s*["']x64["']/g,`
  - `.github/workflows/ci.yml:126`：`            arch: x64`
  - 清单的 `arch-x64` 段 `scripts/platform-assumptions.json:97-109` 没有 `.github/workflows/ci.yml`。
  - 测试夹具 `test/tooling/platform-assumptions.test.mjs:41` 只覆盖了带引号的 JS 对象字段，没有覆盖 YAML 裸标量。
- **建议**：把正则改成允许裸标量（例如 `x64` 两侧引号可选，并加边界/负向前瞻避免误匹配 `x64foo`），然后重新生成清单；同时在测试里加一个 `.github/workflows/ci.yml` 的 `arch: x64` 反向夹具。
- **性质**：读代码证实；补上后会新增 4 处计数属推测。

### 2. 中：`fixed-hostname` 只认函数比较，漏掉实际的固定主机名
- **文件:行**：`scripts/check-platform-assumptions.mjs:50-51`；`scripts/operations/ci-runner/runners.sh:2-3`；`scripts/operations/ci-runner/prepare-vps.sh:5-6`；`scripts/operations/hermes-harness-start.mjs:108`（另外 `hermes-e2e-fixes-start.mjs`、`hermes-loop-identity-start.mjs`、`hermes-ui-session-start.mjs` 同样在 108 行）
- **问题**：`fixed-hostname` 只匹配 `hostname()`/`gethostname()` 后面直接跟字面值，或 `equal(hostname(), "字面值")`。它漏掉了：
  - shell 里固定主机名变量：`RUNNER_HOST=ci-vps`、`CI_HOSTNAME=ci-vps`、`ORIGINAL_HOSTNAME=vps-482b8c36`；
  - JSON/对象里的固定主机身份：`sourceIdentity: "host:hermes-home"`。

  因此“全仓找出固定主机名”的目标没有完成，清单对这类写死主机名没有基线，今后新加也不会失败。作者对“fixed-hostname 只认比较字面值”的描述本身与代码一致，但这与 ADR 描述的“固定主机名”目标不一致。
- **证据**：
  - `scripts/check-platform-assumptions.mjs:50-51`：只匹配 `hostname\(\)\s*[!=]==?\s*["']...` 或 `[eE]qual\(...hostname\(\)\s*,\s*["']...`。
  - `scripts/operations/ci-runner/runners.sh:2-3`：`RUNNER_HOST=ci-vps`、`RUNNER_LABEL=ci-vps`。
  - `scripts/operations/ci-runner/prepare-vps.sh:5-6`：`CI_HOSTNAME=ci-vps`、`ORIGINAL_HOSTNAME=vps-482b8c36`。
  - `scripts/operations/hermes-harness-start.mjs:108`：`sourceIdentity: "host:hermes-home",`。
  - 清单 `fixed-hostname` 段 `scripts/platform-assumptions.json:127-187` 没有这些 shell 文件，也没有四个 `hermes-*-start.mjs`。
- **建议**：把固定主机名分成子类：函数比较、shell/环境变量赋值、`host`/`hostname`/`sourceIdentity` 之类字段的固定字面值；用字段名和赋值形态识别，不写死具体主机名。补对应测试夹具。
- **性质**：读代码证实这些固定主机名存在且未被清单记录；“在 ARM 上会因此出问题”属推测，未验证。

### 3. 中：没有扫描无扩展名文件，且“仓库里没有 Dockerfile”不成立
- **文件:行**：`scripts/check-platform-assumptions.mjs:25-38,66`；`packages/runtime-sandbox/runner-image/Dockerfile:1-2`；`test/integration/fixtures/browser-image/Dockerfile:1-2`
- **问题**：扫描只接受固定扩展名（`.ts`、`.js`、`.py`、`.yml` 等），没有扩展名的文件一律跳过。作者说“仓库里没有 Dockerfile、Makefile，所以没有扫无扩展名文件”，这是错的：仓库里至少有两个 Dockerfile。当前两个 Dockerfile 只使用多架构 Node 镜像，没有写死架构，所以当前清单没有漏计；但以后 Dockerfile 里出现 `FROM --platform=linux/amd64` 或 `RUN ... x86_64` 时，这道检查看不见。
- **证据**：
  - `scripts/check-platform-assumptions.mjs:66`：`else if (entry.isFile() && SCANNED_EXTENSIONS.has(path.extname(entry.name)))`
  - `packages/runtime-sandbox/runner-image/Dockerfile:1`：`FROM docker.io/library/node:22.22.3-alpine@sha256:...`
  - `test/integration/fixtures/browser-image/Dockerfile:1`：同样是 Node 多架构镜像。
- **建议**：要么把 `Dockerfile`、`Containerfile`、`Makefile` 等无扩展名文件加入显式扫描，要么在 ADR/作者说法里明确“只扫这些扩展名”，不要说“全仓”且不要声称仓库没有 Dockerfile。最好增加无扩展名文件的测试夹具。
- **性质**：Dockerfile 存在是读代码证实；“未来的 Dockerfile 会出现平台假设”属推测。

### 4. 中/低：`--write`、缺失清单、合法但形状不对的 JSON，错误路径不一致
- **文件:行**：`scripts/check-platform-assumptions.mjs:114-152`；`scripts/check-platform-assumptions.mjs:88-104`
- **问题**：
  1. 作者说“清单缺失或不是合法 JSON 返回 1”。普通检查确实返回 1；但 `--write` 下，缺失清单会直接创建并返回 0，非法 JSON 会先打印 `INVENTORY_INVALID`，然后也覆盖写入并返回 0。这个说法只在非 `--write` 下成立。
  2. `readInventory` 只把 `ENOENT` 当缺失，其他读取错误（例如权限错误、路径是目录）都会被外层 `catch` 报成“不是合法的 JSON”，错误信息误导。
  3. 合法 JSON 但不是对象（例如 `null`）时，非 `--write` 路径会在 `comparePlatformAssumptions` 的 `recorded[name]` 处抛 `TypeError`，直接崩溃，而不是返回 1 并打印稳定错误码。
  4. `--write` 直接 `writeFileSync` 覆盖清单，没有临时文件或原子替换；中途失败可能留下损坏清单，而且它能在清单缺失/非法时直接覆盖，属于不可逆操作。
- **证据**：
  - `scripts/check-platform-assumptions.mjs:114-122`：`readInventory` 对 `ENOENT` 返回 `undefined`，其他错误抛出。
  - `scripts/check-platform-assumptions.mjs:134-139`：`catch { error(...INVALID...); if (!write) return 1; }`
  - `scripts/check-platform-assumptions.mjs:140-147`：`if (write) { ... writeFileSync(...); return 0; }`，没有区分缺失/非法。
  - `scripts/check-platform-assumptions.mjs:91`：`const before = recorded[name] ?? {};`，`recorded` 为 `null` 时会抛错。
  - `test/tooling/platform-assumptions.test.mjs:126-133` 只测非 `--write` 的缺失/非法；`135-154` 只测正常 `--write`，没有测 `--write + 缺失/非法`。
- **建议**：明确并测试 `--write` 对缺失/非法清单的行为；校验 JSON 顶层必须是普通对象；区分“读不到”和“格式非法”；`--write` 使用临时文件加 `rename` 原子替换，最好先验证再写。
- **性质**：读代码证实；资源/中断导致损坏属推测。

### 5. 低：CLI 入口退出码和 CLI `--write` 仍未被测试
- **文件:行**：`scripts/check-platform-assumptions.mjs:164-166`；`test/tooling/platform-assumptions.test.mjs:103-153`
- **问题**：上一轮意见是“入口退出码和 `--write` 没有测试”。现在测试的是导出的 `runPlatformAssumptionsCheck` 返回值，不是 `node scripts/check-platform-assumptions.mjs` 进程真实退出码；CLI 分支 `process.argv` 和 `process.exitCode` 那一行没有测试。`--write` 也是函数级测试，没有测 CLI 参数解析。
- **证据**：
  - `scripts/check-platform-assumptions.mjs:164-166`：`process.exitCode = runPlatformAssumptionsCheck({ write: process.argv.includes("--write") });`
  - `test/tooling/platform-assumptions.test.mjs:103-113` 的 `run()` 直接调用函数并收集 `log`/`error`。
- **建议**：加一个真正 spawn CLI 的集成测试，至少覆盖普通检查退出码 1、`--write` 退出码 0 和写后字节稳定。
- **性质**：读代码证实是覆盖缺口；是否会在实际 CI 中漏掉该行错误属推测。

## 侧重检查

我按额外侧重逐项查了这些路径：

- **错误路径**：`readInventory` 对 `ENOENT`、非法 JSON、其他读取错误、合法但非对象 JSON 的处理不一致，见问题 4。
- **不合规范或不可信的输入**：清单 JSON 顶层没有形状校验；`null` 会导致非 `--write` 崩溃；未知类别能正常报 `UNKNOWN`。
- **安全**：改动不接触密钥、网络或生产运行时；风险主要来自开发工具 `--write` 覆盖清单，属仓库内不可逆写操作，见问题 4。
- **资源耗尽**：扫描会同步读取所有匹配文件，没有单文件大小上限；这是仓库内开发检查，当前不构成高风险，但超大文件/异常仓库会增加内存和耗时，属低风险推测。
- **不可撤销的操作**：`--write` 直接覆盖清单元数据且能覆盖非法/缺失清单，没有备份或原子替换，见问题 4。
- **规则文件、说明文档和代码一致性**：
  - 读了 `.claude/rules/prompt-prefix.md`（稀疏检出里没有，用 `git show` 读的）：本改动不组装模型请求，规则第一、二、四节不涉及。
  - `docs/incidents-and-gates.md` 的 I-73 教训已对照：清单类别名、计数和检查消费者之间基本一致，但 `arch-x64` 和 `fixed-hostname` 的生产端有漏项。
  - ADR 0253 第 63 行“按次数比较、同文件删一处加一处发现不了”与实现一致；但“全仓”与扫描范围不一致，作者“没有 Dockerfile”说法不实。
  - ADR 里的 ARM bwrap 退出码 0 无法从代码核实。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**

   不会。`git diff --name-status 6e33c029..80c4883` 显示改动只涉及 `package.json`、新增检查脚本、清单、测试、ADR 和复核记录；没有改系统提示、工具定义、历史消息、出口遮盖或请求组装代码。发给模型的内容仍然只在末尾追加，本改动也没有把任何每轮变化的值移入/移出最后一条消息。ADR 自身第 95 行也写“不改系统提示、工具定义、历史消息和出口遮盖”。依据：`.claude/rules/prompt-prefix.md` 的只追加要求。

2. **会不会让同一段文字在不同请求里变成不同字节？**

   不会影响模型请求。对于检查自己的产物，输出也是确定的：`scanPlatformAssumptions` 最后对文件 `files.sort()`，`comparePlatformAssumptions` 对文件联合集排序，`JSON.stringify` 的键顺序来自固定的 `PLATFORM_ASSUMPTIONS` 对象和排序后的文件顺序，没有时间字段、无序集合或前后文相关处理。`--write` 测试还断言了两次写入字节相同。依据：`scripts/check-platform-assumptions.mjs:77-83,93,145`，`test/tooling/platform-assumptions.test.mjs:147-153`。

3. **有没有对应的自动检查，反向用例是否真的会失败？**

   有：`package.json` 的 `check:platform-assumptions` 已加入 `check:steps`，而 `check` 通过 `run-all-checks.mjs` 执行 `check:steps`。测试共 9 个 `it`，新增了“清单缺项返回 1”“清单缺失/非法返回 1”“`--write` 幂等且之后检查通过”等用例；按代码推断，如果 `comparePlatformAssumptions` 不再报 `added`/`stale`，这些断言会失败。

   但覆盖不全：没有测 `.github` 里裸标量 `arch: x64`，没有测 shell/`sourceIdentity` 固定主机名，没有测 CLI 进程退出码，没有测 `--write + 缺失/非法清单`。我没有运行测试（本次只能用 read/grep/glob 和限定的 git 命令），以上是按代码和断言的判断。

4. **改动产生/修改的每个值，两端都能接受吗？**

   - **类别名**：`PLATFORM_ASSUMPTIONS` 的 7 个键与清单 `scripts/platform-assumptions.json` 的 7 个顶层键一致；`comparePlatformAssumptions` 用同一组键遍历，未知类别会被报 `UNKNOWN`，这一端能接受。
   - **计数和清单**：`scanPlatformAssumptions` 产生计数，`--write` 写入，`comparePlatformAssumptions` 消费；格式都是“类别 → 文件 → 次数”，清单总和 350 与作者说法一致（我按条目逐项加过）。
   - **`INVENTORY_PATH`**：脚本内是 `scripts/platform-assumptions.json`，测试导入同一个常量，路径一致。
   - **退出码**：函数返回 0/1，CLI 把它赋给 `process.exitCode`，npm 按非零失败；但 CLI 这一端没有测试。
   - **不接受的地方**：`.github` 的 `arch: x64` 没有被 `arch-x64` 产生出来；shell 和 `sourceIdentity` 的固定主机名没有被 `fixed-hostname` 产生出来；无扩展名文件完全不被扫描；合法但为 `null` 的清单不能被 `comparePlatformAssumptions` 接受。

   按 I-73 的教训，不能只看“清单能和扫描对上”就结束：还要问扫描本身是否覆盖了目标写法、清单里的类别是否真能找到所有实际使用处。上述漏项就是两端没有对齐的地方。

## 未核实

- ADR 0253 所说“2026-11-12 在 ARM 机上用 bwrap 0.11.2 实测退出码 0”无法从当前仓库代码核实，仓库里没有对应证据文件。
- 测试和 `npm run check:platform-assumptions` 实际是否在当前树通过，未运行。
- 如果把 `arch-x64` 正则放宽，清单会增加多少处、是否会导致其他现有文件计数变化，未实际运行 `--write` 验证；按 `.github/workflows/ci.yml` 现有内容推测至少增加 4 处。
