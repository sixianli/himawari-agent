## 结论先行

增量提交 `d8d6ba53` 确实只改 ADR 0174，且把“CI 在自己的服务器上跑”的出处从 ADR 0173 改为 ADR 0160 是**正确的**：ADR 0160 决定 1 才是“Linux 检查改到 Hermes”，ADR 0173 讲的是资源上限。但被改的这一行仍有两处文档问题；另外几个测试缺口作者已承认未补。

## 对作者说法的核对

- “第 2 轮之后只加了一个提交，只改 ADR”：属实。`git show --stat d8d6ba53` 只改了 ADR，2 行增 1 行删。
- “出处改为 ADR 0160，并在关联文档加上 ADR 0160”：属实，链接路径存在。
- “第 2 轮其余意见没有改”：属实。`evidence.test.mjs`、新升级测试、`policySha256` 断言都没有新增或修改。
- “ADR 0174 里还有没有别处归错出处”：未发现其他 ADR 引用错误；但 `:88` 的“三个工作流停用/等新 CI 服务器”没有任何 ADR 或仓库记录支撑。
- “有没有引入新的文档和代码不一致”：代码侧没有；文档措辞有下述问题。

## 问题（按严重度）

### 1. 中：ADR 0174 对 ADR 0160 的概括过宽

- 文件:行：`docs/adr/0174-no-github-cache-and-one-day-artifacts.md:88`
- 问题：出处改对了，但“ADR 0160 定的‘CI 在自己的服务器上跑’不变”这一概括与 ADR 0160 的实际决定不符。
- 证据：
  - ADR 0160 `:64` 决定 1 只说：“**Linux 检查全部改在 Hermes 上跑**”。
  - ADR 0160 `:70` 决定 7 明确：“`quality.yml` 继续用 GitHub 托管的 `ubuntu-24.04`”。
  - ADR 0174 自己在 `:89` 也写：“`quality.yml` 的任务仍在 GitHub 自己的机器（`ubuntu-24.04`）上跑。”
- 建议：改成“`ci.yml`/`main.yml` 的 Linux 检查在 Hermes 上跑（ADR 0160 决定 1），`quality.yml` 仍用 GitHub 托管机（决定 7）”，或直接引用决定 1 和决定 7。

### 2. 中：ADR 0174 关于“三个工作流停用、等新 CI 服务器”的断言没有出处

- 文件:行：`docs/adr/0174-no-github-cache-and-one-day-artifacts.md:88`
- 问题：这句话把“三个工作流停用、Hermes 太慢、等新 CI 服务器”写成当前已接受状态，但仓库里找不到对应 ADR 或记录，且与现有 ADR 的叙述冲突。
- 证据：
  - ADR 0168 `:29`：“CI … 从 2026-11-04 起在 Hermes 上的自托管 runner 里运行”。
  - ADR 0168 `:33` 记录了 2026-11-05 在 Hermes 上的实际运行。
  - ADR 0173 `:31` 记录 2026-11-06 在 Hermes 上测量内存；`:60` 决定把整机资源都放开给 CI。
  - `git log --all --grep=停用/禁用/disable` 没有找到停用三个工作流的决定记录。
- 建议：补充该决定的真实来源（ADR、Backlog 或 Owner 记录）；否则删掉“等新 CI 服务器”这一具体说法，或明确标为“未入库的临时状态”。如果确实已停用，应新增/更新 ADR，而不是只在 0174 的后果里顺带写。

### 3. 低：1 天保留期没有真正的边界测试

- 文件:行：`test/tooling/evidence.test.mjs:199`
- 问题：现有过期测试用的是 31 天：
  ```js
  expect(() => exportEvidence({ ...input, now: input.now + 31 * 86_400_000 })).toThrow("EXPIRED");
  ```
  这个断言在旧的 30 天和新 1 天策略下都会通过。若 `export-evidence.mjs` 的保留天数退回 30 天，这个测试不会失败；也没有断言 `expiresAt`。
- 证据：`scripts/ci/export-evidence.mjs:110` 使用 `policy.retentionDays.reports * 86_400_000`，`:161` 用同一值生成 `expiresAt`；`test/tooling/evidence.test.mjs` 中没有任何 `expiresAt` 断言，也没有 2 天/24 小时的用例。
- 建议：补 3 个用例：2 天前拒绝、略少于 1 天接受、正好 1 天拒绝（因为代码是 `>=`）；并断言 `expiresAt === created + 1 天`。作者已承认此缺口。

### 4. 低：新升级测试缺反向边界，但代码本身能拒绝多余键

- 文件:行：`test/tooling/policy.test.mjs:697-711`
- 问题：只测了“30/7 被升级”和“14/7 被拒”，没有测“30/7 加多余键”、初始化路径、以及 `policySha256`。作者已承认未补。
- 证据：
  - `scripts/ci/check-policy.mjs:74-83` 用 `Object.keys(retention).length === 2` 加精确值判断；`ci/policy.schema.json:183-195` 又有 `additionalProperties: false` 和 `const: 1`。所以“30/7 加多余键”不会被升级，最终会被 schema 拒绝；这是测试缺口，不是功能错误。
  - 初始化路径在 `check-policy.mjs:989-991`：基准没有策略时读取工作区文件，升级函数同样会作用；代码上 14/7 仍会被 schema 拒绝，30/7 会被升级。
  - `policySha256` 仍取原始 `bytes`（`check-policy.mjs:1026`），与现有 `upgradeHostedRunnerPolicy` 的做法一致；但新测试没有像旧测试 `policy.test.mjs:695` 那样断言哈希。
- 建议：补“30/7 + 多余键被拒”“初始化时 30/7 被升级、14/7 被拒”两个用例；并显式断言 `policySha256` 仍是基准原始字节的哈希，防止以后误改成对升级后对象求哈希，破坏跨版本 handoff。

### 5. 推测：缓存检查对大小写敏感，可能被绕过

- 文件:行：`test/tooling/ci-optimization.test.mjs:19`
- 问题：`/^actions\/cache[@/]/u` 只匹配小写。如果 GitHub 解析 `uses` 时对 action 仓库名大小写不敏感，写成 `Actions/Cache@...` 可能绕过检查。
- 证据：这只是正则判断；未联网、未实测 GitHub 对 `uses` 大小写的实际行为，因此标为推测。
- 建议：若担心，可改为 `/^actions\/cache[@/]/iu`，或在检查前统一转小写。

## 读代码证实的 / 推测的

**读代码证实的：**

- 增量提交只改 ADR（`git show --stat d8d6ba53`）。
- ADR 0160 是正确的出处；ADR 0173 确实是资源决定。
- ADR 0174 `:89` 与 `:88` 的“CI 都在自己服务器”表述冲突。
- 所有保留期值 `1/1` 的生产者和消费者一致：
  - 生产：`ci/policy.json:361-363`、`ci/quality-policy.json:15`、`ci/policy.schema.json:188-192`、`scripts/ci/quality-policy.mjs:44`、`scripts/ci/check-policy.mjs:82`。
  - 消费：`scripts/ci/quality-policy.mjs:154,161,210`、`scripts/ci/export-evidence.mjs:110,161`、`check-policy.mjs:993`。
  - 这些消费者都接受正整数 `1`；schema 和 quality-policy 的常量都精确要求 `1`。
- `actions/cache` 从工具锁定清单删除后，消费者也同步了：`scripts/ci/install-tools.mjs:118-129` 的精确集合是 5 个，`test/tooling/toolchain.test.mjs:75` 期望 5；代码/工作流里已没有 `actions/cache` 调用。
- `test/tooling/evidence.test.mjs:199` 的 31 天用例无法区分 30 天和 1 天。

**推测 / 未核实：**

- “三个工作流在 GitHub 上停用、等新 CI 服务器”是实际 GitHub 状态，无法从仓库代码核实；只能确认仓库里没有对应决定记录。
- “已删除 801 个 artifact、删除失败 0、缓存为 0”属于 ADR 里的外部操作结果，仓库内无法核实。
- `Actions/Cache@...` 大小写绕过是否成立，未实测。
- 作者说“测试全过”未实跑（本次只允许读和 git 命令），只能按代码判断测试逻辑。

## 侧重检查

我优先查了错误路径、不可信输入、安全、资源耗尽和不可撤销操作：

- **错误路径 / 不可信输入**：`upgradeArtifactRetention` 只接受“恰好两个键且值为 30/7”的对象；`null`、数组、多键、其他值都原样返回，随后由严格的 JSON Schema（`additionalProperties:false`、`const:1`）拒绝。没有发现新的绕过路径。
- **安全**：改动只涉及 CI 策略、工具清单、测试和文档，没有引入秘密、命令拼接或新的外部输入执行路径。删除 `actions/cache` 后，`quality-policy.mjs` 仍通过锁文件映射校验每个 `uses`，缺失锁项会报 `CI_QUALITY_ACTION_LOCK_MISSING`。
- **资源耗尽**：不用缓存会增加每个任务的重复下载，但下载地址和数量由工具锁定清单限定，规模有界；ADR 已记录性能代价。1 天保留期降低存储占用，没有发现新的无界循环或大内存分配。真正的风险是证据保留窗口变短，属于有意取舍。
- **不可撤销操作**：代码本身不删除任何 artifact；ADR 声称的 801 个删除是仓库外的既成操作，无法核实。1 天保留会让失败诊断在 1 天后自动删除，且 `export-evidence.mjs` 用 `>=` 判断到期，属于不可逆的保留窗口缩短，ADR 已写明，但没有边界测试兜底。
- **错误信息可诊断性**：`upgradeArtifactRetention` 不升级时会走 schema 报错，错误里仍带 `retentionDays`，可以定位；没有静默放行。

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

不会。本次改动只涉及 `ci/`、`scripts/ci/`、`test/tooling/` 和 `docs/`；`packages/` 和 `apps/` 中没有引用 `ci/policy.json`、`ci/quality-policy.json` 或 `ci/toolchain-lock.json`。因此系统提示、工具定义、历史消息、遮盖结果都不受影响；也没有新增每轮变化的值。请求内容仍然只在末尾追加。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

不会。改动没有引入时间、随机数、无序集合或依赖前后文的遮盖。`policySha256` 取的是确定的 git 字节；升级函数返回的对象键顺序固定为 `reports`、`diagnostics`，且该对象不会进入模型请求。同一 run 的 `context.policySha256` 与其基准提交字节一致，`export-evidence` 和 `main-evidence` 的比较方式也一致。

### 3. 有没有对应的自动检查，反向用例会不会真的失败？

有，且大部分反向用例成立：

- 缓存/保留期：`test/tooling/ci-optimization.test.mjs:85-98` 检查三个工作流无缓存、每个上传步骤 `retention-days` 为 1；若加回 `actions/cache` 或改成 30，会失败。`usesGitHubCache` 的单元断言覆盖 `restore`/`save`。
- 策略升级：`test/tooling/policy.test.mjs:697-711` 的正向用例在旧代码上会因 schema 拒绝 30/7 而失败；反向 14/7 会被拒。逻辑成立。
- 工具锁定：`test/tooling/toolchain.test.mjs:75` 期望 5 个 Action；`install-tools.mjs:118-129` 用精确集合，重新加入 `actions/cache` 会失败。
- quality policy/workflow：`test/tooling/runner.test.mjs:360`、`test/tooling/quality-local.test.mjs:289`、`test/tooling/quality-policy.test.mjs:262` 都覆盖了保留期漂移。

缺口是：1 天过期边界没有被真正测试（31 天用例对 30 天也通过）；“30/7 加多余键”、初始化路径、`policySha256` 没有反向断言。作者已承认这些。

### 4. 改动产生的每个值，使用它的地方都能接受吗？

能，逐个核对结论如下：

- `retentionDays.reports/diagnostics = 1`：`ci/policy.schema.json`、`scripts/ci/quality-policy.mjs`、`scripts/ci/export-evidence.mjs`、`scripts/ci/check-policy.mjs` 都接受；GitHub `retention-days: 1` 也是合法值（离线无法实测，但所有本地校验都一致）。
- 工具清单从 6 项变 5 项：`install-tools.mjs` 的期望集合、`toolchain.test.mjs` 的长度、`quality-policy.mjs` 的 Action SHA 映射都同步了；没有残留的 `actions/cache` 使用方。
- `upgradeArtifactRetention` 输出 `1/1`：`validatePolicy` 通过；`policySha256` 仍绑定原始基准字节，`context.mjs`、`export-evidence.mjs`、`main-evidence.mjs` 三处比较方式一致，未发现两端校验不一致。
- 唯一需要注意的是：`policySha256` 绑定的是“旧的 30/7 原始字节”，而实际校验用的是升级后的 `1/1` 对象；这是现有 `upgradeHostedRunnerPolicy` 的既有设计，不是本次新引入的 bug，但新测试没有把这个设计锁住。
