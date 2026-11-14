本轮查过：增量 `163fa785..4d5505b629`（`12e0ecb70`、`4d5505b62`），并沿调用链核对了 `scripts/ci/local.mjs`、`scripts/ci/run.mjs`、`scripts/ci/check-policy.mjs`、`ci/policy.json`、`.github/workflows/ci.yml`、`scripts/platform-assumptions.json`、README、ADR 0267/0189/0064、CI runner 运行手册。没有重读未受增量影响的产品代码。未运行任何 npm/Vitest/check 命令，作者说的“910 个用例通过、lint/format/platform 通过”属于未核实。`.agents/reviews/...` 下的记录文件按材料未逐字审。

### 1. 中：现行 ADR 0064 和 ADR 0189 仍在教人运行已删除的 `--check coverage`，规则文档与代码不一致

文件:行：`docs/adr/0064-layer3-individual-trigger-scope.md:37`、`docs/adr/0189-drop-node-floor-and-fold-test-into-coverage.md:58`、`scripts/ci/local.mjs:28-29`、`docs/adr/0267-ci-tests-without-coverage-on-prs.md:5-7`

问题：这一轮把 `package.json` 和 README 改对了，但仍在生效、且被当前指令引用的 ADR 0064 还把 `coverage` 列为 `local.mjs --check` 的示例；ADR 0189 仍写着 `npm test` 等于 `local.mjs --check coverage`。按这些文字执行会直接撞上 `CI_LOCAL_CHECK_UNSUPPORTED`。ADR 0267 改变了 ADR 0189 的本地入口和作业形状，但自身 `supersedes`/`amends` 都为空，ADR 0189 也没有标注被取代。

证据（读代码证实）：

- `docs/adr/0064-layer3-individual-trigger-scope.md:37`：``node scripts/ci/local.mjs --check <该脚本所属的检查，例如 policy、coverage、security>``
- `docs/adr/0189-drop-node-floor-and-fold-test-into-coverage.md:58`：``npm test 改成 local.mjs --check coverage``
- `scripts/ci/local.mjs:28-29`：``if (check && !["policy", "static", "build", "tests", "tooling", "security"].includes(check)) throw new Error("CI_LOCAL_CHECK_UNSUPPORTED");``
- `.agents/instructions/test-trigger-timing.md:11` 明确把 ADR 0064 当作现行第 3 层规则引用。

建议：把 ADR 0064 第 37 行的示例改成现行检查名（如 `tests`、`tooling`、`security`），或在 ADR 0267 里明确说明 `coverage` 本地入口已被取代；同时给 ADR 0189 的决定 4 加“已被 ADR 0267 改变”的说明，并在 ADR 0267 的 `supersedes`/`amends` 中登记关联。历史 qualification evidence 里的 `--check coverage` 是历史记录，不应改写；`docs/lessons.md:636` 的 `--check test`（单数）也是旧命令，若保留应注明“当时写法”。

### 2. 低：新增的防回归用例只对齐 `ci/policy.json`，没有校验 `local.mjs` 自己的支持列表

文件:行：`test/tooling/quality-local.test.mjs:562-575`、`scripts/ci/local.mjs:28`

问题：新用例断言 `package.json` 里出现的每个 `--check` 都是 policy 里现有的检查，但 policy 里还有 `browser` 这类 `local.mjs` 不支持的检查。若以后有脚本写成 `--check browser`，本用例会通过，实际运行却会被 `local.mjs` 拒绝；反过来，policy 保留某检查而 `local.mjs` 删掉它时，本用例也不会失败。正则也只匹配单个空格和单个 `--check` 写法。

证据（读代码证实）：

- `test/tooling/quality-local.test.mjs:566-573`：``.checks.map((check) => check.id).filter((id) => id !== "required")``，随后仅 ``for (const check of used) expect(checks).toContain(check);``
- `scripts/ci/local.mjs:28` 的支持列表是另一份硬编码白名单：``["policy", "static", "build", "tests", "tooling", "security"]``。

建议：把 `local.mjs` 的支持列表导出为常量，用例同时断言 `used` 是 policy 检查名和 `local.mjs` 支持列表的交集；或直接用该常量做校验，避免两份名字表各自漂移。

**侧重检查**

- 错误路径：`local.mjs` 对不支持的 `--check` 会抛 `CI_LOCAL_CHECK_UNSUPPORTED`；`--check tests` 在 build 失败时不会继续跑 tests（`local.mjs:75-82`）；`run.mjs` 的 `tests` 分支缺少归档会抛 `CI_ARTIFACT_REQUIRED`（`run.mjs:102`）；`tooling` 分支只跑 Vitest。未发现本次改动新增静默通过路径。
- 不合规范/不可信输入：新增测试读取仓库里的 `package.json`、`ci/policy.json`，输入是固定仓库文件，`JSON.parse` 失败会使测试失败；没有外部输入、网络、shell 拼接或用户可控路径。
- 安全：改动是 npm script、测试、README/ADR，没有新增秘密、URL、命令执行或日志输出；没有绕过已有的报告遮盖/发布检查。
- 资源耗尽：新增测试只读两个小 JSON 并对脚本字符串做正则匹配，无无界循环、无子进程；本次改动不增加 CI 作业数量或超时。
- 不可撤销操作：没有迁移、删除、覆盖数据或生产配置变更；测试只读文件。ADR 0267 的“夜里统计覆盖率”尚未实现，不构成本轮新执行路径。
- 规则/文档一致性：README、`ci/policy.json`、`ci.yml`、CI runner 运行手册与代码一致；发现上面第 1 条 ADR 过期说明。

**读代码证实的与推测**

- 读代码证实：`ci/policy.json` 的 `tests` 是 unit/contracts/integration/e2e/pi-compat 五个项目，`tooling` 单独是 tooling；`local.mjs` 支持 `tests`/`tooling`；`run.mjs` 有对应分支；`platform-assumptions.json` 对 `policy.test.mjs` 的 `arch-x64`、`linux-x64` 计数都是 3，当前文件里这两类字面量也各是 3 处，所以去掉新写死的 `x64` 后清单能对上。
- 推测/未核实：作者在本机运行两个测试文件得到 910 个用例、lint/format/platform 通过，我没有运行命令，不能确认；ADR 过期文本是否已列入某轮的后续任务也未核实。

**必答问题**

1. **会不会改变模型已经见过的请求开头？** 不会。改动只涉及 npm script、测试、README、ADR，没有触碰系统提示、工具定义、历史消息、遮盖或请求序列化代码；没有改动 `prompt-prefix` 相关路径。按 [prompt-prefix.md:35](../../.claude/rules/prompt-prefix.md) 的只追加约束，本次没有任何东西进入“发给模型的内容”。没有证据显示本次改动改变了“每轮会变的值只放在最后一条消息”这一现状。
2. **会不会让同一段文字在不同请求里变成不同字节？** 不会。没有新增遮盖规则、时间字段、无序集合或 JSON 序列化变化；新增内容只是固定的检查名和文档文字。
3. **有没有对应的自动检查，反向用例是否真的会失败？** 有。`quality-local.test.mjs:562-575` 在把 `test` 改回 `--check coverage` 时会因 policy 里没有 `coverage` 而失败；在把 `test:tooling` 改回 `--check policy` 时，成员检查虽会通过，但精确 `toBe` 断言会失败；policy 删除 `tooling` 检查时也会失败。`policy.test.mjs:1260-1271` 的期望现在取自 `static` 成员，且同一用例前面的 `upgradeCoverageToTests(accepted)).toEqual(policy)` 仍会固定工具链成员；若 `ci/policy.json` 的 static/tooling 成员漂移，该断言会失败。局限是：没有覆盖 `local.mjs` 白名单，见第 2 条；我没有实际运行这些反向用例，以上是按代码路径判断。
4. **改动产生或修改的每个值，使用端都能接受吗？** `tests`：产生于 `package.json:81`，使用于 `local.mjs:28,72,82`、`run.mjs:290`、`ci/policy.json:98-111`、`ci.yml:267`、`quality-local.test.mjs:574`，两端都接受；`policy` 和 `check-policy` 也把 `tests` 的项目固定为五个主项目。`tooling`：产生于 `package.json:93`，使用于 `local.mjs:28,83`、`run.mjs:251`、`ci/policy.json:114-128`、`ci.yml:281-321`、`quality-local.test.mjs:575`，两端都接受。去掉的测试字面量 `arch: \"x64\"` 只影响测试期望，`platform-assumptions.json` 的计数与当前文件一致。ADR 0267 的“四个带覆盖率统计”与 `coverage-model.mjs:33` 及 ADR 0189 的旧四项目覆盖率范围一致。未发现仍在 package script、CI 工作流或运行手册里使用 `--check coverage` 的地方；只有 ADR 0064/0189 的过期说明，以及历史证据/lessons 中的旧命令。
