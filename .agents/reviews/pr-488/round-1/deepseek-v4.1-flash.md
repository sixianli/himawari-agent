## 读代码证实的问题

### 1【中】`check-lint.mjs` 的本体没有回归测试，I-100 的核心“警告即失败”没有被自动验证

- 文件: `test/tooling/layer0-hooks.test.mjs:48`、`:157`、`:166`、`:224-245`；`scripts/check-lint.mjs:5`、`:13-15`
- 问题: 新加的测试只验证了“钩子会调用 `scripts/check-lint.mjs` 这个文件”“`package.json` 的 `lint` 指向它”“文件失败或缺失时推送被拦下”。没有任何用例真正执行 `scripts/check-lint.mjs`，也没有断言它传给 biome 的参数、退出码和“biome 缺失”分支。对比同文件的 format 检查，`check-format.mjs` 有真实调用的测试（`:186-194` 断言参数 `format .` 和退出码透传，`:218-222` 断言 biome 缺失时退出 1 并打印 `FORMAT_CHECK_UNAVAILABLE`），lint 没有对应项。
- 证据:
  - `scripts/check-lint.mjs:5`：`export const LINT_ARGS = ["lint", "--error-on-warnings", "--diagnostic-level=warn", "."];`
  - `scripts/check-lint.mjs:13`：`const result = spawnSync(process.execPath, [biome, ...LINT_ARGS], { cwd: root, stdio: "inherit" });`
  - `test/tooling/layer0-hooks.test.mjs:48`：fixture 里只写了一个立即退出的桩 `write(root, "scripts/check-lint.mjs", "console.error('LINT_STUB_RAN');\nprocess.exit(0);\n");`
  - `test/tooling/layer0-hooks.test.mjs:157`：只断言 `expect(pushed.stderr).toContain("LINT_STUB_RAN");`
  - `test/tooling/layer0-hooks.test.mjs:166`：只断言 `expect(scripts.lint).toBe("node scripts/check-lint.mjs");`
  - `test/tooling/layer0-hooks.test.mjs:224-227`：失败/缺失用例只覆盖钩子的拒绝码。
- 反向用例结论: 把 `--error-on-warnings` 从 `LINT_ARGS` 删掉，现有自动测试仍会全部通过；只有像 I-100 记录里那样手工运行 `node scripts/check-lint.mjs` 才会发现。也就是说，防止 I-100 再次发生的“参数”这一半没有门槛。
- 建议: 仿照 `formatRoot`/`runFormat` 增加子进程测试：在临时目录放一个假的 `node_modules/@biomejs/biome/bin/biome`，记录 `process.argv.slice(2)` 并返回指定退出码；断言参数恰为 `lint --error-on-warnings --diagnostic-level=warn .`、退出码原样透传；再断言 biome 文件缺失时退出 1 且 stderr 含 `LINT_CHECK_UNAVAILABLE`。注意不要通过 `import { LINT_ARGS }` 测试——该模块顶层会直接执行 lint，导入即有副作用；用子进程或依赖注入更安全。

### 2【低】`npm run lint -- <额外参数>` 不再透传，严格说不是“行为完全一致”

- 文件: `scripts/check-lint.mjs:13`；`package.json:79`
- 问题: 旧命令是 npm 直接把 `npm run lint -- <参数>` 的额外参数追加给 biome；新脚本只使用固定的 `LINT_ARGS`，完全不看 `process.argv`。因此 `npm run lint -- some-file.ts` 会静默地改成全仓 lint，而不是只检查指定文件。
- 证据:
  - `scripts/check-lint.mjs:13`：`spawnSync(process.execPath, [biome, ...LINT_ARGS], ...)`，没有 `process.argv.slice(2)`。
  - `package.json:79`：`"lint": "node scripts/check-lint.mjs",`
- 影响: 我在仓库里没有搜到 `npm run lint --` 的现有用法（现有文档里的定向检查都是直接调 `biome lint ...`），所以当前 CI 和钩子不受影响；但这是与作者“和原 `npm run lint` 相同”的说法不完全一致的一处。
- 建议: 若要保留旧行为，在 `LINT_ARGS` 后追加 `...process.argv.slice(2)`；若不打算支持，建议在文档或脚本文本里说明“lint 固定在仓库根跑全仓，定向检查请直接用 biome”，避免使用者误以为参数会生效。

### 3【低】I-100 文档引用的测试名称与实际覆盖不完全一致

- 文件: `docs/incidents-and-gates.md:134`；`test/tooling/layer0-hooks.test.mjs:161-168`
- 问题: I-100 把 `runs the same format check at push as npm run format:check` 列为 lint 的门槛，并把“与 `npm run lint` 同一条命令”写成已落门槛的一部分；但这个用例实际只断言 `package.json` 里 `scripts.lint` 的字符串，没有验证 `check-lint.mjs` 真正执行了什么命令。用例标题也仍然只写 format。
- 证据:
  - `test/tooling/layer0-hooks.test.mjs:161`：`it("runs the same format check at push as npm run format:check", () => {`
  - `test/tooling/layer0-hooks.test.mjs:166`：`expect(scripts.lint).toBe("node scripts/check-lint.mjs");`
  - `docs/incidents-and-gates.md:134`：`...“runs the same format check at push as npm run format:check”。把那行警告放回去时 node scripts/check-lint.mjs 退出码 1，修好后 0`
- 建议: 把 lint 的断言拆成独立用例并改名（例如 “runs the same lint check as the old npm run lint”），同时补上第 1 条建议的真实参数/退出码测试，再让 I-100 引用该用例；否则文档的“已落门槛”比实际自动检查强。

## 推测 / 未核实

- 我无法运行测试或 lint：当前是稀疏检出，`node_modules` 不存在，也没有运行权限。因此“测试实际通过”“单跑约 5 秒、并行 6.7 秒”以及 pre-push 新增 lint 的实际耗时都未核实。
- `@biomejs/biome` 的 `bin/biome` 在 2.3.5 中是否为可直接用 `node` 执行的包装脚本，我是根据 `package-lock.json:637-639` 的 `"bin": { "biome": "bin/biome" }` 和同仓库 `check-format.mjs` 的既有写法推断的；`node_modules` 不在检出中，未实际执行确认。风险很低，因为 format 脚本长期使用同一模式。
- `.github/workflows/ci.yml` 的 static 路径已通过 `git show` 读到并确认，但未实际跑过 CI。

## 侧重检查

- 错误路径:
  - biome 不存在: `scripts/check-lint.mjs:9-11` 打印 `LINT_CHECK_UNAVAILABLE` 并 `process.exit(1)`，失败关闭，合理。
  - `spawnSync` 自身出错（如 node 无法启动子进程）: `:14` 打印 `LINT_CHECK_UNAVAILABLE`，`:15` 因 `result.status` 为 `null` 退出 1，失败关闭，合理。
  - biome 被信号终止: `result.status` 为 `null`，最终退出 1，不会误报成功。
  - 脚本缺失: `scripts/git-hooks/pre-push:12-15` 中 `node` 会非零退出，随后打印 `PUSH_LINT_CHECK_FAILED` 并 `exit 1`，测试 `:238-245` 覆盖了缺失场景。
- 不合规范或不可信的输入: `check-lint.mjs` 不接收外部输入，参数是常量；`pre-push` 用引号包裹 `$root`，没有 shell 注入面。`cwd` 由脚本自身位置推出，而不是依赖调用者当前目录，合理。
- 安全: `biome lint` 在本改动中未带 `--write`/`--fix`，只读；没有网络调用；不涉及密钥或不可撤销操作。
- 资源耗尽: pre-push 现在每次推送都会全仓 lint，包括纯文档推送，且没有超时。失败提示本身合理；耗时未实测。若 lint 在全仓上明显慢于 format，会给每次推送增加固定等待，但这是为了拦住只有 CI 才会发现的警告，属于可接受取舍。若担心挂死，可与现有 format 步骤一致地保持无超时，或后续统一加超时。
- 规则/文档与代码一致性:
  - I-100 的路径都能被 `check-incident-gates` 找到；行内 7 列、日期、次数、状态均符合 `scripts/check-incident-gates.mjs:46-70` 的校验。
  - “与 `npm run lint` 同一条命令”基本成立，但额外参数不透传（见问题 2），且该等价性没有自动测试（见问题 1、3）。
- 测试夹具影响: 只有 `test/tooling/layer0-hooks.test.mjs` 会复制 `scripts/git-hooks` 并驱动 pre-push；它已经在 `:48` 加了 lint 桩，其他用例不会因为缺少桩而失败。没有发现别的测试依赖旧的 pre-push 步骤集合。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。这个 diff 只改了 `docs/incidents-and-gates.md`、`package.json`、`scripts/check-lint.mjs`、`scripts/git-hooks/pre-push` 和两个 tooling 测试；没有触碰系统提示、工具定义、历史消息、遮盖或请求组装代码。也没有发现 `docs/incidents-and-gates.md` 被塞进产品模型请求的路径（`scripts/model-review` 里没有引用它）。因此发给模型的内容仍然只在末尾追加，本改动没有引入任何每轮会变的值。依据：[prompt-prefix 规则第二节](../../.claude/rules/prompt-prefix.md#append-only)。

2. **会不会让同一段文字在不同请求里变成不同的字节？**
   不会。本改动不涉及模型请求内容的序列化、遮盖或顺序；新增的只是本地进程调用和错误输出，`path.relative` 等结果只出现在终端错误信息里，不进入模型请求。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   推送接线有：删掉 `pre-push` 里的 lint 段，`test/tooling/layer0-hooks.test.mjs:157` 和 `:224-245` 会失败。`check-lint.mjs` 本体没有：删掉 `--error-on-warnings`、改坏参数、或让 biome 缺失分支失效，现有测试都不会失败。因此 I-100 说的“警告即失败”目前只有手工验证，自动门槛不完整。

4. **每个新值的使用方都能接受吗？**
   逐个核对的结果：
   - `scripts.lint = "node scripts/check-lint.mjs"`：`check:steps`（`package.json:27`）经 `scripts/run-all-checks.mjs:32,36` 按名字执行，接受任意 npm script；`scripts/ci/run.mjs:248` 的 static 通过 `npm run check` 间接走到它；`layer0-hooks.test.mjs:166` 精确断言该字符串。CI 路径成立。
   - `scripts/check-lint.mjs` 路径：pre-push、package.json、测试 fixture、I-100 门禁路径都存在且可用。
   - `LINT_ARGS`：与旧命令的默认参数一致；但没有任何测试或其它使用方校验它，是第 1 条问题的根源。
   - `LINT_CHECK_UNAVAILABLE` / `PUSH_LINT_CHECK_FAILED`：没有外部解析器依赖固定文案，pre-push 只看退出码；测试只断言 `PUSH_LINT_CHECK_FAILED`，不校验 `LINT_CHECK_UNAVAILABLE`。
   - I-100 行：符合 `check-incident-gates` 的列数、日期、次数、状态和路径存在性校验。
   - `60000` 超时：vitest 接受；同文件已有 10 处同样的 `}, 60000)`，一致。
   - 测试桩：只有 `layer0-hooks.test.mjs` 使用 pre-push 夹具，已补桩，没有发现其它用例缺桩。
   总体结论：使用方都能接受这些值；不足在于 `LINT_ARGS`/`LINT_CHECK_UNAVAILABLE` 的行为没有被自动检查覆盖，且文档引用的测试名与实际覆盖面不一致。
