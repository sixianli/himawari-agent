# 复核结论

未发现会破坏现有产品行为或让 `npm run check` 直接失败的高严重度问题。以下按严重度排列。

## 问题

### 1.[中] 清单漏掉 ADR 要求的“固定主机名”一类（读代码证实）

- 文件:行：`docs/adr/0253-support-linux-arm64-for-test-and-qualification.md:63`；`scripts/check-platform-assumptions.mjs:37-43`；`scripts/platform-assumptions.json:1-125`
- 问题：ADR 的 PR 0 决定写的是“全仓找出写死 `/lib64`、`linux-x64`、`process.arch === "x64"`、**固定主机名**和固定 Python 包名的地方”，但检查只有五类字面模式，没有主机名类别，清单里也没有。
- 证据：
  - ADR 第 63 行：`全仓找出写死 /lib64、linux-x64、process.arch === "x64"、固定主机名和固定 Python 包名的地方，列成清单`
  - 检查只有这五类：`lib64`、`linux-x64`、`arch-x64`、`x86_64`、`python-3.12.10-archive`（`scripts/check-platform-assumptions.mjs:37-43`）
  - 现有代码里确实有固定主机名：`scripts/delivery-mode/hermes/capture-build-source-inputs.template.mjs:115` 的 `os.hostname() === "hermes-home"`；`scripts/operations/hermes-search-time-qualify.py:89` 的 `socket.gethostname()=='hermes-home'`
- 建议：增加 hostname 类别（至少覆盖 `hermes-home` 和 `hostname() === "<literal>"`），重新 `--write` 并补反向用例；或者在 ADR 明确写清这些生产主机守卫不在 PR 0 范围，避免“全仓清点”名不副实。

### 2.[中] 扫描目录与扩展名覆盖面小于 ADR 的“全仓”承诺（读代码证实）

- 文件:行：`scripts/check-platform-assumptions.mjs:8`、`scripts/check-platform-assumptions.mjs:18-31`；`.github/workflows/ci.yml:123`、`:215`
- 问题：只扫 `apps`、`packages`、`scripts`、`test`、`ci`，且只认固定扩展名；`.github/workflows`、`Dockerfile`、`Makefile` 等不会被扫。这与作者列的“五个目录”一致，但与 ADR 的“全仓”和“挡住以后新增的写死”不一致。
- 证据：
  - `export const SCANNED_DIRECTORIES = Object.freeze(["apps", "packages", "scripts", "test", "ci"]);`
  - `SCANNED_EXTENSIONS` 只含 `.ts/.tsx/.mts/.cts/.js/.mjs/.cjs/.json/.sh/.py/.yaml/.yml`
  - 工作流里已有未入清单的写死：`.github/workflows/ci.yml:123` 的 `- key: linux-x64`，`:215` 的 `.../scripts/ci/run-share.mjs get --name build-linux-x64 ...`
- 建议：把 `.github` 纳入扫描并支持无扩展名文件；若有意不扫工作流，在 ADR/PR 说明中明确写出范围，不要用“全仓/挡住新增”作为承诺。

### 3.[中] 五类正则只认少数写法，现有 `arch: "x64"` 已被漏掉（读代码证实）

- 文件:行：`scripts/check-platform-assumptions.mjs:38-42`；`scripts/ci/check-policy.mjs:115`
- 问题：`arch-x64` 只匹配 `arch ==/===/!=/!== "x64"`，不匹配对象字段 `arch: "x64"`；`lib64` 要求前面有 `/`，不匹配 `path.join("/", "lib64")` 或单独的 `"lib64"` 段；`x86_64` 区分大小写，`amd64`、`X86_64` 不匹配；Python 只认完整的 `python-3.12.10.tar.gz`。
- 证据：
  - `arch-x64: /\barch\s*[!=]==?\s*["']x64["']/g`
  - `scripts/ci/check-policy.mjs:115`：`{ key: "linux-x64", runner: linuxRunnerLabel, os: "linux", arch: "x64", node: "22.22.3" }`
- 建议：至少补 `arch\s*[:=]\s*["']x64["']`、`amd64`、大小写不敏感、`lib64` 作为路径段等写法；同时补对应的反向用例。否则“挡住新增写死”会被这些变体绕过。

### 4.[低] ADR 对检查行为的描述与实现不一致（读代码证实）

- 文件:行：`docs/adr/0253-support-linux-arm64-for-test-and-qualification.md:63`；`scripts/check-platform-assumptions.mjs:38`、`:78-88`
- 问题：ADR 说“不在白名单文件里的‘无条件对 `/lib64` 取真实路径’直接失败”，实现却是按“类别 + 文件”计数，没有白名单，也不识别 `realpath` 表达式。删掉同一文件一处旧 `/lib64`、再加一处无条件 `realpath`，净计数不变就会通过。
- 证据：
  - ADR：`加一道检查：不在白名单文件里的“无条件对 /lib64 取真实路径”直接失败`
  - 实现：`if (actual > expected) ... "added" else if (actual < expected) ... "stale"`
- 建议：把 ADR 改成“按文件计数清单”，或实现真正的 `realpath`/白名单检查；如保留计数，明确它不能保证“无条件 realpath”一定被挡。

### 5.[低] 反向用例只覆盖纯比较函数，未覆盖 CLI 退出码和 `--write`（读代码证实）

- 文件:行：`test/tooling/platform-assumptions.test.mjs:47-90`；`scripts/check-platform-assumptions.mjs:96-103`、`:128-130`
- 问题：测试都直接调用 `comparePlatformAssumptions`，没有启动脚本本身，也没有测试 `main()` 的退出码、stderr 或 `--write` 行为。如果 `main()` 的 `process.exitCode` 接错或路径拼错，反向用例仍会全绿。
- 证据：
  - 测试：`expect(comparePlatformAssumptions(recorded, scanPlatformAssumptions(root))).toEqual([...])`
  - 入口：`process.exitCode = main();`
- 建议：加子进程或导出 `main` 的用例：构造临时仓库，断言普通运行返回 1、错误码/关键词正确；断言 `--write` 后清单可再次通过；再补 `.github` 或 `arch: "x64"` 的反向用例。

### 6.[低] `--write` 会无条件覆盖清单，可能把新增写死“洗白”（读代码证实）

- 文件:行：`scripts/check-platform-assumptions.mjs:99-102`
- 问题：开发者新增写死后直接跑 `--write`，清单会被更新为当前代码，检查永远绿；脚本不打印新增/删除项，也没有二次确认。
- 证据：`writeFileSync(inventory, \`${JSON.stringify(observed, null, 2)}\n\`);`
- 建议：`--write` 打印新增/删除的类别、文件和计数；或区分“首次生成”和“更新”，更新时列出 diff 并要求显式参数。

## 侧重检查

- **错误路径**：缺失目录用 `existsSync` 跳过；不可读文件或非法 JSON 会直接抛异常（`readFileSync`、`JSON.parse` 无 catch），退出非零但没有稳定错误码。symlink 目录/文件因 `Dirent.isDirectory()`/`isFile()` 为 false 被跳过，不会死循环或逃出仓库，但 symlink 里的写死也不会被扫。
- **不可信输入**：没有外部输入；只读仓库自身文件，`--write` 路径固定为 `scripts/platform-assumptions.json`，没有命令注入或网络访问。
- **安全**：不读密钥、不输出文件内容，只输出路径和计数；新增的 ADR 和 `.agents/reviews` 不会进入产品请求。
- **资源耗尽**：同步读取所有匹配文件并 `[...text.matchAll(pattern)]` 物化全部匹配；跳过 `node_modules`、`dist`、`build`、`coverage`、`evidence`、`.ci-output`；正则没有灾难性回溯。仓库规模下可接受，但大文件会占内存。
- **不可撤销操作**：`--write` 直接覆盖清单（git 可恢复），主要风险是把新增写死一起提交。
- **规则、文档和代码一致性**：见问题 1-4；其中“不改请求开头”这一点与 diff 的文件列表一致。

## 推测 / 未核实

- `.agents/reviews/topic-arm64-linux/` 在复核副本中被剥离，无法读取 round-4 的 `usage.jsonl` 和答案文件，因此无法核实其中的 `claimsSha256` 是否等于当前 ADR 的 blob。按 `scripts/model-review/plan-claims.mjs:225-228`，如果不一致，合并门会报 `claims-stale`。这是未核实，不是已发现问题。
- 只读环境不能运行仓库命令，因此 `npm run check`、`--write`、biome、`check:docs-links` 的实际结果未核实。
- 清单总数我按 JSON 逐项相加为 `49+133+6+49+14=251`，与作者说的 251 一致；并抽查了 `scripts/ci` 和 `test/tooling` 的计数与 grep 结果一致。`--write` 的实际生成未运行。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。diff 只涉及 `package.json`、`scripts/`、`test/tooling/`、`docs/adr/0253` 和 `.agents/reviews/`，没有改 `apps/*/src`、`packages/*/src`、`packages/prompt-catalog`、`packages/runtime-pi` 或任何请求组装/遮盖路径。因此系统提示、工具定义、历史消息、遮盖结果都不变；发给模型的内容仍然只在末尾追加，每轮会变的值仍然在最后一条消息里。

2. **同一段文字会不会在不同请求里变成不同字节？**
   不会。新检查不参与模型请求序列化。清单生成本身也是确定的：扫描前 `files.sort()`，按 `PLATFORM_ASSUMPTIONS` 固定顺序遍历，`JSON.stringify(observed, null, 2)`，没有时间字段，也没有无序集合。只有“不同文件系统内容/缺失目录”会让生成结果不同，这是预期行为。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有。`check:platform-assumptions` 同时跑脚本和 `test/tooling/platform-assumptions.test.mjs`；测试里有 `added`、`stale`、`unknown` 三个反向用例，逻辑上会让 `comparePlatformAssumptions` 返回对应问题。不足是反向用例只测纯比较函数，没有测 CLI 退出码和 `--write`；也没有覆盖 `.github`、固定主机名或 `arch: "x64"` 这些当前扫不到的写法。

4. **改动产生或修改的每个值，使用它的地方都能接受吗？**
   - `check:platform-assumptions`：产生于 `package.json`，由 `scripts/run-all-checks.mjs` 的 `stepNames` 用 `^npm run (\S+)$` 解析，能接受；`test/tooling/run-all-checks.test.mjs:74` 也会检查每个 step 都是真实 npm script。
   - 清单路径 `scripts/platform-assumptions.json`：产生于 `INVENTORY_PATH`，同时用于 `EXCLUDED_FILES`、读取和写入，前后一致。
   - 清单类别键：产生于 `PLATFORM_ASSUMPTIONS`，由 `comparePlatformAssumptions` 使用；清单里出现未知键会报 `unknown`；现有五个键都能被识别。
   - 文件路径：扫描用 `path.posix.join` 生成正斜杠相对路径，清单也是正斜杠；在 Linux 上两端一致，Windows 按代码推断也一致（未实跑）。
   - ADR 编号 `0253`：文件名匹配 `check-adr-numbers.mjs` 的 `^(\d{4})-[a-z0-9][a-z0-9-]*\.md$`，标题 `# ADR 0253：…` 匹配 `^ADR\s+(\d{4})(?!\d)`；我查到的 `docs/adr/0253*` 只有这一份，编号不重复；链接的 `0176` 和 runbook 文件都存在。
   - `.agents/reviews/topic-arm64-linux`：目录名匹配 `plan-claims.mjs:175` 的 `topic-[a-z][a-z0-9-]*`；但 `usage.jsonl` 和 round-4 答案在复核副本中被剥离，无法核对 `claimsSha256` 与当前 ADR 是否一致，这一点标为未核实。
