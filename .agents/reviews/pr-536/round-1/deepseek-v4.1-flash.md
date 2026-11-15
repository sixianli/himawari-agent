## 侧重检查

- **错误路径**：`test/tooling/safari-panel.test.ts` 通过 `launchChromium(chromium)` 启动浏览器（`test/tooling/safari-panel.test.ts:2,11,25`）；`test/fixtures/chromium-launch.ts:4-17` 只在 `Executable doesn't exist` 时回退到 `/opt/pw-browsers/chromium`。tooling 作业原先没有安装步骤，因此该路径会失败；新增步骤放在执行测试之前，能覆盖这条错误路径。
- **不合规范或不可信输入**：新增步骤的 `run` 是固定字面量，不含 `${{ }}`，也通过 `check-policy.mjs:596-600` 的 shell 注入校验；没有把 PR 内容拼接进命令。
- **安全**：没有新增权限、密钥或产物上传；浏览器由锁定的 Playwright 版本安装，和 static/tests 使用同一条命令（`.github/workflows/ci.yml:95-96,260-261,307-308`）。
- **资源耗尽**：每次 tooling 运行都会下载一份 headless shell 到 `.ci-output/browsers`，没有跨作业缓存；这是现有 static/tests 的同一做法，作业超时仍为 60 分钟，没有新增无界循环。
- **不可撤销操作**：没有。
- **规则、说明文档和代码一致性**：发现 Runbook 仍只写 static 需要 Chromium，见下方意见；作者“948 条通过”的说法无法核实。

### 1. 低：Chromium 策略只验证步骤存在，不验证顺序或条件，门槛可被绕过

- 文件：`scripts/ci/check-policy.mjs:612-616`；`.github/workflows/ci.yml:307-310`
- 问题：新增的 tooling 要求只检查 job 里是否存在一条 `run` 完全等于 `chromiumInstall` 的步骤。若以后把安装步骤挪到 `run.mjs --check tooling` 之后，或给它加 `if: false`、`continue-on-error: true`，策略检查仍会通过，tooling 会再次在没有浏览器的状态下跑测试。
- 证据：

```js
if (chromiumChecks.includes(check.id))
  assert(
    job.steps.some((step) => step.run === chromiumInstall),
    `Job runs browser tests without installing Chromium: ${check.id}`,
  );
```

当前实际顺序是正确的：

```yaml
- name: 安装工具测试用的 Chromium
  run: .ci-output/tools/bin/node node_modules/playwright/cli.js install --only-shell chromium
- name: 执行共享检查
  run: .ci-output/tools/bin/node scripts/ci/run.mjs --check tooling ...
```

- 建议：在策略检查中同时断言 Chromium 步骤的下标小于 tooling 测试步骤，且该步骤没有 `if`、没有 `continue-on-error`；并在 `test/tooling/policy.test.mjs` 增加“步骤放到测试之后”和“步骤加 `if: false`”两个反向用例。更长远的做法是让“哪些 job 需要浏览器”从 policy 的 project/测试清单推导，而不是继续手写 `chromiumChecks` 名单。

### 2. 低：ARM 准备 Runbook 仍只写 static 需要 Chromium，改动后 tooling 也需要，文档与代码不一致

- 文件：`docs/runbooks/ci-vps-runner-runbook.md:186`
- 问题：该段仍说“static 检查里的布局检查要用 Chromium”，但现在 tooling 作业的 `safari-panel.test.ts` 也在同一台 ARM 机器上启动 Chromium。`prepare-arm.sh` 实际安装的是 Chromium 系统库，本身仍够用，但说明文字已经漏掉 tooling。
- 证据：

```text
再用固定版本的 Node 和 Playwright 装 Chromium 需要的系统库（static 检查里的布局检查要用 Chromium，少了这些库会在“安装布局检查用的 Chromium”一步报缺库）
```

- 建议：改为同时提到 static 的布局检查和 tooling 的 Safari 面板测试都需要 Chromium；不需要改脚本行为。

## 读代码证实的

- 本次 diff 只改 `.github/workflows/ci.yml`、`scripts/ci/check-policy.mjs`、`test/tooling/policy.test.mjs`，没有改系统提示、工具定义、消息历史、出口遮盖或任何模型请求序列化代码，因此不会改变发给模型的内容。
- `chromiumInstall` 的产生处是 `scripts/ci/check-policy.mjs:53-54`，使用处是 `.github/workflows/ci.yml:308` 和 `test/tooling/policy.test.mjs:241,775`；三处字符串逐字节一致。
- `ci/policy.json:114-128` 确实有 `id: "tooling"` 且 `projects: ["tooling"]`；`ci/policy.json:213-214` 的 tooling 测试集合包含 `test/tooling/**/*.test.ts`，所以 `safari-panel.test.ts` 会在 tooling 作业里跑。`scripts/ci/contracts.mjs:19` 的 `armChecks` 也包含 `tooling`，与 `runs-on: ci-arm` 一致。
- `check-policy.mjs` 的 `main()` 会读取实际的 `.github/workflows/ci.yml` 并调用 `validateWorkflow`（`scripts/ci/check-policy.mjs:1475-1480`），所以 CI 的 policy 作业会自动跑这条检查，不只是单测夹具。
- 反向用例 `test/tooling/policy.test.mjs:771-779` 会遍历 `static/tests/tooling`，从 fixture 中删掉 Chromium 步骤并期望抛出 `without installing Chromium: tooling`。在改动前的 `chromiumChecks` 中没有 `tooling`，这条用例不会抛出，因此它确实能守住这次行为变化。
- 作者说法“去掉 ci.yml 新加的步骤，check-policy 会报 …”与代码路径一致：`validateWorkflow` 在 `chromiumChecks` 包含 `tooling` 后会走 `job.steps.some(...)` 失败并抛出该消息（`scripts/ci/check-policy.mjs:612-616`）。
- 约束方面：diff 确实修改了测试文件 `test/tooling/policy.test.mjs`。如果“只改 CI 文件；不改测试本身”按字面指任何测试文件，这超出了约束；但它没有修改失败的 `test/tooling/safari-panel.test.ts`，改的是策略契约测试，是让新增门槛与 `ci.yml` 保持一致的配套改动。

## 推测与未核实

- **未核实**：作者称“test/tooling/policy.test.mjs 948 条通过”。我没有运行测试，不能确认。仓库里 2026-11-07 的证据是 `policy.test.mjs`、`ci-optimization.test.mjs`、`ci-runner-scripts.test.mjs` 三个文件合计 749 条通过（`.agents/tasks/hermes-runner/evidence.jsonl:16`）；2026-11-13 的证据是整个 tooling 101 个文件 1231 条（`.agents/evidence/ci-test-timing-2026-11-13.md:7`）。单文件 948 条相对这些数据偏高，建议贴出实际 Vitest 报告；目前只能标为未核实，不能据此判定为假。
- **推测**：新增的 `--only-shell chromium` 在 ARM 上能否覆盖 `safari-panel.test.ts` 的全部行为，没有实际运行验证；但从错误信息看缺的正是 headless shell，且 static 已使用同一命令，风险不高。ARM 机器上 `prepare-arm.sh:48-49` 会安装 Chromium 系统库，因此本次没有新增 `--with-deps` 是合理的。
- **推测**：目前 tooling 作业每次下载浏览器会增加时间和网络占用，但没有新增缓存或并发，属于现有 CI 模式；没有证据表明会耗尽 runner 资源。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 改动只涉及 CI 工作流、策略检查脚本和它的契约测试，没有改系统提示、工具定义、历史消息、遮盖逻辑或请求序列化；没有新增任何发给模型的内容，也不涉及“只在末尾追加”或“每轮变化值放在最后一条消息”的规则。
2. **不会让同一段文字在不同请求里变成不同的字节。** 改动的值只有 CI job id、固定命令字符串和步骤名称，不参与模型请求序列化；没有依赖前后文的遮盖、时间字段或无序集合。
3. **有对应自动检查，反向用例有意义。** `scripts/ci/check-policy.mjs:612-616` 会在 policy 作业中检查实际 `ci.yml`；`test/tooling/policy.test.mjs:771-779` 的 tooling 反向用例在旧代码上会失败、在新代码上通过。不足是它只检查步骤存在，不检查顺序和条件，见意见 1；该加强项目前没有反向用例。
4. **逐个值核对两端，没有发现 I-73 式的不匹配。**
   - `chromiumChecks` 新增的 `"tooling"`：产生处是 `ci/policy.json:114`（以及 `upgradeCoverageToTests` 生成的 `id: "tooling"`，`scripts/ci/check-policy.mjs:245`）；使用处是 `scripts/ci/check-policy.mjs:612` 和 `ci.yml:281`。policy 中确实存在该 id，workflow 中确实存在该 job，`armChecks` 也包含 `tooling`，两端可接受。
   - `chromiumInstall`：产生于 `scripts/ci/check-policy.mjs:53-54`；`ci.yml:308`、`test/tooling/policy.test.mjs:241,775` 使用同一字符串，未发现漂移。
   - 测试中的 `"tooling"` 参数：fixture `workflow()` 由 `policy.checks` 生成，包含 tooling job，因此 `value.jobs.tooling` 存在；反向用例不会访问未定义的 job。
   - 没有新增 schema 字段、配置键、清单项或序列化格式，因此没有需要同步放宽校验的另一端。
