---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-18"
covers: ""
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0057：一批独立缺陷合并跑一次第 1–2 层

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
  - [第 1–2 层按批运行（新）](#batch-layers)
  - [其余规则（不变）](#unchanged)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

开发时的测试分层（第 0 层定向测试、第 1 层 `npm run check` 静态检查、第 2 层受影响模块测试、第 3 层构建加完整 `npm test`、第 4 层真实产品路径）和各层的运行时机，写在 [ADR 0052 的测试层级](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0052-third-production-host-acceptance-exception.md#layers)里，由 [ADR 0056](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0056-cloud-server-also-test-host.md#unchanged) 原样沿用。其中第 1 层是“每次提交之前”，第 2 层是“一个缺陷或功能修稳定、准备提交时”，所以一批里的每个独立缺陷都要在提交前各跑一次第 1–2 层。

2026-10-18，R2-P2（同一轮的 `bash` 和写文件工具复用常驻沙箱）的第 4 层发现 4 个产品缺陷，按缺陷分别提交。缺陷 1 提交前的第 1–2 层在 Hermes（局域网里的 Linux 测试服务器）上用了 56 分钟，缺陷 4 用了 20 分钟；这期间 Hermes 上唯一的测试检出目录被占着，opencode（负责写代码和跑测试的编程代理）的下一个缺陷的修前修后运行只能排队。Claude 分析这次进度慢的原因后，建议一批缺陷叠好后只跑一次第 1–2 层，用户在 G146 同意（原话记在长任务目标文件 .agents/tasks/round2-tool-execution/goal.md）。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

<a id="batch-layers"></a>

### 第 1–2 层按批运行（新）

1. **每个缺陷仍然单独做第 0 层、单独提交。** 一个交付批次（一起交给审核或验收的一组修改，通常不超过 3 个互相独立的缺陷）里，每个缺陷照旧先写复现测试，在测试机上跑第 0 层：修前失败、修后通过；每个缺陷仍是一个独立的提交。
2. **第 1–2 层对叠好的最上面一版只跑一次。** 这一批的修改全部叠好后，对最上面那一版跑一次第 1 层和第 2 层（第 2 层覆盖这一批所有改动所在的测试组和相关集成测试文件）。通过后再按顺序逐个提交，每个提交创建后照旧立即推送。
3. **失败就回到第 0 层。** 第 1–2 层失败时，回到出问题的那个缺陷的第 0 层修好，再对新的最上面一版重跑第 1–2 层。
4. **提交说明照实写。** 每个提交的说明写明第 1–2 层跑在哪一版上（叠好的补丁组合的 SHA-256，或最上面那个提交），并写明这个提交本身没有单独跑过第 1–2 层。
5. **单个缺陷或单个功能不变。** 一批里只有一项时，仍是提交前跑一次第 1–2 层。
6. **第 3 层不变。**（2026-10-21 补充：哪些改动要单独跑完整第 3 层，由 [ADR 0064](0064-layer3-individual-trigger-scope.md) 细化——只在检查阶段运行的 `scripts/ci/` 脚本改成“对应检查步骤加 tooling 项目”，其余照本条。） 第 3 层仍在一批的最终版本上跑一次；[提前运行完整测试的情况](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0052-third-production-host-acceptance-exception.md#early-full)（例如改动涉及 Agent Service 与 Execution Worker 之间的通信协议）仍然适用：这样的改动放在一批的最上面，批次的第 3 层就是它自己的第 3 层。

<a id="unchanged"></a>

### 其余规则（不变）

除上一节外，ADR 0056 的全部决定不变，直接按它的各节执行：

- 测试和部署的位置：[ADR 0056 的测试和部署的位置](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0056-cloud-server-also-test-host.md#hosts)。
- 云服务器上的测试账号 `himawari-ci` 和它的限制：[ADR 0056 的云服务器测试账号](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0056-cloud-server-also-test-host.md#cloud-test-host)。
- 生产部署的限定主机验收：[ADR 0056 的限定主机验收](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0056-cloud-server-also-test-host.md#first-install-acceptance)。
- Hermes 的连接和目录：[ADR 0056 的 Hermes 连接和目录](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0056-cloud-server-also-test-host.md#storage)。
- 时限不放宽、其他各层的触发时机、提交推送：[ADR 0056 的不变部分](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0056-cloud-server-also-test-host.md#unchanged)。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

### 每个缺陷提交前各跑一次第 1–2 层（原规则，未采用）

每个提交都单独证明过能通过静态检查和受影响模块测试，以后按提交逐个排查问题最方便。代价是一批 N 个缺陷要跑 N 次第 1–2 层；2026-10-18 的两次分别用了 56 分钟和 20 分钟，期间测试机被占着。

### 一批叠好后只跑一次第 1–2 层（采用）

每个缺陷的第 0 层仍然单独证明它修好了自己的缺陷；第 1–2 层改成证明这一批合在一起没有带来格式、类型或模块间的问题。一批省掉 N−1 次第 1–2 层。代价见[后果](#consequences)。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 一批里中间的提交没有单独跑过 `npm run check` 和第 2 层。如果以后要逐个提交排查问题，中间某个提交单独检出时，有可能因为只在后面的提交里修好的问题而通不过检查；提交说明会写明这一点。
- `AGENTS.md` 的 “Test Trigger Timing” 改为引用本 ADR，写明一批独立缺陷的第 1–2 层合并运行；“Test and Production Hosts” 和 “Pushing Commits” 改为指向本 ADR，具体规则仍链接到 ADR 0056 的对应各节。
- 2026-10-18 的这一批（R2-P2 第 4 层发现的缺陷）里，缺陷 1、缺陷 4 已按原规则各自跑过第 1–2 层并提交；缺陷 3、缺陷 2 起按本 ADR 执行。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- 前序决定：[ADR 0056](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0056-cloud-server-also-test-host.md)、[ADR 0052 的测试层级](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0052-third-production-host-acceptance-exception.md#layers)。
- 更早的测试位置和测试时机决定（ADR 0038、0041–0047、0049–0052）原先由 ADR 0056 取代，现在一并由本 ADR 取代：文档校验要求取代者必须有效，所以它们的 `superseded_by` 都改指向本 ADR，内容不变。
- 当前架构：[SOURCE: docs/architecture-v0.1.md]

[↑ 返回阅读导航](#contents)
