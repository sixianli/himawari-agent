## 侧重检查

- **错误路径 / 不可信输入 / 安全**：白名单本身限定到单文件、单规则、单精确值（`ci/rules/gitleaks.toml:126-132`），路径正则锚定 `$`，值锚定 `^...$`，没有把全局规则放宽。未发现新的输入处理、命令执行或资源消耗路径。
- **不可撤销操作**：本次没有改写 git 历史；但这也意味着历史里的旧字面量仍然存在（见下文「需实跑确认」）。
- **规则 / 文档 / 代码一致**：README 与 spec 中可检出的 ADR 0181→0189 引用已改全；`docs/adr/0181-persistent-verified-download-cache-on-runners.md` 仍保留且仍应叫 0181。`package.json` 只是缩进修正，键和值未变。仓库是 sparse checkout（`git status` 显示 85% 文件存在），未检出文件里的旧引用无法核实。
- **自动检查**：白名单值和条数的反向用例已补；但「只放行这一个文件」缺少专门的集成夹具，路径被放宽到同目录兄弟文件时现有测试不会失败。

## 读代码证实的问题（按严重度）

### 1. 低：新白名单的「只限这一个文件」没有被自动测试钉住

- 文件：`test/tooling/gitleaks-allowlist.test.mjs:74-81`、`test/tooling/gitleaks-config.test.mjs:49-82`
- 问题：通用反向测试只验证路径不匹配 `/tmp/work/src/other.ts` 和 `docs/test/integration/other.test.ts`。如果有人把新路径改成 `packages/platform-node/test/.*\.ts$` 这类同目录放宽，通用用例仍然通过。`gitleaks-config.test.mjs` 的夹具和变异清单里也没有 DeepSeek 这个文件。
- 证据：
  - `test/tooling/gitleaks-allowlist.test.mjs:76-77`：
    ```js
    expect(matches(block.paths, "/tmp/work/src/other.ts")).toBe(false);
    expect(matches(block.paths, "docs/test/integration/other.test.ts")).toBe(false);
    ```
  - `test/tooling/gitleaks-config.test.mjs:49-68` 的 `FIXTURES` 中没有 `packages/platform-node/test/deepseek-web-provider.unit.test.ts`。
- 建议：在 `gitleaks-config.test.mjs` 加两个夹具（目标文件里的 `token=abcdef123456`，以及同目录兄弟文件里的同一值），断言 current/history 都只放行目标文件；再加一条路径放宽的变异用例。

### 2. 低：新值也被写进了未被白名单覆盖的测试文件

- 文件：`test/tooling/gitleaks-allowlist.test.mjs:107`
- 问题：新增反向样例 `["abcdef123456", changeLast]` 把同一个字面量放进了另一个文件，而白名单只覆盖 `packages/platform-node/test/deepseek-web-provider.unit.test.ts`。当前 `generic-api-key` 需要关键字上下文，这一行没有 `token`/`key` 等词，所以大概率不会被报；但该文件本来用 `join` 拆开 `ghp_`、`MIIE...` 等值，这次没有沿用同样的规避方式。
- 证据：
  ```js
  ["abcdef123456", changeLast],
  ```
- 建议：改成 `["abcdef", "123456"].join("")`，或从被测白名单常量里取，避免在非允许文件里留下可被未来规则命中的字面量。

### 3. 低：锁文件摘要是否正确无法从工作区核实

- 文件：`ci/toolchain-lock.json:1199-1201`
- 问题：`ci/rules/gitleaks.toml` 的 sha256 被改成 `34c0d12a...`，消费方是 `scripts/ci/install-tools.mjs:314-324` 的 `verifyRuleFiles`（`assert(sha256(readFileSync(path)) === file.sha256, ...)`），在 `scripts/ci/check-security.mjs:598` 和 `:666` 调用。若摘要不对，`npm run check:gitleaks` 和 CI security 会直接失败。
- 证据：`scripts/ci/install-tools.mjs:321`：
  ```js
  assert(sha256(readFileSync(path)) === file.sha256, `扫描规则摘要不匹配: ${file.path}`);
  ```
- 建议：最终提交上必须实跑 `npm run check:gitleaks`；本次复核没有执行权限，未独立计算 sha256。

## 推测 / 需实跑确认

### 中：历史里的私钥字面量可能仍然触发历史扫描

- 文件：`test/tooling/opencode-review.test.mjs:2299`；相关扫描逻辑 `scripts/ci/check-security.mjs:358-364`、`:402-416`，`scripts/check-gitleaks.mjs:78-79`
- 已证实的事实：
  - 旧字面量由提交 `c7685e77` 引入，`git log --oneline 21627e54 -- test/tooling/opencode-review.test.mjs` 显示它是 main 的祖先。
  - 本轮只改了工作区内容；`c7685e77` 里的第 2299 行仍然是 `const lone = \`[已遮盖:private-key-header] ${"说明".repeat(5000)}\`;`。
  - `check:gitleaks` 的历史范围是 `testedSha`（`gitleaksHistoryScope`），不是只看 `base..HEAD`：
    ```js
    const range = ancestry ?? "--all";
    const commits = Number(git(root, ["rev-list", "--count", range]).trim());
    ```
- 推测：gitleaks 的 `git` 扫描若按整文件快照匹配，历史提交里从该行到文件后面 `["-----BEGIN", "PRIVATE KEY-----"]` 的 `KEY----` 会被 `private-key` 规则连成一个块，历史仍会报；若只扫描新增行，则不会报。作者报告的 `blocking=3`（令牌 current+history 两条、私钥 current 一条）与「历史不报私钥」一致，但仓库没有测试固定这个行为。
- 建议：在最终提交上实跑 `npm run check:gitleaks`。若历史仍报，按 ADR 0177 的方式给 `private-key` 加一条只针对该文件、固定开头的窄白名单；同时补一条覆盖「新增行开头、结束标记在后续未改行」的 gitleaks 历史夹具，避免依赖上游扫描粒度的偶然行为。

### 未核实：0189 与 `ci/speed-land` 的冲突

- `git log --all -- docs/adr/0189-drop-node-floor-and-fold-test-into-coverage.md` 在当前 clone 里只看到本次提交；`0187`、`0188` 为空。`scripts/check-adr-numbers.mjs:10-29` 只检查重复和文件名格式，不检查编号连续，所以 0189 本身能通过。`ci/speed-land` 不在当前 clone 中，作者所说「该分支已使用 0189」无法核实；若那边 0189 是另一份 ADR，合并后会产生重号，现有检查会在合并后报 `ADR_NUMBER_DUPLICATE`。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。改动只涉及 `README.md`、`docs/adr`、`docs/execution/specs`、`ci/*`、`package.json` 和测试文件；没有改系统提示、工具定义、历史消息或遮盖规则。复核材料本身也是按末尾追加的 diff 提供。依据里要求的「只追加」不受影响。
2. **同一段文字会不会在不同请求里变成不同字节？** 不会。新增白名单是固定常量（路径、规则、精确值），顺序确定；`package.json` 只改缩进；测试里的字符串用数组 `join` 生成，运行时字节与原来完全相同。没有时间字段、无序集合或依赖后续内容的遮盖。
3. **有没有对应自动检查，反向用例真的会失败吗？** 部分有。`test/tooling/gitleaks-allowlist.test.mjs:64` 把条数改为 13，`:107` 新增了值变异反向用例；篡改值、把正则放宽成 `.*`、把路径放宽成 `.*` 都会失败。但「路径放宽到同目录兄弟文件」没有专门用例（见问题 1），「历史私钥是否仍被报」也没有回归测试；`ci/toolchain-lock.json` 摘要是否正确只能靠实际运行 `check:gitleaks` 验证。
4. **改动产生/修改的每个值，使用方都能接受吗？** 逐项核对：
   - 新白名单值 `^abcdef123456$`：产生于 `ci/rules/gitleaks.toml:132`；使用方是 gitleaks 扫描（`scripts/ci/check-security.mjs:619,733`）和 `gitleaks-allowlist.test.mjs`。路径 `(?:^|/)packages/platform-node/test/deepseek-web-provider\.unit\.test\.ts$` 能匹配 repo 相对路径和 snapshot 绝对路径，值形状与现有 `regexTarget="secret"` 白名单一致，两端可接受。
   - `ci/toolchain-lock.json` 的 sha256：使用方是 `verifyRuleFiles`；未独立核对，见问题 3。
   - ADR 编号/文件名 `0189`：使用方是 `check-adr-numbers.mjs`（只查重复）以及 README/spec 的四条链接；当前树无重复、链接路径存在、可检出文件里已无 `0181-drop-node-floor` 引用。
   - `opencode-review.test.mjs:2299` 的新表达式：使用方是下一行 `maskSecretLike(lone)` 断言；运行时字符串与旧字面量相同，可接受。
   - `package.json` 的 `check:steps`：键和值均未变，仅缩进修正，无行为变化。

**总体结论**：白名单本身足够窄，ADR 引用和格式修正看起来正确；合并前必须实跑 `npm run check:gitleaks` 确认历史私钥与锁文件摘要，并建议补上「只放行这一个文件」的集成测试和路径变异用例。
