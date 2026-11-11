## 结论（先给方案）

**推荐做“共享控制层 + 每人一个隔离运行时”的 bridge/silo 结构，不做“一个 Node 进程里塞 20 个 owner”。**

具体是：

- **共用**：Cloudflare Tunnel + Access（身份/邀请）、一个只做按身份路由和首次绑定的轻量入口、一个控制库（owner 名录/主机名/端口/状态/Magpie 密钥编号）、本机 Magpie 及 Andy 的上游套餐、共享向量模型（另一个 PR）、同一份发布包和提示词目录。
- **每人一份**：独立 `stateRoot`（`product.sqlite`、`runtime/execution.sock`、`cache`、`payload-ciphertext`、`secrets`）、独立配置、独立 authority、独立服务进程/systemd 实例、独立执行 Worker/沙箱账号接口、独立 Magpie **gateway key** 及其月度限额。
- **Andy 零搬运**：继续使用现有 `/var/lib/himawari/state`、现有 `ownerId/agentId/deploymentId`、现有 secrets 和现有提示词配置，不复制数据库、不换密钥、不新建对话；只新增控制库名录和 Magpie gateway key。这样请求开头最稳。
- **额度不写进代码**：用 Magpie 已有的 per-gateway-key 限额（token 或估算费用，按月/周/日，运行中可改）。Himawari 只负责把 key 用起来、把 `GET /v1/magpie/limit` 的结果显示给本人和 Andy，不自己实现额度数字。

这个方案的核心判断是：**代码现在已经按“一个配置 = 一个主人”组装，最安全的多 owner 化不是把 owner_id 贯穿所有共享路径，而是保留单 owner 组装，把“一个配置”复制成 N 份隔离运行时。** 这样 `runAgentService` 内部那 2000 多行几乎不动，Andy 的请求开头和数据库也最不容易被改坏。

---

## 一、方案依赖的前提

### 已由代码/一手来源确认

1. **当前配置只有一个主人、一个 stateRoot、一个库。**
   `packages/platform-node/src/strict-configuration.ts:1526-1537`：
   > `deploymentId: createDeploymentId(safeReference(input["deploymentId"], ...)), ownerId: createOwnerId(...), agentId: createAgentId(...), stateRoot, runtimeDirectory, cacheDirectory, publicOrigin, ...`

   `apps/agent-service/src/service-main.ts:739-741` 打开的是：
   > `databasePath: path.join(layout.data, "product.sqlite")`

2. **stateRoot 的目录和 uid 检查已经存在，适合作为每人隔离边界。**
   `packages/platform-node/src/state-root-layout.ts:103-120`：
   > `if (typeof process.getuid === "function" && info.uid !== process.getuid()) ... "State-root directory is not owned by the service account"`

   同一文件 `:129-143` 定义 `data/runtime/cache/payload-ciphertext`，`authority.json`、boot binding 都在 stateRoot 下。

3. **HTTP 层已经把身份状态和 owner 绑死，换成每进程一份配置即可天然隔离。**
   `apps/agent-service/src/production-http-composition.ts:720-723`：
   > `const ownerId = configuration.ownerId; const agentId = configuration.agentId; const identityState = scopedIdentityState(repository.ownerIdentityState(), ownerId);`

   `:347-374` 的 `scopedIdentityState` 对别的 owner 直接返回 `undefined` 或抛 `OWNER_NOT_BOUND`；`:417-423` 对消息 scope 和 `authentication.ownerId` 不一致返回 `THREAD_SCOPE_MISMATCH`。

4. **现在登录只允许绑定“第一个主人”。**
   `packages/persistence-sqlite/src/sqlite-durable-operations.ts:4756-4789`：
   > `if (bindingCount !== 0) this.fail("PORT_CONFLICT", "Owner bootstrap has already been consumed");`

   `packages/platform-node/src/identity-gateway.ts:603-605` 在找不到 active binding 时抛 `OWNER_NOT_BOUND`。

5. **每个 product.sqlite 现在就是 1 写 + 最多 3 读 worker。**
   `packages/persistence-sqlite/src/product-state-repository.ts:162`：
   > `const READ_WORKER_COUNT = 3;`

   `:234-275` 启动 writer 和 read context；`packages/persistence-sqlite/src/sqlite-execution-context.ts:109` 用 `new Worker(...)`。所以“每人一个库”也意味着每人一组 SQLite worker 线程，内存评估必须把这部分算进去。

6. **发给模型的开头有硬规则：只追加，系统提示/工具按对话冻结。**
   `.claude/rules/prompt-prefix.md:27-28`：
   > “固定的在前，会变的在后……每轮都会变的内容只放在最后一条用户消息里。”

   `:35`：
   > “已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。”

   `:41`：
   > “系统提示和工具按对话冻结……同一对话一直沿用第一次发出时的字节。”

7. **提示词目录里没有 `ownerId/agentId/deploymentId/stateRoot/publicOrigin` 这些值；运行环境说明只在最后一条消息。**
   在 `packages/prompt-catalog/src` 中搜索这些字段未发现用于系统提示/工具定义；ADR 0164 决定运行环境块 `ref` 固定、放在最后一条用户消息的资料段末尾：`docs/adr/0164-move-changing-values-out-of-the-request-head.md:64-66`。

8. **Magpie 本身已经提供 gateway key 和按 key 的 token/费用限额，且运行中可改。**
   Magpie 官方参考 `https://github.com/yetone/magpie/blob/main/docs/reference.md`（本次读到的是 main 分支 raw 文本）：
   > “Each gateway key can have its own **limit**: a token total, an estimated cost in US$, or both, per day, week or month (calendar windows in local time...).”

   > “Once a key is spent, its requests are refused before any provider is asked, with a 429... other keys are unaffected.”

   > “A key can read its own status with `GET /v1/magpie/limit`; it is told its own and no other key's.”

   > “A request in flight holds a reservation... so requests sent at once overshoot by about one call.”

   这条很关键：**额度最好交给 Magpie，而不是在产品里重新实现一套预算。**

9. **业界同类做法：共享入口 + 每租户独立存储是成熟的 bridge/silo 组合。**
   AWS SaaS Lens：
   > “While the web tier is shared, the underlying business logic and storage of our application are actually deployed in a silo model where each tenant has its own application tier and storage.”
   https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/bridge-model.html

   Turso：
   > “Tenant A's data literally cannot appear in Tenant B's queries because it lives in a different database.”
   https://turso.tech/blog/multi-tenancy-at-scale

10. **Cloudflare Access 会把验证过的 JWT 放在 `Cf-Access-Jwt-Assertion`，Tunnel 可以按公开主机名转发到本机端口。**
    https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
    > “When Cloudflare sends a request to your origin, the request will include an application token as a `Cf-Access-Jwt-Assertion` request header.”

    https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/
    > “Cloudflare Tunnel allows you to publish local applications to the Internet via a public hostname... points `docs.example.com` to `https://localhost:8080`.”

11. **systemd cgroup 可以给每个 owner 单独设内存和重启边界。**
    https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html
    > “`MemoryMax=` ... If memory usage cannot be contained under the limit, out-of-memory killer is invoked inside the unit.”

    > “`MemoryHigh=` ... memory usage may go above the limit if unavoidable, but the processes are heavily slowed down...”

### 推测 / 未核实

- 生产 Magpie 当前版本是否已支持 `gateway-key limit`。ADR 0117 记录生产装的是 `v0.1.2001`（`docs/adr/0117-magpie-routes-models-through-owned-subscriptions.md:38`），而上面的参考文档是 main 分支，可能更新。**必须先在生产的 Magpie 上执行 `magpie gateway-key list` / `magpie gateway-key limit <id> list` 核实；不支持就先升级 Magpie，或临时用透明配额代理。**
- Cloudflare Access 是否支持 `*.example.com` 的 wildcard 应用；不支持就退回“一 host 一个 Access app”，路由器按控制库里的 `audience` 逐 owner 验签。
- 20 个进程在这台 4 CPU / 8 GB 机器上的实际 RSS、SQLite worker 线程数、Pi 文件准备线程的额外内存（仓库里已有一个 worker 空闲增量约 110 MiB 的测量，见 `docs/architecture-v0.1.md:480-490`，但那不是 20 个服务进程的生产测量）。
- Google OAuth 客户端能否登记 10–20 个 per-owner redirect URI；未实测。
- 生产 `cloudflared` 的 ingress 能否热重载；不行就必须用共享路由器或短暂重启 tunnel。

---

## 二、方案本身

### 1. 共用层和每人一份的边界

| 层 | 共用 | 每人一份 |
|---|---|---|
| 代码 | 同一份发布包、同一套提示词目录、同一套 Pi 适配器 | 不复制代码 |
| 入口 | Cloudflare Tunnel + Access；一个按 Host/JWT 路由的轻量入口 | 每个 owner 一个子域名（`alice.himawari.example`） |
| 身份 | Access 团队、JWKS、邀请名单；控制库里的 `sub → owner` 名录 | `product.sqlite` 里的 session/device；每人自己的登录会话 |
| 数据 | 无共享产品库 | `<stateRoot>/data/product.sqlite`、payload、memory、Gmail 状态、push 订阅 |
| 密钥 | 只共享“密钥的目录/管理方式”，不共享密钥材料 | `payload-encryption`、`identity-csrf`、web-push、Magpie gateway key |
| 权威 | 无共享 authority | 每人自己的 `authority.json`、deployment、epoch/fence |
| 进程 | 入口/控制库/Magpie/向量模型 | 每人的 agent-service 进程、execution worker、sandbox 账号 |
| 模型 | Andy 的 Magpie 上游套餐 | 每人一个 Magpie gateway key，限额按 key 设置 |
| 资源 | systemd slice、磁盘/监控 | 每 unit 的 `MemoryHigh/MemoryMax`、`CPUWeight`、独立重启 |
| 后台任务 | 共享调度器只负责“什么时候叫醒”，不共享任务状态 | 主动查邮件、记忆整理、推送都在各自进程/库里 |

### 2. 入口、登录和“A 读不到 B”

**选每个 owner 一个子域名，不选同一域名下的路径前缀。** 原因：cookie `himawari_session` 是 host-only；如果共用域名，`Path=/u/alice` 之类的路径隔离不能阻止同源 cookie 被带到别的路径，session 语义会被搅乱。子域名天然隔离 cookie、Service Worker、静态缓存和 Access 应用。

入口有两种可选实现：

- **推荐：一个共享 router。** Cloudflare Tunnel 把 `*.himawari.example` 指到 router；router 用 `CloudflareAccessJwtVerifier` 验 `Cf-Access-Jwt-Assertion`，读控制库，按 Host + `sub` 找到 owner，再转发到 `127.0.0.1:<port>`。
- **备选：cloudflared 每 owner 一条 ingress。** 没有 router，但每次加人要改 cloudflared 配置并 reload；验签仍由每个 owner 服务做。

router 的规则：

1. 控制库里的 owner 状态必须是 `active`；`disabled` 一律 403。
2. 请求 Host 必须等于该 owner 的 `hostname`。
3. JWT 的 `sub` 必须绑定到这个 owner；首次登录允许在 `invited` 状态下用 Access 已验证的 `email` 匹配邀请记录，然后把 `external_subject_ref = sha256(issuer + "\0" + sub)`（和 `identity-gateway.ts:213` 完全同一算法）写入控制库并转为 `active`。
4. **router 和每个 owner 服务都重新验 JWT**；owner 服务不再只信 router 的结论。
5. **router 明确拒绝 `/bootstrap`、`/break-glass` 和任何非白名单内部路径。** 这是本方案必须写死的安全边界：现在 `OwnerBootstrapService` 和 `BreakGlassService` 用 `request.ip` 判断 loopback（`identity-gateway.ts:544-547`、`:808-813`）；一旦前面有反代，所有请求看起来都来自 127.0.0.1，如果不拦，公网就能打 bootstrap/break-glass。
6. owner 服务配置里把 `identity.bootstrap.enabled` 设为 `false`，bootstrap 改由控制库/provisioning CLI 完成；`/bootstrap` 仍要由 router 拦截作为第二道门。

每个 owner 服务的 HTTP 组合继续使用现有的 `ProductionThreadGatewayAccessPolicy` 和 `scopedIdentityState`，只把 identity state 的来源从“自己 product.sqlite 的 owner_identity_bindings”换成**控制库的只读适配器**。这样：

- owner 服务只拿到自己 ownerId 的 binding；`scopedIdentityState` 仍然会拒绝别的 owner。
- 首次绑定由 router/控制库完成，owner 服务无需开公网 bootstrap。
- Andy 的现有 binding 一次性原样复制到控制库（`owner_id`、`external_subject_ref`、`bound_at`、`status` 不改），登录体验不变。

### 3. 每人一个 stateRoot、数据库和密钥

新建 owner 的目录建议：

```text
/var/lib/himawari/owners/<slug>/
  state/
    data/product.sqlite
    data/payload-ciphertext/
    runtime/execution.sock
    runtime/*.boot.json
    cache/
    secrets/
  config.json
```

- `<slug>` 只用于路径、systemd 实例名、Unix 用户/组名；限定 `^[a-z0-9][a-z0-9-]{0,31}$`。`ownerId` 仍用机器标识格式，不能直接拿来做路径/unit 名。
- `stateRoot` 必须是规范化的绝对路径，不能是另一个 owner 的 stateRoot 的子目录或父目录；创建后 `0700`，属主是该 owner 的服务账号。Andy 继续用 `/var/lib/himawari/state`，属主仍是现有 `himawari-prod`。
- 新 owner 生成独立的 `payload-encryption`、`identity-csrf`、web-push 等 secret。`payload-encryption` 同时派生出口遮盖密钥（`production-model-egress.ts:69-85`），所以**一旦生成就固定，不为“换 key”随便轮换**；轮换会让该 owner 老对话的遮盖字节变化，属于缓存断裂事件。
- `SqliteProductStateRepository.open` 会执行迁移并拿 stateRoot 锁；每个 owner 独立迁移。一个 owner 迁移失败只让该 unit 起不来，不影响别人的库。
- 继续用现有 `runAgentService` 和同一个 `main.ts`，只是给每个 unit 传不同的 `--config`。不需要把 2000 行函数拆成多租户上下文。
- 每个 owner 一个 execution worker，`runtimeDirectory` 指向自己的 `state/runtime`。`waitForWorkerBootBinding` 要求 worker 的 `workerInstanceId` 精确等于 `execution-worker:${deploymentId}`（`service-main.ts:418`），所以 provisioning 必须同时生成匹配的 `deploymentId`、`runPolicy.coding.workerInstanceId` 和 worker unit。执行命令的独立系统账号/沙箱由并行块接在这个接口上。

**服务进程隔离**：

- 用 systemd 模板 `himawari-owner@.service`，每个活跃 owner 一个实例；`Restart=on-failure`、`MemoryHigh=`、`MemoryMax=`、`CPUWeight=`（具体数值由 Andy 按测量配，不写进代码）。
- 非 Andy 的 owner 建议独立 Unix 用户（`himawari-<slug>`），stateRoot 属主为该用户；这样即使应用层有漏路径的 bug，A 的进程也读不到 B 的 `product.sqlite`、secrets 和 payload。Andy 保持 `himawari-prod`，避免 chown 现有数据。
- 共享 router、控制库、Magpie 仍是单点：它们挂了会影响入口/登录/模型调用，但不会改坏任何一个 owner 的数据库；数据面和故障面是分开的。

### 4. 模型路由与每月上限

**用 Magpie gateway key，每个人一个；不新写配额代码。**

- 每个 owner 的配置文件仍写 `provider: "magpie"`、`baseUrl: http://127.0.0.1:3425/v1`，只把 `secretRef` 指向自己的 gateway key。Magpie 只监听本机；gateway key 只出现在 `Authorization` 头里，不进入请求体，所以不影响 KV 缓存前缀。
- Andy 的上游 OpenCode Go/CodeBuddy/Grok 账号仍然共用；gateway key 只负责“这条请求是谁的”。
- 月度上限在 Magpie 侧配置，例如：
  - `magpie gateway-key limit <id> month --tokens <N>`
  - 可选再加 `--cost <X>`；但 Magpie 明确说“Cost is an estimate at the Usage page's prices; a call with no known price adds none”，所以**只靠 cost 会被未知价格模型绕过**，主限制建议用 token，cost 作为辅助。
  - 需要把缓存读也计入时，打开该 key 的 “Count cache reads too”；否则大量缓存命中不计入 token。这个取舍由 Andy 定。
- 运行中改额度：直接改 Magpie key 的 limit，下一次请求生效，不需要重启任何 Himawari 服务。代码里不出现默认额度数字；provisioning CLI 必须显式要求 Andy 给邀请者传 `--tokens`/`--cost`，`NULL` 表示不限。
- 本人可见：owner 服务的设置页增加一个只读接口，用该 owner 的 gateway key 调 `GET /v1/magpie/limit`，显示 limit/used/left/reset；调用失败就显示“暂时无法读取”，不影响聊天。Magpie 的 `/me` 也可以作为兜底。
- Andy 可见：`magpie gateway-key limit <id> list` 和 `magpie usage --last 30d`；如果要做网页总览，再加一个只读 admin 页，不在第一版必需。
- 超限时：Magpie 返回 429，owner 服务把它翻译成明确的“本月额度已用完/何时重置”，并在 UI 显示；不能让用户看到笼统的模型失败。其他 owner 的 key 不受影响。
- 每人一个 key 也方便停用：`magpie gateway-key disable <id>` 或 remove，立即断掉该 owner 的模型访问，不必停整个程序。

### 5. Andy 的零搬运迁移

1. 在控制库中新增 Andy 的记录：`owner_id`、`external_subject_ref`（从现有 `product.sqlite` 的 `owner_identity_bindings` 原样读出）、`hostname`、`port`、`stateRoot=/var/lib/himawari/state`、`magpie_key_id`。
2. **不改**他的 `ownerId`、`agentId`、`deploymentId`、`stateRoot`、`secrets`、`runPolicy`、模型引用、工具开关、时区、提示词目录版本。
3. 为 Andy 建一个 Magpie gateway key（可以不设 limit，或按他拍板设）；只改配置里的 secret 值/引用，不改模型、工具、系统提示。
4. 用正常重启切换到同一个 stateRoot；authority 会重新领取，数据库和对话不动。上线前确认没有挂起的 run（现有部署规则）。
5. 如果暂时不想动 Andy 的入口：保持他现有的 unit/端口/ssh 入口不变，router 只服务新 owner；这样连 `publicOrigin`、Gmail redirect URI、web push 链接都不变。**这是最稳的 cutover。**

### 6. 内存和故障隔离

- 第一版不做“20 个 owner 都在一个进程里”。一人一进程，systemd cgroup 做 `MemoryHigh/MemoryMax`；一个进程 OOM 只死该 unit。
- 允许按需冷启动：控制库/入口记录 owner 最近活跃时间，空闲 owner 的 unit 可以停止，首次请求时由 router `systemctl start` 后再转发（冷启动延迟要接受）。后台主动任务需要单独调度器在计划时间叫醒该 owner。是否启用由测量结果决定。
- 每个 owner 的 `concurrency.totalRuns` 仍来自自己的配置；这会失去原来“全局一个 totalRuns”的上限。第一期给邀请者设较小的每人并发（例如 1，具体由 Andy 配），并观察 4 CPU 的争抢；如果不够，再在控制层加共享并发租约。**这是本方案的一个真实缺口，不能假装每人 totalRuns=3 还等于全局 3。**
- 主动任务按 ownerId 做确定性错峰，避免 20 个 owner 同一分钟一起醒来。
- 每人一个库也意味着磁盘要按人计量；一个 owner 写满磁盘会影响所有人。至少加每 owner 磁盘用量监控和告警；文件系统项目配额/每用户 quota 作为后续。

---

## 三、拆成可以单独合并的步骤

### 第 1 步：控制库 + provisioning CLI + 契约检查（不改运行时）

新增 `/var/lib/himawari/control/owners.sqlite` 和 `owner` CLI：

- `owner add`：生成 `slug/ownerId/agentId/deploymentId/stateRoot/port/hostname`，写 `invited` 行；生成配置模板、stateRoot、secrets、Magpie key。
- `owner bind`：把 `external_subject_ref` 绑定到 owner。
- `owner disable/enable/remove`：只改状态、停/起 unit、启/停 Magpie key。
- `owner check`：逐项核对生产者和使用者的校验。

**证明没改坏单人使用**：不改 `runAgentService`、不改提示词；跑现有全量测试。新增 `npm run check:owner-registry`：用 CLI 实际生成的值依次过 `parseProductConfiguration`、`createOwnerId/createAgentId/createDeploymentId`、SQLite 插入、systemd slug 校验、Magpie key id 存在性检查。

**反向用例**：`ownerId` 带 `@` 或 `/` 必须在写文件前失败；`stateRoot` 嵌套、端口 0、重复 hostname、重复 `external_subject_ref`、Magpie key id 不存在、limit 为负都必须失败。这直接对应 I-73 的教训：不只看 diff，要把“清单里的 id”交给真正的后端校验。

### 第 2 步：第二个 owner 的运行时（不动 Andy）

- 加 `himawari-owner@.service`（或等价 unit 生成器），同一发布包、不同 `--config`。
- 给 `createProductionHttpComposition` / `runAgentService` 增加可注入的 `identityState`（默认仍是 repository，单 owner 测试不受影响）；多 owner 时传入控制库只读适配器。
- 用两个临时 owner、两个真实 SQLite、一个假 Magpie stub，同时启动两个 `runAgentService`。

**证明没改坏单人使用**：现有单 owner 集成测试全部照跑；新测试断言两个进程各自启动、各自迁移、各自监听端口。

**A 读不到 B**：A 的 HTTP 会话用 B 的 threadId 取不到；A 的消息 scope 伪造为 B 被 `THREAD_SCOPE_MISMATCH` 拒绝；A 的 repository 只打开 A 的 `product.sqlite`；A 的 payload 密钥解不开 B 的 ciphertext。

### 第 3 步：入口、Access、首次绑定、bootstrap 封锁

- 部署 router（或 cloudflared 分 host ingress），配置子域名/Access。
- router 实现 Host + JWT + 控制库路由；首次登录按已验证 email 绑定 `external_subject_ref`。
- owner 服务关闭 bootstrap；router 拒绝 `/bootstrap`、`/break-glass`。

**证明**：A 的 JWT 打 A 的 host 正常；A 的 JWT 打 B 的 host 403；无 JWT 403；从公网打 `/bootstrap` 404/403；cookie 在 A/B 子域之间不共享（浏览器测试）。

**反向用例**：先把 `/bootstrap` 透传，测试必须能观察到“公网请求被当成 loopback”；加上拦截后必须失败。这个反向用例能防止以后有人把 router 改成纯 Host 转发。

### 第 4 步：Andy 零搬运 cutover

- 控制库写入 Andy 现有 binding；创建 Andy 的 Magpie key；更新配置的 secret 引用；正常重启。
- 保留旧 unit/config 作为回滚目标；数据库、secrets、authority 文件不动。

**证明请求开头不变**：用旧版本和新版本分别对同一份 Andy 数据库副本/同一历史线程、同一个假模型服务抓原始请求体，比较系统提示、工具定义、历史、最后一条消息的前缀；要求逐字节相同。再跑 `npm run check:prompt-prefix` 和现有 `[PR-A]/[PR-B]` 原始请求体用例。

**反向用例**：故意把 owner hostname 或额度说明拼进系统提示，字节比较必须失败；故意换模型 provider/顺序，测试必须报告缓存断开（这是预期失败，不是放行）。

### 第 5 步：Magpie gateway key、限额和可见性

- 每个 owner 的配置只用一次自己的 gateway key；provisioning 检查 key 存在、启用、允许所需模型。
- 设置页读取 `/v1/magpie/limit`；超限 429 翻译成明确 UI 文案。
- Andy 用 `magpie gateway-key limit <id> list` 查看和修改；不写任何额度常量。

**证明**：给一个测试 owner 设很小的 token 限额，用满后该 owner 的请求 429，另一个 owner 不受影响；把限额调高后下一次请求恢复；UI 显示的数字和 Magpie CLI 一致。

**反向用例**：删掉配置里的 gateway key，测试必须发现“请求未带 key，按 Magpie 规则本机无 key 不限”；把额度写进代码常量，检查必须失败（或用代码审查+无额度模块的结构来保证）。

### 第 6 步：故障隔离、停用/增人、容量门禁

- systemd `MemoryHigh/MemoryMax`、`Restart=on-failure`、每 owner 独立 UID（非 Andy）。
- `owner disable`：控制库状态 disabled + router 拒绝 + 停 unit + 停 Magpie key；`owner add`：只起新 unit，不动别人。
- 测量空闲/单轮/并发时每 owner RSS、SQLite worker 数、Pi 准备线程、模型等待时间；再决定是否冷启动/减读 worker/后续合并成 worker thread。

**证明**：kill A 的进程，B 的 HTTP/对话仍正常；A 的库损坏导致 A 起不来，B 不受影响；A 的 cgroup OOM 只死 A；增加第三个 owner 不需要停 A/B。

**A 读不到 B**：用 A 的服务 UID 直接 `cat B/state/data/product.sqlite` 必须 permission denied（如果采用独立 UID）；如果第一版共用 UID，则明确记录这是应用层隔离，不作为 OS 级保证。

---

## 四、考虑过但不选的做法

1. **一个共享 `product.sqlite`，所有查询带 `owner_id`（pool）。**
   不选。表虽然大多有 `owner_id`，但 SQLite 没有 RLS，漏一个 `WHERE owner_id = ?` 就是数据泄露；中心化的 `authority_revision`、`totalRuns` 也要重做。每库隔离更符合当前代码结构，也符合 AWS/Turso 的成熟做法。

2. **一个 Node 进程里跑 10–20 个 owner 的 runtime。**
   暂不选。`runAgentService` 里有进程级信号处理（`waitForTerminationOrAuthorityLoss`，`service-main.ts:495-522`）、模块级单例、`process.getuid` 检查、每库 4 个 SQLite worker；一个 native crash/OOM 会拖死所有人。以后若测量证明进程开销是瓶颈，再把 `runAgentService` 抽成 `createOwnerRuntime(config)`，用 `worker_threads` + `resourceLimits` 或共享 SQLite pool 合并；那是第二步，不是第一步。

3. **把 Andy 的数据复制到新目录。**
   不选。保持原 stateRoot 可以完全避免复制 WAL、payload ciphertext、secrets、authority、Pi 历史时的字节风险；复制只用于备份/回滚。

4. **同一域名下用路径前缀区分 owner。**
   不选。同源 cookie、Service Worker、缓存和 CSRF 都容易串；子域名是更可靠的隔离边界。

5. **自己写一个模型配额代理。**
   不选（前提是生产 Magpie 版本支持 gateway key limit）。Magpie 已经有 per-key token/cost、窗口、预留、429、`/v1/magpie/limit` 和 `/me`；自建代理还要透明转发请求体，增加缓存字节和 SSE usage 解析风险。只有在生产 Magpie 版本不支持时才退回自建代理，并且代理必须逐字节透传 body。

6. **恢复 ADR 0076 删掉的产品内预算账本。**
   不作为月度 owner 限额的主实现。它历史上造成过全局累计上限把所有对话拦住；而且主动任务现在用 `UNMETERED_PERMIT` 绕过模型预算（`production-model-composition.ts:514-517`），embedding 也不走 `ModelUsageStorePort`。网络层 Magpie key 是唯一能覆盖所有付费调用的 choke point。按任务的上限仍可作为后续单独功能（BL-20261028-002）。

7. **每人用一把 Vercel AI Gateway key 设预算（ADR 0083 原方案）。**
   不选。现在路线是 Magpie + Andy 的订阅；Vercel per-key 预算不适合“所有人走 OpenCode Go、不按量付费 key”的新目标。Magpie gateway key 是当前等价的实现。

8. **把 Magpie gateway key 存在共享配置/控制库。**
   不选。key 是秘密，放各自 stateRoot 的 `secrets/`，控制库只存 key 的 id/名字和状态。

---

## 五、风险和反例

1. **反代打破 loopback 信任假设。**
   现有 `/bootstrap`、`/break-glass` 依赖 `request.ip` 是 loopback。router 一上，公网请求都会显示 loopback。必须禁用 bootstrap、router 拒绝这些路径，并加反向用例。否则这是最严重的安全回归。

2. **Magpie 的 cost 限额不是硬上限。**
   官方参考说未知价格的调用不计数，且并发请求会因预留而“overshoot by about one call”。因此：
   - 只用 cost 限额可能被未知价格模型绕过；
   - 只用 token 限额更稳；
   - 即使 token 限额，也可能超出约一次调用。若 Andy 要求“绝不超”，需要在 Magpie 前面再加一层精确代理，或把限额设得低于目标。这个取舍要拍板。

3. **本机无 key 调用不受限。**
   官方参考明确：“Requests from this computer that send no gateway key are not limited”。任何本机进程（包括被攻破的 owner 服务）都可以绕过 key 限额。缓解：
   - 生产 Magpie 只监听 loopback，并用防火墙限制；
   - 沙箱禁止访问 loopback；
   - 非 Andy 的服务用独立 UID；
   - 如果要防恶意用户，最终要把 Magpie 放到 Unix socket 或要求全局 key。当前“受邀的朋友”模型下这是残余风险，不是完全解决。

4. **20 个进程的内存没有测量，不能承诺。**
   每人有主进程 + 最多 3 个 SQLite 读 worker + 1 个写 worker；Pi 文件准备线程仓库内测过约 110 MiB 增量，但这不等于生产 20 实例。上线前必须做 cgroup 测量；放不下就冷启动、减读 worker、关闭未用功能，最后才考虑合并进程。

5. **全局并发上限丢失。**
   原来 `totalRuns` 是整服务一份，现在每 owner 一份。20 个 owner 各 3 路就是 60 路。模型等待不占 CPU，但工具执行、SQLite、内存会争抢。第一期必须给邀请者较小的每人并发，并把“是否需要共享并发租约”作为测量后的决定。

6. **Google OAuth redirect URI 是 per-host 的外部配置。**
   `proactiveRedirectUri(configuration.publicOrigin)`（`service-main.ts:1618`、`production-proactive.ts:61-62`）意味着每个新 hostname 都要在 Google OAuth 客户端里登记。没登记，Gmail 授权会失败。这是典型的“产生值的一端和消费值的一端分开校验”的 I-73 场景，必须在 provisioning 清单里检查。

7. **控制库和 router 是新的单点。**
   控制库挂了，所有登录和路由失败；router 挂了，所有外部访问失败。数据面不受影响。用 SQLite WAL、只读连接、systemd 自动重启、备份控制库来降低风险；如果要求更高可用性，再加一个只读缓存/fallback，但第一版不必。

8. **磁盘被一个 owner 写满。**
   每库隔离不隔离磁盘。需要每 owner 用量监控/告警；文件系统 quota 或项目配额作为后续。生产机历史上多次出现磁盘紧张（I-33），这个风险不能忽略。

9. **Magpie gateway key 轮换/删除的影响。**
   轮换只改 Authorization 头，不影响模型请求体；删除/停用会让该 owner 立即无法调用模型，但不会动数据。需要 UI 明确区分“额度用完”和“访问被停用”。

10. **per-owner 独立 UID 的运维成本。**
    20 个用户、20 个 unit、chown、备份权限；会增加运维复杂度。第一版可以只保证执行命令用独立账号，服务进程共用 UID；但那样“A 读不到 B”只是应用层保证。推荐非 Andy 用独立 UID，Andy 保留现有 UID。

---

## 六、需要 Andy 拍板的取舍

1. **进程模型**：先 accept “一人一进程 + systemd cgroup”，还是要求最终必须一个 OS 进程？我推荐前者；后者等测量后再评估 worker thread 合并。
2. **Andy 自己的额度**：不限额（`NULL`）还是也给一个上限？如果要显示用量，建议给 key 但不设 limit。
3. **额度单位**：只 token、只 cost，还是两者都设？我建议 token 为主、cost 为辅，因为 Magpie 对未知价格不记 cost。
4. **缓存读是否计入 token**：Magpie 有 “Count cache reads too”；计入更接近真实消耗，不计入更宽松。
5. **额度周期和时区**：Magpie 用本机 local time 的日历月；是继续用生产机时区，还是明确设为 Asia/Tokyo？时区改了会影响重置点。
6. **超限行为**：硬 429，还是允许只读/非模型功能继续？我推荐硬 429 + 明确 UI。
7. **非 Andy 的服务是否用独立 Unix 用户**：更强隔离 vs 更多运维。我推荐独立用户，Andy 保持现有。
8. **入口拓扑**：共享 router + wildcard Access，还是每 owner 一条 cloudflared ingress + 一个 Access app。我推荐共享 router；如果 wildcard 不支持，就按控制库逐 owner 验 audience。
9. **Magpie 升级**：如果生产版本没有 gateway-key limit，是否允许升级 Magpie 作为本块前置？不升级就只能临时自建透明配额代理。
10. **冷启动/停用空闲 owner**：是否接受“空闲一段时间后停止，首次访问再启动”的延迟？这是 20 人内存能否放下的关键。
11. **Google OAuth / Cloudflare Access 的外部配置**：每个新 hostname 是否都登记 redirect URI/Access 应用；谁负责这项检查。
12. **磁盘 quota**：是否为非 Andy 的 owner 设 per-owner 磁盘上限，还是先只做告警。

---

## 七、逐条回答必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**在 Andy 的路径上不会，前提是按本方案执行。**

- **系统提示**：不新增 owner 名称、子域名、额度、用量、时间、路径、版本号。每个 owner 仍用同一份 `packages/prompt-catalog`；Andy 的 `runPolicy.systemInstruction`、时区、工具开关原样保留。
- **工具定义**：不因 owner 变化增删工具。新 owner 可以按自己的配置有不同工具，但 Andy 的工具集合不变；不在同一对话中途换模型/推理强度/服务方。
- **历史消息**：每人一个库、一个进程，历史不合并、不重写。Andy 的 `product.sqlite` 不复制、不迁移，历史字节不变。
- **遮盖结果**：Andy 的 `payload-encryption` 不变；出口遮盖密钥由它派生（`production-model-egress.ts:69-85`），所以同一段文字仍遮成同样字节。新 owner 用自己的 key，彼此不同不影响 Andy。
- **模型请求体**：Magpie gateway key 只出现在 `Authorization` 头；不进入 JSON body。router 只做 HTTP 转发，不改 body。
- **每轮会变的值**：本方案不往系统提示/工具里加任何每轮变化的值。额度/用量只进 UI；如果以后要让模型知道额度，按规则追加到最后一条用户消息，不改系统提示。
- **唯一的例外要主动避免**：不要在 cutover 时改 Andy 的模型路由组/服务方、不要在 cutover 时改提示词目录版本、不要换 `publicOrigin`（如果保留旧入口）。换 provider 即使请求头相同也会整段重算缓存。

**回答**：是，仍然只在末尾追加；每轮会变的值仍只在最后一条消息里。Andy 的旧对话不会因为“拆成多人”而改开头。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**同一 owner 的同一对话内：不会。**

- 不新增时间戳、随机数、无序集合到模型内容。
- ownerId、deploymentId、hostname、额度、用量都不进模型内容；控制库的列表只用于路由/UI，若渲染也必须固定排序。
- 每个 owner 的 payload/遮盖 key 在 provisioning 时生成一次并固定；Magpie key 轮换只改 header，不改 body。
- 所有新增的 `createdAt/updatedAt`、limit reset 时间只在控制库/UI/Magpie 状态中出现，不出现在 prompt。

**跨 owner：会不同，且这是有意的。** 两个 owner 的遮盖 key 不同，同一段文字可能遮成不同字节；他们的对话本来就没有共享前缀，不需要跨 owner 复用缓存。反过来说，**不能**为了跨 owner 缓存而共用 payload/遮盖 key，那会把 A 的秘密暴露给 B 的遮盖规则。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

有，且要与 I-66/I-73 的做法一致：不是只测“清单解析”，而是把生成的值交给真正的下游校验。

| 检查 | 正向 | 反向（必须失败） |
|---|---|---|
| `npm run check:prompt-prefix` | Andy 的多轮请求逐字节追加；现有 `[PR-A]/[PR-B]`、`thread-run-lifecycle` | 把 owner hostname/额度拼进系统提示，字节比较失败；换 provider/模型，报告缓存断开 |
| 新 `test/integration/multi-owner-prompt-byte.test.ts` | 旧版本/新版本对同一 Andy 历史发出相同系统提示、工具、历史、最后消息前缀 | 注入 owner 字段、改 publicOrigin 到 prompt、改工具集合，必须失败 |
| 新 `npm run check:owner-registry` | CLI 生成的每个值过 `parseProductConfiguration`、`createOwnerId/createAgentId/createDeploymentId`、DB、systemd slug、Magpie key id | ownerId 带 `@`/`/`、stateRoot 嵌套、端口 0、重复 host、重复 sub、Magpie key 不存在、limit 为负，必须拒绝 |
| 新 `test/integration/multi-owner-isolation.test.ts` | A/B 两真实服务/两库，各自启动、各自迁移、各自登录 | A 读 B thread、A 的 JWT 打 B host、A 解 B ciphertext、A 用 B 的 Magpie key，必须失败 |
| 新 `npm run check:owner-quota` / 真实 Magpie 验收 | 带 key 的请求计数、超限 429、调高后恢复、UI 显示与 CLI 一致 | 删掉 gateway key 后测试发现“无 key 不受限”；把额度写进代码常量，检查失败 |
| 入口安全测试 | `/bootstrap`、`/break-glass` 从公网被拒；A/B cookie 不共享 | 临时透传 `/bootstrap`，测试必须能观察到公网请求被误认为 loopback |
| 故障隔离测试 | kill A、A 迁移失败、A cgroup OOM，B 仍服务 | 让 A/B 共用 stateRoot/DB，测试必须发现交叉写入或锁冲突 |

“反向用例真的会失败”要在 PR 里记录：先撤掉修复/防线，跑一次看到失败，再加回来通过；不是只写断言。

### 4. 每个产生/修改的值，使用它的地方都能接受吗？

下面是本方案新增/修改的值，以及两端的校验。**结论是：必须由 provisioning CLI 统一生成、统一过校验，不能手写配置文件。**

| 值 | 产生处 | 使用处 / 校验 | 结论 |
|---|---|---|---|
| `ownerId` | provisioning CLI | `createOwnerId` 的机器标识正则（`identifiers.ts:39-55`）；config 的 `safeReference`（`strict-configuration.ts:95-101`，允许 `:` 等）；SQLite `owners.id`/`owner_id`；HTTP scope/session | 用 `owner:<slug>` 这类同时满足两边的格式；不能用邮箱（`@` 不在机器标识允许集） |
| `agentId` | provisioning CLI | `createAgentId`、config、DB、session、worker binding | 与 ownerId 同规则，用 `agent:<slug>` |
| `deploymentId` | provisioning CLI | `createDeploymentId`、config、`authority.json`、boot binding、worker 的 `execution-worker:<deploymentId>`（`service-main.ts:418`） | 必须和 worker unit 完全一致；用生成值端到端测试 |
| `slug` | provisioning CLI | 路径、systemd 实例、Unix 用户/组、控制库 | 单独一套 `^[a-z0-9][a-z0-9-]{0,31}$`；不能直接用 ownerId |
| `stateRoot/runtimeDirectory/cacheDirectory` | provisioning CLI | `initializeStateRoot` 的绝对路径、`0700`、uid（`state-root-layout.ts:103-143`）；repository 的 `databasePath`/stateRoot lock；UDS 路径长度 | 禁止嵌套/重叠；路径短到 socket < 108 字节；Andy 保持原路径 |
| `listenHost/listenPort` | provisioning CLI | config 校验；Fastify `app.listen`（`production-http-composition.ts:1202-1206`）；cloudflared/router 目标；控制库唯一 | 只允许 `127.0.0.1`；邀请者用固定非 0 端口，拒绝 0 |
| `publicOrigin/hostname` | provisioning CLI | config 的 https origin 校验（`production-http-composition.ts:295-321`）；Access 应用；session origin 检查；Gmail redirect URI；web push 链接 | hostname 必须与 Host 路由一致；Gmail redirect 必须在 Google 控制台登记；Andy 可暂不改 |
| `externalSubjectRef` | router 首次绑定 / 从 Andy 旧库导入 | `sha256(issuer + "\0" + sub)`（`identity-gateway.ts:213`）；控制库唯一；`OwnerIdentityStatePort`；session 认证 | 必须用同一个哈希函数；加测试防两边算法漂移；格式 `sha256:<64 hex>` |
| `email`（仅首次绑定） | 邀请记录 | router 读 Access 已验证 email；控制库唯一 pending | 只用于首次 `invited → active`；绑定后以 `sub` 为准 |
| Magpie `key id` / key secret | `magpie gateway-key add` | `magpie gateway-key limit/disable/rotate <id>`；owner 配置的 secret；控制库存 id 不存 secret | provisioning 必须先 `gateway-key list` 确认 id 存在；secret 只写 stateRoot/secrets，0600 |
| Magpie `limit`（token/cost/period） | Andy 运行时 CLI/UI | Magpie 自己执行；`/v1/magpie/limit`；owner UI | 代码里不出现默认额度；token 为主，cost 注意未知价格；周期用本机 local time |
| `workerInstanceId` / `hostId` / `grantId` | provisioning CLI | `runPolicy.coding`、worker boot binding、`waitForWorkerBootBinding` 的精确匹配 | 必须 `workerInstanceId = execution-worker:<deploymentId>`；每人唯一 |
| `identity.issuer/audience/jwksUrl` | 共享 Access 配置 | config 校验（`strict-configuration.ts:716-729`）；JWT 验签；router 路由 | 单 wildcard app 就一个 audience；一 host 一 app 就控制库存 audience，router 按 owner 验 |
| `sessionCookieName` | 配置模板 | `identity-gateway.ts:1078-1082` Set-Cookie；浏览器 | 子域名不同可同名；若同域必须 per-owner 且仍不推荐 |
| `status`（invited/active/disabled） | provisioning/disable CLI | router 拒绝、owner auth 的 `binding.status`、systemd enable/disable、Magpie key disable | 状态转换要原子；`disabled` 必须在 router 和 owner 两侧都拒绝 |
| `schemaVersion`（控制库） | 控制库迁移 | CLI/router/owner 读取 | 严格版本，未知版本拒绝启动 |
| `modelRef` / 模型清单 | 配置模板 + Magpie `/models` | `modelRefString`、`check:model-ref-contract`、Magpie key 的 models 限制 | 不新增斜杠 id 的盲区；用 I-73 已有门槛；限制 key 可用模型时要测试 `group/himawari-main` 这类引用 |
| 额度窗口的 provider/model 匹配 | Andy 的 limit 参数 | Magpie 使用日志里的 provider/model，不是 Himawari 的 `magpie:group/...` | **不要用 model-scoped limit**，除非先在 Magpie 日志里确认匹配名；key-wide 最安全 |
| 磁盘/内存配额 | systemd/监控 | cgroup/文件系统 | 不是代码常量；由 Andy 按测量配 |

**特别提醒**：`stateRoot`、`port`、`publicOrigin`、`workerInstanceId` 这些值在“配置生成器 → 配置解析器 → SQLite/host/worker/Cloudflare/Google”之间有多个消费者。provisioning 必须一次性生成并做端到端 check；不要像 I-73 那样只测生成器或只测展示。

---

## 八、未核实清单（不要当成结论）

- 生产 Magpie 版本是否支持 gateway-key limit、`GET /v1/magpie/limit`、`/me`。
- 开启 Magpie “Share on local network” 后，生产端口 3425 是否只对 loopback/防火墙开放；gateway key 在 loopback 请求上是否同样计数。
- Cloudflare Access wildcard 应用是否可用；一 host 一 app 的 audience 路由是否更稳。
- cloudflared ingress 是否支持热重载；不支持时 router 是必需。
- Google OAuth 客户端可登记的 redirect URI 数量。
- 20 个进程的实际 RSS、SQLite worker 线程、Pi 准备线程内存；需要并行测量。
- 生产 4 CPU 下 10–20 人的共享并发策略是否足够；是否需要控制库级全局并发租约。
- 每 owner 独立 Unix 用户在这台机器上的运维成本（用户数、chown、备份、日志）。
- 现有备份/恢复/上线脚本对多 stateRoot 的覆盖程度；`scripts/delivery-mode` 目前明显是按单实例参数写的（`instances/andy-production.json` 只有一组 config/stateRoot），需要另开步骤扩展。
