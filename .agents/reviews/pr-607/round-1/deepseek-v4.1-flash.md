## 读代码证实的

### 1. 中 — 删除的 10 条禁令里包含 GitHub 写/外部通知的能力、路由和依赖，安全护栏被整体移除且没有替代检查

`test/fixtures/security-invariants.json:37-39`

```json
"forbiddenCapabilityLiterals": ["core.upgrade.auto", "owner.register.public"],
"forbiddenRouteFragments": ["/api/register", "/api/signup", "/api/core/auto-upgrade"],
"forbiddenDependencies": [],
```

问题：与基准相比被删掉的不只是 5 条“保留项”之外的多余项，还包括 `github.comment.create`、`github.merge`、`github.push`、`notification.external`、`/api/github/write`、`/api/notifications/external`，以及 `@octokit/rest`、`@slack/web-api`、`nodemailer`、`twilio`。`scripts/check-security-invariants.mjs:62-72` 和 `:87-101` 现在不会再对它们报错；我全仓 grep 也没有发现其他门禁覆盖这些字面量或依赖。

证据：旧清单在基准提交中确认为 6 条 capability、5 条 route、4 条依赖；新清单只剩 2/3/0。作者说法 4 只列出“保留的 5 条”，没有说明 GitHub 写和外部通知相关的护栏也一并清空，读起来会让人以为只删了过时的注册/升级项。

建议：如果这是 Andy 逐条同意后的预期，请在 PR 说明和 `document-governance` 里明确写出“GitHub 写、外部通知、Octokit/Slack/邮件/短信依赖不再由自动检查拦截”，并补一个替代门禁或至少一个负向测试；否则恢复 `forbiddenDependencies` 和对应 capability/route 条目。

### 2. 中 — `document-governance.md` 和 `delivery-mode.md` 仍保留“Runbook 封存”说法，与同一改动里的“不再封存”矛盾

`.agents/instructions/document-governance.md:31`

```text
Runbook 不再封存指纹（`contract_sha256`、`runbook-contract` 清单和 `runbook.py seal` 已从技能里删除...
```

`.agents/instructions/document-governance.md:51`

```text
...Runbook（操作手册）的重新封存推迟进行。
```

`.agents/instructions/delivery-mode.md:26`

```text
...留下未更新文档（包括过期的 Runbook 封存）的提交，其提交说明要带上 `Docs: deferred (fast mode)`。
```

问题：同一份 `document-governance.md` 一处说封存机制已删除，另一处仍要求“重新封存推迟进行”；`delivery-mode.md` 也仍把“过期的 Runbook 封存”当成需要推迟的文档问题。作者说法 5 明确声称没有这类矛盾，结论不成立。

建议：把 `:51` 改为“Runbook 不再封存；按 Authoritative Sources 对照当前代码”，把 `delivery-mode.md:26` 的括号改成“过期的 Runbook 内容或结构问题”，并顺手清理 `document-governance.md:29` 中已不存在的 `docs/archive` 例外说明。

### 3. 低 — 仍为 active 的计划还在要求“归档到 docs/archive”或调用 `archive_doc.py`，与新规则“过期文档直接删除、不再新建归档目录”冲突

`docs/execution/plans/2026-11-11-apple-device-body-plan.md:198`

```text
- [ ] 全部完成后，这份计划和详细设计移到 `docs/archive/`。
```

`docs/execution/plans/2026-10-28-file-delivery-and-more-panel-plan.md:130`

```text
- [ ] 本计划完成后用 `archive_doc.py` 归档。
```

`docs/execution/plans/2026-09-24-isolated-tool-execution-plan.md:562`

```text
- [ ] 全部完成后，才按 document-governance 归档本 Spec/Plan；ADR 留在 `docs/adr/`。
```

`docs/execution/plans/2026-09-07-srt-unified-execution-plan.md:515`

```text
- [ ] 整批实际交付完成后才归档本 Plan；本次设计完成不关闭实施计划。
```

问题：这些计划都是 `status: active`，新规则却规定“过期文档直接删除，不归档”“不再新建归档目录”。后续照着计划做的人会尝试移动到已经删除的 `docs/archive/`，或者执行已经不再作为新政策的归档流程。

建议：把这些待办改成“完成后用 `git rm` 删除，旧版本在 git 历史里”，或在计划中明确“本计划适用旧政策，已由新规则取代”。

### 4. 低 — 保留的 active 计划仍引用旧命令 `npm run check:v0.2-invariants`，改名后该命令不存在

`docs/execution/plans/2026-09-07-srt-unified-execution-plan.md:424`

```sh
npm run check:v0.2-invariants
```

`package.json:85`

```json
"check:security-invariants": "node scripts/check-security-invariants.mjs",
```

问题：这份计划仍在“验证命令与证据规则”的当前命令块里给出旧名字；照着执行会得到 npm 的 missing script 错误。作者说法 3 的“其他脚本/CI 的每一处引用都已改掉”只覆盖代码，不覆盖这类保留文档。

建议：把该行改成 `npm run check:security-invariants`。历史证据文件里的旧命令可以按约束保留。

### 5. 低 — 11 个证据 README 仍有指向已删 `docs/archive/plans/...` 的相对链接，形成断链，而 `check:docs-links` 不会检查 `test/`

`test/qualification/evidence/workspace-authorization-lifecycle/p3-completion-01/README.md:3`

```text
本批对应 [Plan 的 P3 七项](../../../../../docs/archive/plans/2026-09-16-workspace-authorization-lifecycle-plan.md#p3)
```

同类链接还出现在 `p4-completion-01/README.md:3`、`p5-completion-01/README.md:3`、`p2-network-authority-01/README.md:3` 等，共 11 处，目标 `docs/archive/plans/2026-09-16-workspace-authorization-lifecycle-plan.md` 等文件已被本 PR 删除。

`scripts/check-docs-links.mjs:73-85` 只从 `docs/` 收集文件并跳过 `docs/archive`，完全不扫描 `test/`，所以这些断链不会被任何自动检查发现。约束只豁免“证据文件里的纯文字提及”，而这些是实际的 Markdown 链接。

建议：按 ADR/文档处理方式改成指向 `34de855...` 的 GitHub 固定链接；如果决定证据文件整体冻结不改，请在 PR 说明里明确“证据目录的断链是有意保留”，并把说法“仓库里不留指向它们的断链”限定范围。

### 6. 低 — 改写固定链接时丢了原有锚点，两个文档的 `supersedes` 被直接清空，取代关系丢失

`docs/adr/0021-platform-capability-runtime-isolation.md:63-64` 的新 URL 没有保留原来的 `#统一能力类型`、`#task-9资格验证并实现隔离与-runtime-adapters`；`docs/adr/0022-mac-tiered-command-sandbox.md:56` 丢了 `#task-2完成-machermes-文件与执行-qualification`。

`docs/runbooks/ci-vps-runner-runbook.md:6`

```yaml
supersedes: ""
```

`docs/execution/plans/2026-09-24-isolated-tool-execution-plan.md:4`

```yaml
supersedes: ""
```

问题：基准里 `ci-vps-runner-runbook.md` 的 `supersedes` 指向被删的 `docs/archive/runbooks/2026-11-07-hermes-self-hosted-runner-runbook.md`，`2026-09-24` 计划指向被删的 workspace lifecycle plan；现在两边都清空，取代关系只剩正文里的间接描述。锚点丢失也让读者落到文件顶部而不是原引用小节，与“不改链接周围的意思”有偏差。另有一处 `docs/execution/plans/2026-09-24-isolated-tool-execution-plan.md:81` 出现两个相邻的同一 URL 链接（机械替换留下的重复）。

建议：固定链接保留原 `#anchor`；`supersedes` 若不能写 URL，至少在正文“关联文档”里写明“本文取代 `34de855...` 中的某某”，或保留一个合法字段记录历史路径。

### 7. 低 — 作者说法 4 的“在产品代码里加入禁令就会失败”只对 `.ts` 成立，前端 `.tsx` 产品代码不在扫描范围

`scripts/check-security-invariants.mjs:50-56`

```js
const sourceFiles = productionFiles.filter((filePath) => {
  const normalized = `/${relative(filePath)}`;
  return (
    filePath.endsWith(".ts") &&
    !filePath.endsWith(".test.ts") &&
    !manifest.excludedSourceSegments.some((segment) => normalized.includes(segment))
  );
});
```

问题：`apps/control-center/src` 下的产品代码大量是 `.tsx`（例如 `apps/control-center/src/app.tsx`、`components/notification-settings.tsx`），把 `core.upgrade.auto`、`/api/signup` 之类字面量加进这些文件，`check:security-invariants` 不会失败。这是既有覆盖缺口，但本 PR 的说法 4 把它说成了全产品代码保证。

建议：把过滤条件扩展到产品使用的 `.tsx`/`.js`/`.mjs`，或者把说法 4 限定为“`.ts` 产品代码”；同时补一个把禁令放进临时 `.ts` 源文件的负向测试。

## 推测与未核实

- **未核实**：`docs/engineering-casebook.md` 当前是否真的超过 `maxFileBytes: 512000`。我只核对了 `scripts/repo-hygiene/config.json` 的格式（`{path, reason}` 能通过 `scripts/check-repo-hygiene.mjs` 的 `parseConfig`），没有工具能在这里读文件大小。
- **未核实**：`34de855...` 是否包含全部 34 份被删文档。我只抽查了 Hermes runner runbook、自研记忆提案、portable durable plan 三份，都能在该提交读到。
- **未核实**：GitHub 的 `blob/<sha>/path.md#heading` 锚点是否都能按预期跳到标题；无网络，不能验证。
- **推测**：`BL-20261028-008` 在 ADR 0224 里仍被描述为“以后再做、动手时另写 ADR”，删除它的归档条目是否丢掉了活跃提醒，取决于仓库外的 backlog 数据库；我没找到仓库内的活动 backlog 记录，不能确认。
- **推测**：删除 `docs/archive` 目录本身不会让 `check:glossary` / `check:docs-links` / `check:adr-numbers` 崩溃——这三个脚本都在读取前用 `existsSync` 判断；这是读代码推断，未实际运行。

## 侧重检查

- **错误路径与不可信输入**：`check-security-invariants.mjs` 从固定仓库路径读取 JSON，清单损坏时 `JSON.parse` 抛错、检查失败（fail closed）；没有新增用户可控路径。删除 `docs/archive` 不影响 `check-glossary.mjs:58-61`、`check-docs-links.mjs:73-75`、`check-adr-numbers.mjs:40-50` 的目录遍历。
- **安全**：重点核对了被删的 10 条禁令和所有使用端；GitHub 写、外部通知、Octokit/Slack/邮件/短信依赖现在没有自动门禁，也没有替代检查。
- **资源耗尽**：`scripts/repo-hygiene/config.json` 新增的 `allowedLarge` 是精确路径匹配（`matchesPrefix` 对非 `/` 结尾的条目只做全等匹配），不会顺带放行同前缀的其他文件；格式和理由字段通过 `parseConfig` 校验。
- **不可撤销操作**：37 个文件用 `git rm` 删除，历史仍在；抽查的固定链接能指向删除前提交；但证据目录留下 11 个断链，两个 `supersedes` 被清空。
- **规则/说明与代码一致**：确认 `document-governance.md` 内部、`document-governance.md` 与 `delivery-mode.md`、新政策与 active 计划之间都存在不一致；详见上面第 2、3 条。
- **改名引用**：在 `scripts/`、`.github/`、`package.json` 和 `.ts/.js/.mjs/.json/.yml` 中搜索旧名，除证据文件外只命中 `docs/execution/plans/2026-09-07-srt-unified-execution-plan.md`；`package.json` 的 `check:steps` 已改，`check-security-invariants` 定义存在，脚本本身仍导出 `checkV02Invariants`（仅自用，无外部引用，功能无影响）。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 这个 diff 没有触及请求组装、系统提示、工具定义、历史、资料块或遮盖代码；`apps/` 下唯一产品改动是 `control-center-inventory.ts` 删除 UI 清单的 `sourceSpec` 字段，它不是模型请求的一部分。`package.json` 只是改名检查，`check:prompt-prefix` 仍在 `check:steps` 中。`.agents/instructions` 是仓库代理规则，不是同一对话内追加/改写的消息；本次也没有新增每轮会变的时间、记忆或环境值。未运行 `check:prompt-prefix`，只做了静态核对。
2. **不会让同一段文字在不同请求里变成不同字节。** 改动没有参与模型请求的 JSON 序列化，也没有新增依赖前后文的遮盖、时间字段或无序集合；新清单和文档是静态字节，固定链接是静态字符串。证据对象里的 `recordedAt` 是原有时间字段，且不进入模型请求。
3. **只有一部分有自动检查，反向用例不完整。** 改名本身由 `check:steps` 覆盖：如果 `package.json` 还引用旧名，`npm run check` 会因 missing script 失败；我 grep 也确认脚本/CI/package.json 里没有旧名。`check-security-invariants` 没有任何单元测试或负向夹具（全仓只命中脚本自身），删掉 `forbiddenDependencies` 条目也不会有测试失败；因此“反向用例真的会失败”对这条检查不成立。文档删除方面，`check:docs-links` 只扫 `docs/`，不扫 `test/`，也不验证外部 GitHub URL，所以第 5 条那 11 个断链不会被发现；第 2、3、4 条的规则矛盾和旧命令也没有自动检查。`repo-hygiene` 有真正的负向测试（`test/tooling/repo-hygiene.test.mjs` 会解析真实配置并断言非法配置抛错），新增条目的格式会自动校验。测试无法在此环境执行，以上为静态结论。
4. **逐个核对改动值：**
   - npm 脚本 `check:security-invariants`：产生于 `package.json:85`，使用于 `package.json:27` 的 `check:steps`；已同步。旧名仍出现在保留计划第 424 行（应改）和证据文件（按约束可保留）。
   - 脚本文件名 `scripts/check-security-invariants.mjs`：仓库内没有其他导入者；只有 `package.json:85` 使用。脚本导出的函数名仍是 `checkV02Invariants`，但无外部引用，不影响运行。
   - 清单路径 `test/fixtures/security-invariants.json`：产生于文件移动，使用于 `scripts/check-security-invariants.mjs:7`；文件存在，路径两端一致。
   - 清单字段：`forbiddenDependencies: []` 能被 `includes` 正常处理（总是 false），没有 schema 要求非空，因此检查会静默通过；这正是第 1 条的风险。
   - 删除的 `sourceSpec`：接口和全部数据项都删了，全仓已无 `sourceSpec`；测试里的正则断言也删了，没有其他 schema/消费者。
   - 删除的 `sourcePlan`：三份夹具和对应测试的接口/相等断言都改了，全仓已无 `sourcePlan`，没有其他读取端。
   - 生成的 evidence 里删除的 `plan` 字段：当前没有代码读取这些 evidence 的 `plan`；唯一要求 `plan` 的 `task-evidence.schema.json` 也在同一 PR 删除；没有发现其他 task-evidence 校验器。
   - 两个 `supersedes: ""`：空字符串格式本身可接受（其他 Runbook 也这样用），但语义上丢失了被取代文件的关系，见第 6 条。
   - `allowedLarge` 新条目：`{path: "docs/engineering-casebook.md", reason: "..."}` 能通过 `parseConfig` 的 `repositoryPath` 和非空理由校验；按精确路径匹配，只放行这一个文件。文件是否真的超过大小上限未核实。
