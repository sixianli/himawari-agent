---
status: active
document_type: runbook
execution_risk: critical
contract_sha256: "sha256:53aa15707cbc4b56cab8846f97c5ef253e68492af1e40d3ddbea68db9ab5b753"
supersedes: ""
superseded_by: ""
date: "2026-10-27"
---

# 生产网页入口与登录 Runbook

<!-- runbook-contract:
- docs/adr/0089-web-push-only-owner-entry.md
- docs/backlog/BL-20261027-008-config-change-preflight-and-verified-rollback.md
- packages/platform-node/src/identity-gateway.ts
-->

本手册记录 2026-10-27 起生产网页怎样从公网打开、怎样登录，以及登录出问题时怎样查、怎样退回。起因是为了让 iPhone 收网页推送（Web Push，浏览器在网页关着时也能弹出的通知），生产入口从“Mac 上开 ssh 隧道访问 `127.0.0.1:8400`”改成了公网域名 `https://himawari.siyi.win`（[ADR 0089](../adr/0089-web-push-only-owner-entry.md)）。切换当天的两次停服见[工程案例 30](../engineering-casebook.md#case-login-switch-outage)。本手册里的时间都是日本时间（JST）。

## 阅读导航

- [适用范围](#scope)
- [权威来源](#authoritative-sources)
- [安全前提](#safety-and-preconditions)
- [目标现场只读检查](#live-state-preflight)
- [步骤](#procedure)
- [结果验证](#verification)
- [证据](#evidence)
- [回退](#rollback)
- [停止条件](#stop-conditions)
- [排障](#troubleshooting)

<a id="scope"></a>

## Scope

- 适用：用户在手机或电脑上打开生产网页、登录、开通知；Claude 排查“打不开”“登不进”“收不到通知”；改 Cloudflare Access（Cloudflare 提供的登录关卡）的登录方式或允许的邮箱；把登录方式退回 Himawari 自带登录。
- 不适用：Hermes 测试机的入口（`https://himawari-test.siyi.win`，见 [Hermes 控制中心升级 Runbook](hermes-control-center-upgrade-runbook.md)）；程序上线和回滚（按各次上线包执行）；服务器登录和内核（见[生产云服务器访问 Runbook](production-server-access-runbook.md)）。
- 目标：生产机 `84.247.157.41` 上的 `/etc/himawari/config.json`、`himawari-prod.service`、数据库里 `owner_identity_bindings`（主人和登录身份的绑定表）那一行、`cloudflared.service`（Cloudflare 隧道程序）；Cloudflare 账号 `341855223c647728540929c55d92ccc8` 下的隧道 `himawari-prod` 和 Access 应用 “Himawari”。

[返回导航](#阅读导航)

<a id="authoritative-sources"></a>

## Authoritative Sources

- 只用网页推送、入口改成公网域名并由 Access 认证的决定：[SOURCE: docs/adr/0089-web-push-only-owner-entry.md]
- 改配置和改登录方式也要走预检和可验证回滚：[SOURCE: docs/backlog/BL-20261027-008-config-change-preflight-and-verified-rollback.md]
- Access 身份怎样换成 Himawari 的主人：`packages/platform-node/src/identity-gateway.ts`。绑定用的引用是 `sha256:` 加上 `签发方地址 + 空字符 + 用户编号` 的 SHA-256；签发方是 `https://sinimite-work.cloudflareaccess.com`，用户编号是 Access 令牌里的 `sub`，同一 Cloudflare 账号下一个邮箱对应一个编号。每次登录还会带着 `CF_Authorization` cookie 去签发方的 `/cdn-cgi/access/get-identity` 核对编号。
- 网页端口什么时候打开：`apps/agent-service/src/service-main.ts` 的 `webEnabled`，`publicMode` 为真，或身份方式是 `built-in` 且配了 `http`。
- 现场配置以生产机上 `/etc/himawari/config.json` 的读回为准，不以本手册为准。

[返回导航](#阅读导航)

<a id="safety-and-preconditions"></a>

## Safety and Preconditions

- **入口的组成（2026-10-27 起）**：
  - `himawari.siyi.win` 经隧道 `himawari-prod`（编号 `5f2c1695-5510-4e12-a44a-85b33a12e87c`）转到生产机 `http://127.0.0.1:8400`。隧道令牌是用户自己用 `cloudflared service install` 装的，Claude 不读、不复制。
  - Access 应用 “Himawari” 拦在前面：策略 “Allow James only” 只放一个邮箱，会话 1 个月；登录方式只开了 One-time PIN（邮箱验证码，Access 往允许的邮箱发 6 位码）。应用 “Himawari public files (bypass)” 对 `manifest.webmanifest`、`sw.js` 和图标放行所有人，因为 iPhone 添加到主屏幕和注册推送时不带登录 cookie。
  - 生产配置：`publicOrigin` 是 `https://himawari.siyi.win`，`publicMode` 是 `true`，`identity.kind` 是 `cloudflare-access`（`audience` 是 “Himawari” 应用的 AUD，一串应用标识）。`bootstrap.enabled` 是 `false`。
- **允许的邮箱只有一个**。其他邮箱在 Access 登录页也能填，但 Access 不会给它发码，表现为“完全收不到验证码”。换允许的邮箱会换掉 `sub`，Himawari 就认不出主人，要按[步骤](#procedure)第 4 步重新绑定。
- **改 Cloudflare 账号设置要用户在对话里明确同意**（加减登录方式、改策略、改隧道），Claude 的自动权限检查也会拦。
- **服务按 Host 头核对来源**：只认 `publicOrigin` 的主机名。所以 Mac 上的 ssh 隧道 `127.0.0.1:8400` 在浏览器里不能用，生产机上 `curl http://127.0.0.1:8400/` 也会得到 403；本机检查要带 `-H "Host: himawari.siyi.win"`。回滚脚本 `scripts/delivery-mode/rollback-remote.py` 查首页时也按这个 Host 发请求。
- **最近认证**：批准需要“最近认证”的操作和删除对话时，Himawari 要求 5 分钟内登录过。用 Access 时这指的是 Access 登录时间，过期了就打开 `https://himawari.siyi.win/cdn-cgi/access/logout` 退出再登一次。
- **授权编号要两处一致**：服务每次启动都把授权编号（fencing token，只增不减）写进数据库 `deployments` 表和 `/var/lib/himawari/state/authority.json`。只换回数据库而不换镜像文件，启动会报 `PRODUCTION_AUTHORITY_MIRROR_MISMATCH`。回退时要么只撤回改过的那一行，要么把同一时刻的数据库和 `authority.json` 一起换回。
- 第一项现场改动是停服（`systemctl stop himawari-prod.service`），停服前要用户当次同意或已有覆盖这一目标和动作的授权。

[返回导航](#阅读导航)

<a id="live-state-preflight"></a>

## Live-State Preflight

生产机上没有 `sqlite3` 和 `node` 命令；只读查库用 `ssh root@84.247.157.41 'sudo -u himawari-prod python3 -I -' < 本地脚本`，脚本里用 `mode=ro` 打开 `/var/lib/himawari/state/data/product.sqlite`。`himawari-prod` 账号读不了 `/root`，脚本要从标准输入喂进去。

1. `systemctl is-active himawari-prod.service cloudflared.service`：两个都是 `active`。
2. `curl -s -o /dev/null -w '%{http_code}' -H 'Host: himawari.siyi.win' http://127.0.0.1:8400/`：200。不带 Host 头是 403，属正常。
3. 从外网 `curl -s -o /dev/null -w '%{http_code}' https://himawari.siyi.win/`：302，跳到 `sinimite-work.cloudflareaccess.com` 的登录页；`/manifest.webmanifest` 和 `/sw.js` 是 200。
4. 读配置的 `publicOrigin`、`publicMode`、`identity.kind`、`identity.audience`，不要打印 `secretRef` 指向的内容。
5. 只读查库：`owner_identity_bindings` 里 `owner:first-production` 那一行的 `external_subject_ref` 以 `sha256:` 开头（自带登录时是 `built-in:owner:first-production`）；`deployments` 的 `revision`、`fencing_token` 和 `authority.json` 里的相同；`web_push_subscriptions` 的行数（开过通知的设备数）。
6. 改配置之前：用当前版本自带的配置检查验新配置，例如 `/opt/himawari/releases/<当前版本>/lib/himawari-agent/node_modules/@himawari-agent/platform-node/dist/strict-configuration.js` 里的 `parseProductConfiguration`，用 `/opt/himawari/node/bin/node` 运行；检查不过就不停服。

[返回导航](#阅读导航)

<a id="procedure"></a>

## Procedure

1. **手机登录和开通知（用户自己做）**：Safari 打开 `https://himawari.siyi.win`，在 Access 页面填允许的那个邮箱，收邮件里的 6 位码填回去。进来后用 Safari 的“分享 → 添加到主屏幕”，从主屏幕图标打开，在设置里开通知，点“发送一条测试通知”。iPhone 只给添加到主屏幕的网页发推送。
2. **电脑登录**：浏览器打开同一地址，同样用邮箱验证码。Access 会话 1 个月，到期再登。
3. **加减 Access 登录方式或改允许的邮箱**：用户同意后在 Cloudflare Zero Trust 控制台（Access → Applications → Himawari → Policies 和 Settings → Authentication）改。One-time PIN 的编号是 `98dddcc9-cc1a-4e8f-bb99-d16322d147ed`；另有一个 “Cloudflare 账号登录” 方式，当前没用在 “Himawari” 应用上。
4. **重新绑定 Access 身份（换邮箱后，或从自带登录切到 Access）**：
   1. 用户用新邮箱过一次 Access，从 `https://sinimite-work.cloudflareaccess.com/cdn-cgi/access/get-identity` 或 Access 日志读出用户编号（`user_uuid`），算出 `sha256:` 引用。
   2. 按[目标现场只读检查](#live-state-preflight)第 6 步验新配置（`publicMode: true`、`identity.kind: cloudflare-access`、`audience`、`issuer`、`jwksUrl`）。
   3. 备份：`/etc/himawari/config.json` 复制到 `/root/cfaccess-<时间>/config.before.json`。
   4. 停服，再把数据库目录和 `authority.json` 一起复制到同一个 `/root/cfaccess-<时间>/snapshot/`。
   5. 装新配置；以 `himawari-prod` 身份执行一条 `UPDATE owner_identity_bindings SET external_subject_ref=<新引用>, bound_at=<现在> WHERE owner_id='owner:first-production' AND external_subject_ref=<旧引用>`，要求正好改 1 行。
   6. 启动，等日志里 `service.ready` 出现并且[结果验证](#verification)全部通过。等 150 秒还没好，按[回退](#rollback)处理。
   2026-10-27 成功的那次用的就是这套步骤，脚本留在当天 Claude 会话的临时目录（`switch-cfaccess-v2.sh`），没有提交进仓库。

[返回导航](#阅读导航)

<a id="verification"></a>

## Verification

- [目标现场只读检查](#live-state-preflight)第 1–3 步全部符合。
- 就绪日志（`journalctl -u himawari-prod.service`）里 `service.ready` 带 `"listenPort":8400`。没有这一项说明网页端口没开，多半是 `publicMode` 不对。
- 用户能从手机登录进去，数据库 `devices` 和 `product_sessions` 表多出这次登录的设备和会话。
- 开通知后 `web_push_subscriptions` 多一行；测试通知能在锁屏上看到。2026-10-27 13:16 iPhone 第一次收到测试通知。

[返回导航](#阅读导航)

<a id="evidence"></a>

## Evidence

- 2026-10-27 切换的备份和快照在生产机：`/root/cfaccess-20261027T035251Z/`（成功那次：`config.before.json`、`config.next.json`、`snapshot/` 里的数据库和 `authority.json`）、`/root/cfaccess-20261027T035109Z/`（因读不到 `/root` 失败那次）、`/root/config-backups/`、`/root/db-backups/`。
- 每次执行新建 `/root/cfaccess-<UTC 时间>/` 放备份和快照，不复用旧目录；过程结论记进当次的案例或 Backlog，不写进本手册。
- 不记录隧道令牌、Access 令牌、cookie、推送私钥或 `secrets/` 目录的内容。

[返回导航](#阅读导航)

<a id="rollback"></a>

## Rollback

触发：重新绑定或改配置后 150 秒内没有就绪，或就绪但[结果验证](#verification)不过。

1. **第一级：只撤回本次改动**。停服；把 `config.before.json` 装回 `/etc/himawari/config.json`；以 `himawari-prod` 身份把绑定那一行改回旧引用；启动。不动数据库其他内容，也不动 `authority.json`，因为这次启动领到的编号两处都写了，仍然一致。
2. **第二级：成对换回快照**。第一级起不来时停服，把 `snapshot/` 里的数据库和 `authority.json` 一起换回，再装回旧配置，启动。
3. 两级都起不来：停服，保留日志，交给 Claude 诊断，不再试第三种改法。
4. **退回自带登录**（Access 本身坏了、短期修不好时）：旧配置的 `publicMode` 是 `false`、`identity.kind` 是 `built-in`，绑定引用是 `built-in:owner:first-production`，用户名 `andy`。退回后浏览器仍从公网域名进，要过 Access 再登 Himawari 自带登录；若连 Access 也要绕开，还要把 `publicOrigin` 改回 `http://127.0.0.1:8400`，用户改用 Mac 上的 ssh 隧道 `ssh -f -N -L 8400:127.0.0.1:8400 root@84.247.157.41`，手机就收不到推送了。

回退后按[结果验证](#verification)检查，并读一次 `deployments` 和 `authority.json` 确认编号一致。

[返回导航](#阅读导航)

<a id="stop-conditions"></a>

## Stop Conditions

- 第 6 步的配置检查不过：不停服。
- 停服后发现快照没拍成（数据库或 `authority.json` 缺一个）：不改配置，直接启动回到原状。
- 启动报 `PRODUCTION_AUTHORITY_MIRROR_MISMATCH`：停服，不要放宽检查，按[回退](#rollback)第二级成对换回，或在备份镜像文件后把它改成和数据库一致。
- 要改 Cloudflare 账号设置而用户没在对话里同意：停下问。

[返回导航](#阅读导航)

<a id="troubleshooting"></a>

## Troubleshooting

| 现象 | 含义 | 处理 |
| --- | --- | --- |
| 收不到验证码，垃圾邮件里也没有 | 填的不是策略允许的邮箱，Access 不发码 | 换允许的那个邮箱；确实要换邮箱时按[步骤](#procedure)第 3、4 步 |
| 过了 Access 后又出现 Himawari 的用户名密码页 | 服务还是自带登录，或配置没生效 | 读配置的 `identity.kind`；要切到 Access 按[步骤](#procedure)第 4 步 |
| 网页提示“需要登录”，点登录无效或报未绑定 | Access 的用户编号和绑定行对不上（多半是换了邮箱） | 只读查绑定行，按[步骤](#procedure)第 4 步重新绑定 |
| 批准操作或删除对话时被要求重新认证 | Access 登录超过 5 分钟 | 打开 `/cdn-cgi/access/logout` 退出再登 |
| 外网打开是 Cloudflare 的 502/1033 错误页 | 隧道或服务没在跑 | 生产机上看 `cloudflared.service` 和 `himawari-prod.service` |
| 生产机本机 `curl http://127.0.0.1:8400/` 得到 403 | 没带 `publicOrigin` 的 Host 头，属正常 | 加 `-H 'Host: himawari.siyi.win'` 再试 |
| 就绪日志没有 `listenPort`，外网打不开 | 身份不是 `built-in` 而 `publicMode` 是 `false`，服务不开网页端口 | 把 `publicMode` 改成 `true`，按[步骤](#procedure)第 4 步走 |
| 测试通知点了没反应 | 不是从主屏幕图标打开的，或通知权限没给 | 删掉主屏幕图标重新添加，从图标打开再开通知；看 `web_push_subscriptions` 有没有新行 |

[返回导航](#阅读导航)
