---
status: active
document_type: adr
decision_status: accepted
supersedes: "https://github.com/sixianli/himawari-agent/blob/753fb139e1c2ef8d77cd578690239195113ff839/docs/adr/0253-support-linux-arm64-for-test-and-qualification.md"
superseded_by: ""
date: "2026-11-25"
covers: "scripts/ci/platforms.mjs, scripts/ci/run.mjs, scripts/ci/local.mjs, ci/policy.json, scripts/delivery-mode/make-packet.py, scripts/delivery-mode/hermes/builder-arm64.json, scripts/delivery-mode/check-template-neutral.py"
verified_at: "3a72c261385c1a6ce7061c8eb38c8784987c3f34"
---

# ADR 0290：linux-arm64 是生产平台

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [Andy 的原话](#owner-decisions)
- [决定](#decision)
- [0253 里仍然有效的部分](#kept)
- [后果](#consequences)

<a id="context"></a>

## 背景

[ADR 0253](https://github.com/sixianli/himawari-agent/blob/753fb139e1c2ef8d77cd578690239195113ff839/docs/adr/0253-support-linux-arm64-for-test-and-qualification.md) 让 Himawari 能在 linux-arm64（64 位 ARM 架构的 Linux）上跑检查、沙箱和资格验证，但规定 ARM 包只是“非生产候选”，安装和预检要拒绝它用于生产。当时 ARM 机（Oracle 东京）只是测试机。

现在原来的生产机（x86 云服务器）已退租，Andy 决定生产只放在这台 Oracle 东京 ARM 机上。上线包的生成已经改成从目标机器现场读出主机名、架构、服务账号等信息（PR 658），不再绑定某一台机器；剩下的拦路规则就是“ARM 不能出生产构建物”。

<a id="owner-decisions"></a>

## Andy 的原话

2026-11-25：“只往 Oracle 东京那台（131.38 开头）去发布 … 84.247 这一台就不要再去管了”。因此 0253 的“ARM 非生产”前提不再成立，不需要再问他。

<a id="decision"></a>

## 决定

1. 取消“ARM 包是非生产候选”这条规则。linux-arm64 的上线包按目标机器的架构生成，和 linux-x64 同等对待。
2. `scripts/ci/platforms.mjs` 承认 `linux-arm64` 是构建物平台。
3. `scripts/ci/run.mjs` 的 `selectCheck` 在本地运行（非托管 CI）时，给 `build` 检查补一个由 `linux-x64` 成员派生的 `linux-arm64` 成员（架构 arm64，运行位置 local）。`ci/policy.json` 不加 ARM 成员，所以托管 CI 仍然拒绝 linux-arm64 的构建、浏览器和测试（`CI_MATRIX_UNSUPPORTED`），ARM 也不进 GitHub 必过检查。
4. ARM 构建在目标机器上一个没有 sudo 权限的构建账号里做，布局见 `scripts/delivery-mode/hermes/builder-arm64.json`；x64 仍用 Hermes。

<a id="kept"></a>

## 0253 里仍然有效的部分

- 清点结果和 `scripts/platform-assumptions.json` 清单检查。
- 沙箱只读目录清单里对 `/lib64` 这类可选目录的处理。
- 工具链锁 `ci/toolchain-lock.json` 里有 `linux-arm64` 的下载物。
- 不改系统提示、工具定义和历史，模型已见过的请求开头不变。

<a id="consequences"></a>

## 后果

- 在东京机上出生产包前，需要构建账号 `himawari-build`、服务账号、`/opt/himawari/node/bin/node` 和资格验证公钥已经就绪，这些由东京机线程负责。
- 本地 `npm test` 在 ARM 机上可以走完整本地流程；托管 CI 行为不变。
- 还没在真实 ARM 机上跑过完整出包，第一次出包是首次真实验证。

[↑ 返回阅读导航](#contents)
