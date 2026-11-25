---
status: active
document_type: runbook
execution_risk: high
contract_sha256: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
supersedes: ""
superseded_by: ""
date: "2026-11-01"
covers: ".agents/instructions/delivery-mode.md, apps/agent-service/src/production-muse-intake.ts, packages/platform-node/src/strict-configuration.ts, scripts/delivery-mode/rollback.sh"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# Muse 自动接收运行手册

本手册说明怎样把 Muse 的提醒数据自动推给 Himawari：Andy 在 Cloudflare 上要点哪些按钮、上线时要改什么配置、日常怎么查通道是否正常、怎么暂停和关闭、密钥怎么更换。决定的理由见 [ADR 0302](../adr/0302-decision-records-and-calibration.md)。时间一律日本时间（JST）。

<!-- runbook-contract:
- https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0162-receive-muse-data-through-a-service-token-and-an-app-secret.md
- apps/agent-service/src/production-muse-intake.ts
- packages/platform-node/src/strict-configuration.ts
-->

## 阅读导航

- [Scope](#scope)
- [Authoritative Sources](#authoritative-sources)
- [Safety and Preconditions](#safety-and-preconditions)
- [Live-State Preflight](#live-state-preflight)
- [Procedure](#procedure)
- [Verification](#verification)
- [Evidence](#evidence)
- [Rollback](#rollback)
- [Stop Conditions](#stop-conditions)
- [Troubleshooting](#troubleshooting)

<a id="scope"></a>

## Scope

- 适用：开通、检查、暂停、关闭、更换密钥的 Muse 自动接收通道。
- 不适用：Muse 那一侧怎么建定时任务和怎么拼请求（由 Muse 那边的会话负责，格式见 `/mnt/project-files/muse-auto-channel/schema-and-push-test.md`）。
- 目标：生产网页域名 `himawari.siyi.win` 上的路径 `POST /api/muse-intake/v1/batch`；生产机 `/etc/himawari/config.json` 与密钥目录。

<a id="authoritative-sources"></a>

## Authoritative Sources

- [SOURCE: https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0162-receive-muse-data-through-a-service-token-and-an-app-secret.md]
- 代码：`apps/agent-service/src/production-muse-intake.ts`（路径、认证、状态码、限流）、`packages/platform-node/src/strict-configuration.ts`（`runPolicy.museIntake` 的字段与密钥引用检查）。
- Cloudflare 服务令牌文档：<https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/>

<a id="safety-and-preconditions"></a>

## Safety and Preconditions

- 服务令牌的 Client Secret 和应用密钥都是密码：不要贴进聊天、日志或仓库；只交给 Muse 那一侧的定时任务配置。
- Muse 的定时任务把令牌和应用密钥写在任务定义里（`/mnt/project-files/muse-auto-channel/schema-and-push-test.md` 第 108、115 行），所以要按“Muse 一侧的模型和运行环境都能看到这两个值”来设防：令牌只放行这一个地址，只能追加写入；应用密钥单独在 Himawari 作废；两个密码分开保存；每 90 天更换；怀疑泄露就在 Cloudflare 撤销令牌并更换应用密钥。演练和真实上线用不同的令牌和应用密钥，演练用过的立即撤销，因为它们已经出现在 Muse 的对话里。
- 动生产机配置和重启服务属于上线，必须有 Andy 说“上线”，并由能连生产机的线程执行（见 [delivery-mode.md](../../.agents/instructions/delivery-mode.md)）。Andy 自己在 Cloudflare 网页上的操作不碰生产机。
- 先在 Hermes 测试机演练应用层（已通过）；Cloudflare 边缘层改在生产上线后用服务令牌和虚构数据实测。

<a id="live-state-preflight"></a>

## Live-State Preflight

上线前只读检查，任何一项不满足就不要开始[第二部分](#part-release)：

1. Andy 已完成[第一部分](#part-owner)，并确认拿到了 Client ID 和 Client Secret。
2. Hermes 应用层演练已通过；[验证](#verification)的 1–4（含 Cloudflare 边缘层）列入上线后验收清单，不是上线前条件。
3. 生产机 `/etc/himawari/config.json` 里还没有 `museIntake`，或其 `enabled` 为 `false`（读配置时不要打印任何 `secretRef` 指向的内容）。
4. 密钥目录 `/var/lib/himawari/state/secrets` 存在，权限 `0700`。

<a id="procedure"></a>

## Procedure

<a id="part-owner"></a>

### 第一部分：Andy 在 Cloudflare 上做的事

<a id="owner-token"></a>

#### 1. 建服务令牌

1. 打开 Cloudflare 的 Zero Trust，进入 **Access controls** → **Service credentials** → **Service Tokens**。
2. 点 **Create Service Token**。名字写 `muse-intake`（出问题时可以单独撤销它）。
3. **Service Token Duration** 选 1 年。
4. 点 **Generate token**。页面会显示 **Client ID** 和 **Client Secret**。Client Secret 只显示这一次，马上复制保存到密码管理器；不要发到聊天里。
5. 到 **Notifications** 里加一个 **Expiring Access Service Token** 提醒（到期前一周通知你），免得一年后通道悄悄断了。

<a id="owner-app"></a>

#### 2. 建只放行这条路径的 Access 应用

1. 进入 **Access controls** → **Applications** → **Add an application** → **Self-hosted**。
2. 应用名 `Himawari Muse intake`。
3. 公共主机名填 `himawari.siyi.win`，路径填 `api/muse-intake/v1/batch`。Cloudflare 在多个应用都匹配时以路径更具体的为准，所以现有的 “Himawari” 应用（保护整个域名）不受影响。
4. 加一条策略：名字 `muse-service`，**Action** 选 **Service Auth**，**Include** 选 **Service Token** 里的 `muse-intake`。
5. 保存。不要给这个应用加任何邮箱登录策略。

<a id="owner-hand-over"></a>

#### 3. 把东西交给 Muse 那一侧

- 在 Muse 的定时任务里让 POST 同时带三个请求头：`CF-Access-Client-Id`、`CF-Access-Client-Secret`（上面的两个值），以及 `Authorization: Bearer <应用密钥>`（应用密钥在[第二部分](#part-release)里生成，由上线线程用安全方式交给你）。
- 这三个头 Muse 能不能同时发，还没有在真实 Muse 上验证过；上线后实测时第一个要确认的就是它。如果 Muse 只能发一个头，停下来，不要放宽认证，找协调者重新定方案。

<a id="part-release"></a>

### 第二部分：上线时改配置和密钥

由有生产权限的线程在 Andy 说“上线”之后执行，并随上线包带上程序版本（迁移 0075 随版本自动执行）。

1. 在生产机生成应用密钥：`openssl rand -hex 32`，不要打印到日志。
2. 写入密钥文件 `/var/lib/himawari/state/secrets/<引用>.<版本>`（例如 `muse-intake.v1`）：目录权限 `0700`、文件权限 `0600`、属于服务账号；内容是密钥本身，首尾空白会被忽略。
3. 在 `/etc/himawari/config.json` 的 `secretReferences` 加一项 `{"ref":"muse-intake","version":"v1","purpose":"muse-intake","scope":"agent"}`（四项缺一不可，缺 `scope` 服务起不来），并在 `runPolicy` 加 `"museIntake":{"enabled":true,"secretRef":"muse-intake"}`。引用必须刚好一个、用途必须是 `muse-intake`，否则服务启动会拒绝配置。去掉密钥文件或引用再启动，会报 `HOST_SECRET_NOT_FOUND` 或 `CONFIGURATION_INVALID_VALUE`；`MUSE_INTAKE_RUNTIME_UNAVAILABLE` 只在引用存在但载荷保护器不可用时出现。目录或文件权限不对会报 `SOURCE_UNSAFE`。
4. 重启 `himawari-prod`，看日志启动成功。
5. 把应用密钥用安全方式交给 Andy，由他填进 Muse 的定时任务。

<a id="verification"></a>

## Verification

在任何机器上用 `curl`（不要把密钥写进命令历史，用环境变量）：

【Andy 2026-11-04 定】Cloudflare 边缘层不在 Hermes 测，改为生产上线后用服务令牌和虚构数据实测下面的第 1–4 步；Hermes 只演练应用层（已通过）。上线后验收清单必须包含这四步，跑完用设置里的“清除 Muse 数据”清掉虚构数据。

1. 不带任何头：应该被 Cloudflare 拦在登录页（301/302/403），说明边缘关着。
2. 带两个 `CF-Access-*` 头、不带 `Authorization`：应该是 **401 且没有响应体**，说明边缘放行、应用层拒绝。
3. 三个头都带、发一个空批 `{"sender_id":"muse","batch_seq":1,"sent_at_utc":"<现在>","items":[]}`：应该是 200，`accepted` 为 0。
4. 打开 Himawari 网页的“提醒”页，“Muse 对照”应显示“通道正常”。这是正向；反向是第 2 步的 401 和第 1 步的拦截。
5. 实测用的虚构数据，验证完用设置里的“清除 Muse 数据”清掉。
6. 上线后实测时用一批接近上限的数据实测：单个请求体上限 256 KB，一批最多 100 条、每条文本最多 8000 字符，全部写满会超过请求体上限而整批被拒（413）；Muse 一批要控制在 256 KB 以内。提醒条目（只限 `muse_proactive_item`）带 `gmail_message_id`（对应邮件的 Gmail 邮件编号）时，评价后会自动和 Himawari 检查过的同一封邮件配对；给 Muse 的定时任务说明里要写明每条提醒带上这个编号。请求体没超上限、但带了白名单之外的多余字段时，不会报 413，多余字段被直接丢弃，这是预期行为。

<a id="evidence"></a>

## Evidence

上线线程在交付报告里记录（不含任何密钥值）：Hermes 应用层演练结果；生产上线后验证 1–4 的 HTTP 状态码；配置改动前后的 `museIntake` 字段（只写 `enabled` 和引用名）；网页“Muse 对照”显示“通道正常”的截图。

<a id="rollback"></a>

## Rollback

- 程序回退：旧版本拒绝写入比自己新的数据库结构，所以不能只换程序；按上线回滚脚本（`scripts/delivery-mode/rollback.sh`）把数据库一起恢复到恢复点，恢复点之后收到的 Muse 数据会丢失。先按下面的“关闭”停收，可减少丢失。
- 功能回退：按[关闭](#pause-and-disable)。

<a id="stop-conditions"></a>

## Stop Conditions

- Muse 无法同时发三个请求头。
- 验证第 2 步返回的不是 401（说明边缘或应用层有一层没生效）。
- 服务启动因 `museIntake` 配置被拒绝：撤销这次配置改动，不要绕过检查。

<a id="troubleshooting"></a>

## Troubleshooting

<a id="daily-check"></a>

### 日常检查通道

- 网页“提醒”页的“Muse 对照”最上面一行：正常 / 可能中断（距上一批 ≥2.5 小时）/ 已中断（≥3 小时）/ 已暂停 / 还没收到。
- 已中断时会推一次通知（和“提醒”共用开关）。先查 Muse 的定时任务是否还在跑，再查服务令牌是否过期。
- 批次序号跳过时，页面会写“跳过 N 次”。Himawari 只在回复里给出 `expected_next_seq`，不主动补拉；要不要补发由 Muse 一侧按这个序号决定。第一批就从大于 1 的序号开始时不记“跳过”。

<a id="pause-and-disable"></a>

### 暂停、关闭和清除

- 暂停：设置 → 数据 → “暂停接收”。暂停后 Muse 发来的新数据回 423 被拒收，已收到的保留；再点“恢复接收”。
- 关闭：把 `runPolicy.museIntake.enabled` 改成 `false` 并重启，这条路径变回 404（上线操作）。
- 清除：设置 → 数据 → “清除 Muse 数据”（先确认）。只删自动收到的条目和对它们的评价，手工记的参考条目保留。
- 紧急停用不用等上线：在 Cloudflare 里把 `muse-intake` 服务令牌撤销（Revoke），边缘立刻拒绝。

<a id="rotation"></a>

### 更换密钥和服务令牌

- 应用密钥：生成新版本文件 `muse-intake.v2`，配置里的版本改成 `v2` 并重启，同时把新值填进 Muse；两边切换之间 Muse 的推送会 401，下一小时的批会补发。
- 服务令牌：到期前在 Cloudflare 的 Service Tokens 里点 **Refresh** 延长一年（不换值），或新建一个换进 Muse 并撤销旧的。
