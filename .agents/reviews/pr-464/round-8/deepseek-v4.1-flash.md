## 结论

本轮增量 `61211c3de..25ea1c859` 确实只改测试、复核记录和平台写死清单。我未发现高、中严重度问题；作者第 3、4、6 条说法与代码基本一致，平台清单里的数也对得上。下面是两条低严重度观察和逐项核对结果。

## 发现（读代码证实）

### 低 — test/tooling/ci-runner-scripts.test.mjs:2957

**问题：**新断言只检查了每份准备脚本里的“下载文件名”这一处平台，没有检查同一脚本里第二次写死平台的解压路径 `node_bin`。如果只把 `node_bin` 的平台改错，用例仍会通过，但脚本实际运行时会找不到 Node/npm。

**证据：**
- `test/tooling/ci-runner-scripts.test.mjs:2956-2957`：
  ```js
  const text = readFileSync(path.join(scripts, name), "utf8");
  expect(text).toContain(`node-v$NODE_VERSION-${platform}.tar.gz`);
  ```
- `scripts/operations/ci-runner/prepare-arm.sh:43` 使用 `node-v$NODE_VERSION-linux-arm64.tar.gz`，`:46` 又写死 `node_bin="$work/node-v$NODE_VERSION-linux-arm64/bin"`。
- `scripts/operations/ci-runner/prepare-vps.sh:62` 使用 `node-v$NODE_VERSION-linux-x64.tar.gz`，`:65` 又写死 `node_bin="$work/node-v$NODE_VERSION-linux-x64/bin"`。

**建议：**再断言解压路径，例如 `expect(text).toContain(\`node_bin="$work/node-v$NODE_VERSION-${platform}/bin"\`)`；或者让脚本只定义一个 `NODE_PLATFORM`，两处都由它拼出来。

### 低（仅影响失败诊断）— test/tooling/opencode-review.fixtures.mjs:196-199

**问题：**断言已恢复为 `toEqual` 深比较，这是对的；但传给 `expect` 的失败信息来自 `firstChangedMessage`，它用 `JSON.stringify` 找“第一处不同”。两者语义不完全相同：如果对象键顺序不同，`toEqual` 会认为相等而 `firstChangedMessage` 会报告“changed”；反过来，JSON 不能表示的差异（如数组里的 `undefined` 与 `null`）可能让提示信息为空。真实模型请求都是 JSON，风险很小，但提示信息不保证指向真正的失败位置。

**证据：**
- `test/tooling/opencode-review.fixtures.mjs:182-184`：
  ```js
  const index = earlier.messages.findIndex(
    (message, position) => JSON.stringify(message) !== JSON.stringify(later.messages[position]),
  );
  ```
- `test/tooling/opencode-review.fixtures.mjs:196-199`：
  ```js
  expect(
    later.messages.slice(0, earlier.messages.length),
    firstChangedMessage(earlier, later),
  ).toEqual(earlier.messages);
  ```

**建议：**保留 `toEqual`；如果希望提示可靠，可在断言失败后对逐条消息做同样的深比较来定位，或让提示函数使用与 `toEqual` 相同的比较规则。

## 与作者说法的核对

- **第 3 条：**属实。`scripts/ci/check-security.mjs:46` 定义 `semgrepTimeoutMs = 15 * 60_000`，`:534` 把它传给 `execute`；`execute` 的默认超时是 `120_000`（同文件 `:56`、`:62`）。测试 `test/tooling/security-process.test.mjs:215-219` 断言 semgrep 调用收到 `900000`。删掉调用点的 `timeout` 后会收到默认的 `120000`，断言会失败。**未实际运行测试**，这是按代码路径静态核对。
- **第 4 条：**属实。`test/tooling/ci-runner-scripts.test.mjs:2950-2952` 按脚本名给定 `linux-x64` / `linux-arm64`，`:2957` 先断言下载文件名，`:2958-2961` 再查 `ci/toolchain-lock.json`。锁文件里 `linux-x64` 和 `linux-arm64` 的 Node 22.22.3 条目都存在（`ci/toolchain-lock.json:18-26`），SHA-256 分别与 `prepare-vps.sh:8`、`prepare-arm.sh:7` 一致；Playwright `1.62.1` 也与 `package.json:110` 一致。
- **平台清单：**正确。`scripts/platform-assumptions.json:82` 把 `test/tooling/ci-runner-scripts.test.mjs` 的 `linux-x64` 记为 `2`；该文件实际只有两处匹配：`:771` 的 `build-linux-x64` 和 `:2951` 的 `"linux-x64"`。同一文件的 `x86_64` 仍只有 `:2047` 一处，清单 `:126` 仍为 `1`，没有漏改。
- **第 6 条：**属实，但本质是恢复 base 的 `toEqual`，不是新增覆盖强度；`firstChangedMessage` 现在只作为失败信息使用。没有新增专门验证该 helper 反向失败的新用例。
- **第 1 条“仓库是私有的”：**未核实。`package.json` 的 `"private": true` 只表示 npm 包私有，不能证明 GitHub 仓库私有；本环境也没有可用的 remote 配置。

## 侧重检查

- **错误路径 / 资源耗尽：**semgrep 超时设为 15 分钟，security job 的 `timeout-minutes: 60`（`.github/workflows/ci.yml:287`），不会先于 job 被掐断。超时后 `execute` 会因 `result.error` / `signal` 触发 `SECURITY_COMMAND_UNAVAILABLE`（`check-security.mjs:64-67`），`runSecurityChecks` 记为 `infrastructure_failed`，属于失败关闭，没有静默放行或无限重试。
- **不合规范 / 不可信输入：**本轮新增断言只读取仓库内的脚本和锁文件，不引入新的外部输入。所检查的生产脚本使用固定 Node SHA-256，测试也把 `NODE_SHA256` 与锁文件逐项比对。
- **安全：**没有新增秘密或凭据。复核记录在 `git diff` 中显示为 binary，是 `.git/info/attributes` 里 `/.agents/reviews/** -diff` 的预期效果，与 `.agents/instructions/model-review.md:128` 的记录保护一致，不是编码损坏。
- **不可撤销操作：**本轮增量没有执行或新增任何删除、覆盖、安装类操作。上一轮新增的 install/uninstall 脚本本轮未重新审查。
- **规则 / 文档一致性：**`.claude/rules/prompt-prefix.md` 的只追加要求没有被本轮改动触碰；ADR 0253 说明清单按“文件 × 类别 × 次数”核对，当前 `linux-x64` 计数方式与之一致。未发现规则、文档与代码相互矛盾的地方。

## 推测 / 未核实

- 未实际执行测试；“删除 timeout 会失败”“删掉下载文件名会失败”是按代码路径静态推演，执行结果未核实。
- “仓库是私有的”不是代码事实，未核实。
- 本轮只复核了增量；上一轮加入的 ARM 安装、远程共享、runner 管理脚本没有全部重读，不能据此认为整个 PR 没有其他问题。

## 必答问题

1. **不会改变模型已经见过的请求开头。**本轮改的是测试辅助函数、测试断言、平台清单和复核记录，没有改生产环境的提示词、工具定义、历史消息或遮盖逻辑。`opencode-review.fixtures.mjs` 只是断言“后一个请求以前一个请求的 `tools` 和 `messages` 前缀开头”（`:194-200`），它本身不组装发给模型的请求。按 `.claude/rules/prompt-prefix.md:35` 的只追加要求，这个改动没有引入任何每轮变化的值；整个 PR 的生产改动也都在 CI/runner 侧，不涉及模型请求组装。

2. **不会让同一段文字在不同请求里变成不同字节。**本轮没有新增时间字段、依赖前后文的遮盖或无序集合。`firstChangedMessage` 的 `JSON.stringify` 只用于测试失败提示；平台字符串和 `semgrepTimeoutMs` 都是固定常量；`platform-assumptions.json` 也是固定清单。没有发现新的非确定性序列化。

3. **有对应自动检查，反向用例按代码静态推演会失败。**
   - `security-process.test.mjs:215-219`：删掉调用点 timeout 后，期望 `[900000]` 会得到 `[120000]`，失败。
   - `ci-runner-scripts.test.mjs:2957`：删掉或改错脚本里的下载文件名，`toContain` 失败。
   - `platform-assumptions`：清单数与实际观测数不一致时，`scripts/check-platform-assumptions.mjs:99-114` 的 `comparePlatformAssumptions` 会报 `added`/`stale`，并由 `package.json:64` 的 `check:platform-assumptions` 执行。
   - `opencode-review.fixtures.mjs:196-199`：历史消息被改写时 `toEqual` 失败。
   注意：本轮没有新增专门验证 helper 反向失败的新用例；且 ci-runner 的反向覆盖只到下载文件名，没覆盖 `node_bin` 路径。实际测试未运行。

4. **逐个核对产生处和使用处，未发现两端校验不一致。**
   - `semgrepTimeoutMs`：产生于 `scripts/ci/check-security.mjs:46`，使用于 `:534`，最终进入 `execute` 的 `spawnSync` `timeout`（`:56`、`:62`）；测试使用于 `security-process.test.mjs:215-219`。两端都按毫秒处理，值是合法正整数。
   - 平台字符串：产生于 `test/tooling/ci-runner-scripts.test.mjs:2951-2952`，使用于 `:2958-2961` 查锁文件；`ci/toolchain-lock.json:18-26` 同时有 `linux-x64`、`linux-arm64` 条目，文件名、版本、SHA-256 都与脚本一致。
   - 清单项：产生于 `scripts/platform-assumptions.json:82` 的 `2`，使用于 `scripts/check-platform-assumptions.mjs:129-150` 的 `readInventory`，要求“正整数次数”，`2` 合法；实际扫描到的也是 `2`。
   - `firstChangedMessage` 返回值：产生于 `test/tooling/opencode-review.fixtures.mjs:181-192`，只作为 `expect` 的失败信息使用，没有下游解析或校验。
   唯一缺口是上面第 1 条：`node_bin` 这处平台写死值没有被对应的测试断言覆盖。
