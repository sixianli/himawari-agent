I'll start by examining the diffs and understanding the changes.
## 发现（按严重度从高到低）

### 1. 中 — 新增的 `--artifacts` 命令参数没有被任何测试从 `main()` 入口真正执行
**文件:行**：`scripts/ci/publish.mjs:182`、`scripts/ci/publish.mjs:187-196`；`test/tooling/gate-lifecycle.test.mjs:360-383`；`test/tooling/main-confirmation.test.mjs:52-58`、`118-121`

**问题**：三处测试各自只覆盖了一半。`gate-lifecycle` 直接调用导出的 `publish({ artifacts: "omit" })`，不经过参数解析；`main-confirmation` 把 `publish.mjs` 整个 mock 掉，只断言 `main-confirm` 传了 `["--artifacts", "omit"]`：

```js
// main-confirmation.test.mjs:52-58
vi.mock("../../scripts/ci/publish.mjs", async (original) => ({
  ...(await original()),
  main: async (args) => {
    state.calls.push(`publish:${path.basename(args[1])}`);
    state.publishArgs.push(args);
  },
}));
```

如果 `parseArguments` 的允许列表里漏掉 `--artifacts`，或者 quality 模式的拒绝逻辑被删掉，这两组测试仍然全绿；真正运行时 `main-confirm.mjs` 会在发布步骤抛 `Invalid or duplicate argument: --artifacts`，只有等 CI 跑到 `main.yml` 才会暴露。

**建议**：在 `gate-lifecycle.test.mjs` 里用现有的 `entry("publish.mjs", [...])` 跑一遍真实 CLI：`--artifacts omit` 成功且磁盘上没有归档、`--artifacts drop` 退出 1、`--mode quality --artifacts omit` 退出 1。

### 2. 低 — quality 模式用真值判断，`--artifacts ""` 会被静默接受
**文件:行**：`scripts/ci/publish.mjs:187-189`；`scripts/ci/contracts.mjs:85-100`

**问题**：
```js
if (args["--mode"] === "quality") {
  if (args["--artifacts"]) throw new Error("CI_PUBLIC_ARTIFACTS_INVALID");
```
`parseArguments` 只拒绝“后面没有值”或“下一个参数以 `--` 开头”，空字符串是合法值：
```js
argv[i + 1] === undefined || argv[i + 1].startsWith("--")   // contracts.mjs:92-93
```
所以 `--mode quality --artifacts ""` 不会报错，和“quality 模式拒绝它”的说法不一致；而 check 模式同样的输入会因为 `??` 不吃空串而进入 `publish()` 后被拒绝。当前没有调用方传空串，属于边界不一致。

**建议**：改成 `if (args["--artifacts"] !== undefined) throw ...`。

### 3. 低 — ADR 0238 说 check-policy “只检查 `ci.yml`”，代码仍校验 `main.yml` 和 `quality.yml`
**文件:行**：`docs/adr/0238-ci-job-files-stay-on-the-ci-vps.md:64`；`scripts/ci/check-policy.mjs:1331-1339`

**问题**：ADR 新文字写“`scripts/ci/check-policy.mjs` 只检查 `ci.yml`”，但 `main()` 明确还做了：
```js
const mainWorkflow = readFileSync(path.join(root, ".github/workflows/main.yml"), "utf8");
validateMainWorkflow(mainWorkflow, lock);
validateCallerGrantsCalledPermissions(mainWorkflow, readFileSync(workflow, "utf8"));
...
validateQualityWorkflow(
  readJson(path.join(root, "ci/quality-policy.json")),
  readFileSync(path.join(root, ".github/workflows/quality.yml"), "utf8"),
  lock,
);
```
“上传/权限规则只针对 `ci.yml`”这个意思可以保留，但“只检查 `ci.yml`”作为事实陈述是错的，容易让后续维护者以为改 `main.yml`/`quality.yml` 不会被拦。

**建议**：改成“这些上传与权限硬规则只施加于 `ci.yml`；`main.yml` 和 `quality.yml` 另由 `main-workflow.mjs`/`validateQualityWorkflow` 校验”。

### 4. 低（推测）— 省略归档后，发布出的 `result.json` 里 `artifacts[]` 指向不存在的文件
**文件:行**：`scripts/ci/publish.mjs:91`、`scripts/ci/publish.mjs:120-123`

**问题**：代码只从 `reports` 里删掉归档，没有动 `result.artifacts`：
```js
if (report.kind === "artifact" && artifacts === "omit") continue;
...
const published = { ...result, reports: retained };
validateRecord("CheckResult", published);
```
`CheckResult` 的 schema 允许 `artifacts` 非空而 `reports` 里没有对应项（`ci/result.schema.json:220` 只要求 `reports` 至少 1 项），所以校验能过；但 `published.artifacts[].path`（例如 `runtime.tar.gz`）在发布目录里已经不存在。我在仓库内没有找到读 `main-public` 里该文件的消费者（只有 `main.yml:100` 原样上传、测试只读 `summary.json`/`failure.json`），所以目前不会坏；将来若有工具把发布后的 `result.json.artifacts[]` 当成“随产物一起存在的文件”校验，就会失败。

**建议**：在文档里明确 `artifacts[]` 在这里只表示“构建时产生过、摘要见 `summary.json`”，或发布时把这些条目标记为未随包发布；不要只靠隐含约定。

### 5. 低 — 新增的 runner 重装测试没有验证“已有运行目录被保留”，也没有验证真实组属主
**文件:行**：`test/tooling/ci-runner-scripts.test.mjs:1273-1282`、`test/tooling/ci-runner-scripts.test.mjs:1180-1183`

**问题**：测试标题说“keeps the group and directory”，但断言只有顶层 `/srv/gh-runner-share=DIR` 和未调用 `groupadd/groupdel`：
```js
"mkdir -p /srv/gh-runner-share/43003101968-1",
"touch /etc/fake-group-gh-ci-share",
...
expect(state["/srv/gh-runner-share"]).toBe("DIR");
expect(box.calls()).not.toMatch(/^group(add|del) /m);
```
预置的 `43003101968-1` 是否还在没有断言；而且 fake `install` 会把 `-o/-g` 直接丢掉：
```sh
while [ $# -gt 0 ]; do case "$1" in -o|-g) shift 2 ;; ...
```
所以测试并不能证明脚本真的把目录交给了 `gh-ci-share` 组。源码 `install-runner.sh:98-99` 用的是 `install -d`，确实不会删已有内容，结论应成立，但测试没有覆盖到这一点。

**建议**：把 `/srv/gh-runner-share/43003101968-1` 加进 `reported` 列表并断言 `DIR`；在测试注释/说明里写清 fake `install` 不校验属主。

---

## 读代码证实的 vs 推测

**已证实**
- `--artifacts` 只允许 `keep`/`omit`，非法值在创建输出目录前就抛 `CI_PUBLIC_ARTIFACTS_INVALID`（`publish.mjs:78`，早于 `stagedPublication`）。
- omit 时 `entries` 只来自实际写出的文件，`assertPublicArtifacts` 的 `entries` 与文件一致；`result.json` 写入前会再次 `validateRecord("CheckResult", published)`，当前 build/security 检查都另有 `details.json` 等 JSON 报告，`reports` 不会为空。
- `ci.yml` 的所有 publish 命令仍不带 `--artifacts`，默认 `keep`，行为不变（grep 只找到 main-confirm 传该参数）。
- `main-confirm.mjs` 的 smoke 测试读的是 `.ci-output/main-check/build` 里的原归档，不是 `main-public`，所以省略上传不影响测试。
- 仓库内没有别的代码读 `main-public` 下的构建归档；`main.yml:100` 只做整目录上传。
- runbook 新加的 `CI_SHARE_DIGEST_INVALID` 与 `run-share.mjs:94` 的 `fail("DIGEST_INVALID")` 一致。
- ADR 关于 `summary.json.artifactSha256` 的说法与 `main-confirm.mjs:134` 一致。
- ADR“只检查 ci.yml”与 `check-policy.mjs:1331-1339` 不一致（见发现 3）。

**推测 / 未能证实**
- 未来新增的消费者若把发布后的 `result.json.artifacts[]` 当作实际文件清单，会因为归档被省略而失败（仓库内当前无此消费者）。
- 归档不再上传后，`summary.json` 里的摘要无法再对应到任何可下载文件，事后审计只能复跑构建；构建是否逐字节可复现未核实。
- `docs/runbooks/ci-vps-runner-runbook.md` 新 `contract_sha256` 是否正确未核实（无法运行封存/校验工具）。

---

## 侧重检查

- **错误路径**：非法 `artifacts` 值在 `publish()` 入口、`mkdtemp` 之前抛出；CLI 顶层 `catch` 会写 stderr 并置 `exitCode=1`（`publish.mjs:273-279`），不会留下半成品目录。quality 模式拒绝 `--artifacts` 的路径存在，但空串有真值判断漏洞（发现 2）。
- **不可信/不合规范输入**：`--artifacts` 只来自仓库内的 `main-confirm.mjs`/测试，值被白名单校验；它不参与路径拼接、命令拼接或文件命名，无注入面。`report.path` 的校验仍走 `existingInside`，省略逻辑放在校验之后，不会绕过路径检查。
- **安全**：被省略的归档不再经过 `assertPublicArtifacts` 的内容/秘密扫描，但它也不再被上传，因此没有把未扫描内容公开出去；其余发布文件仍逐项按 `entries === allowed` 校验。`result.json` 仍保留归档的路径与 SHA，不含内容。
- **资源耗尽**：omit 只减少上传体积；被省略的归档仍要求存在并被完整哈希（`fileSha256(source)` 在 `continue` 之前），所以不能借 omit 跳过对超大输入的读取，也没有新增解压/嵌套扫描。
- **不可撤销操作/证据丢失**：这是本轮最实质的取舍——构建归档在作业结束后不再有远端副本，`summary.json` 只能证明“当时算过这个摘要”。ADR 0238 已把它写成决定，我按“已接受的设计取舍”记录，不作为缺陷；但如果以后需要事后取证，只能复跑构建。
- **规则/文档一致**：`main-confirm` 与设计说明第 296 行、ADR 第 4 条关于 `--artifacts omit` 的描述一致；runbook 的 `CI_SHARE_DIGEST_INVALID` 与代码一致；唯一确认的不一致是 ADR 的“check-policy 只检查 ci.yml”（发现 3）。
- **runner 重装路径**：`install_runner_share` 在组已存在时不再 `groupadd`，`install -d` 不会清空 `/srv/gh-runner-share` 下已有运行目录，行为安全；测试覆盖不足见发现 5。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。本轮改动只涉及 CI 脚本、workflow 文档、测试和 runner 脚本（`git diff` 没有触及 `packages/`、`apps/`、提示词目录或请求构造函数）。因此系统提示、工具定义、历史消息、遮盖结果都未被修改；也不存在“每轮会变的值”被放进请求开头。发给模型的内容是否“只在末尾追加”在本次改动中不受影响。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**
不会。新代码没有加入时间、随机数或依赖前后文的值；`entries`/`reports` 沿用输入数组顺序，`result.json` 仍按固定 `JSON.stringify(..., null, 2)` 序列化。omit 反而去掉了唯一带运行时审阅信息的 `public-review.json`，使 `main-confirmation` 输出更确定。这里的“请求”若指模型请求，则本轮没有请求构造变化；若指 CI 发布的 JSON，也没有新增不确定性。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**
有，但不完整。`gate-lifecycle.test.mjs` 的 omit/keep/非法值用例会在“始终 omit”“忽略 omit”“删掉白名单校验”时失败；`main-confirmation.test.mjs` 会在 `main-confirm` 不再传 `--artifacts omit` 时失败。反向缺口是：没有任何用例真正执行 `publish.mjs` 的 CLI 参数解析，因此“允许列表漏了 `--artifacts`”或“quality 模式拒绝逻辑回归”不会让测试失败（发现 1）。另外 omit 用例把 `assertPublicArtifacts` mock 掉了，没有用真实归档验证发布目录的准入结果。

**4. 新值的生产者和消费者两端是否都能接受？**
逐项核对如下：
- `--artifacts` / `keep` / `omit`：生产者是 `main-confirm.mjs:71-80` 和测试；消费者是 `publish.main()` 的 `parseArguments` 允许列表与 `publish()` 白名单。两端一致；但 CLI 端无自动测试（发现 1）。
- `CI_PUBLIC_ARTIFACTS_INVALID`：由 `publish()`/`main()` 产生，CLI 顶层统一打印；没有集中错误码清单需要同步。
- `artifactSha256`：`main-confirm.mjs:134` 产生，`summary.json` 上传；仓库内没有校验该字段的消费者，文档描述正确，但归档本身被省略，摘要无法再对应可下载文件。
- `CI_SHARE_DIGEST_INVALID`：`run-share.mjs:94` 产生，`test/tooling/run-share.test.mjs:91` 覆盖，runbook 已登记；两端一致。
- 发布后的 `result.json.artifacts[]`：schema 接受（`artifacts` 允许为空、也不要求与 `reports` 对应），但语义上指向被省略的文件；当前无消费者，属潜在一致性问题（发现 4）。

**未核实**：`ci-vps-runner-runbook.md` 的 `contract_sha256` 是否按当前契约源重新封存正确（不能运行封存/校验工具）；本轮测试是否实际全绿（不能运行 node）；`.agents/reviews/pr-397/round-3/judgments.md` 等记录未能读取（工具拒绝 records-path），作者“逐条判断”部分未核对。
