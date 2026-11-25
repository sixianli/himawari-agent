### 1. 中：trace 检查在没产生预期 trace 时会静默通过，无法证明“任何维护子进程出现就失败”
分类：读代码证实
文件：`scripts/delivery-mode/packet-template/install/verify-source-cache-fixtures.mjs:74`、`:78-79`
问题：检查只看 `spawned.length === 0`。若 `GIT_TRACE` 没有产生 `run_command:` 行（git 改了格式、trace 被环境变量覆盖、旧版走 `gc --auto`），或者实际 spawn 的是 `git gc --auto`，过滤结果同样是空数组，检查就通过。夹具没有先断言 trace 里确实出现了已知命令行，所以“没有维护”和“没有 trace”无法区分。
证据：
```js
const tracedRun = (command, args) => execFileSync(command, args, { env: { ...env, GIT_TRACE: trace }, ... }).trim();
const spawned = readFileSync(trace, "utf8").split("\n").filter((line) => /run_command: .*\bmaintenance run\b/.test(line));
check("cache fetches and checkouts start no automatic git maintenance ...", spawned.length === 0, ...);
```
建议：先断言 trace 至少包含本夹具确实执行过的命令（例如 `built-in: git fetch`、`run_command: git bundle verify`），再把匹配扩成 `(maintenance run|gc --auto)`；或给 fetch 加显式的 `--no-auto-maintenance --no-auto-gc`，让被检查的行为不依赖 trace 文案。

### 2. 低：反向用例不是自动检查，“修复前失败”无法从仓库回归验证
分类：读代码证实（只证实缺少反向检查；作者的“修复前失败”结论未核实）
文件：`scripts/delivery-mode/packet-template/install/verify-source-cache-fixtures.mjs:78-79`、`scripts/delivery-mode/test_make_packet.py:1311-1314`
问题：仓库里的自动检查只有正向断言。作者说“fixture 的 trace 检查在修复前失败”，但这只是提交说明里的手工结论，没有提交一个会实际验证检测器能抓到维护子进程的用例。以后正则或 trace 格式变化，测试可能一直通过却不再守护原来的 bug。
证据：
```python
def test_the_cache_fixtures_pass_against_real_git(self):
    child = subprocess.run(['node', str(HERE / 'packet-template/install/verify-source-cache-fixtures.mjs')], ...)
    self.assertEqual(child.returncode, 0, child.stdout + child.stderr)
    self.assertTrue(json.loads(child.stdout)['passed'])
```
建议：把过滤逻辑抽成函数并加单元测试，用含 `run_command: git maintenance run --auto` 和 `run_command: git gc --auto` 的合成 trace 断言会命中；或在夹具里额外跑一次故意不禁用维护的命令，要求检测器报错。

### 3. 低：其他真实 git 临时仓库的测试仍未禁用自动维护，同类 ENOTEMPTY 可能在别处重现
分类：推测（未在 git 2.56 上复现）
文件：`scripts/delivery-mode/test_deploy.py:1051-1059`、`scripts/delivery-mode/make-packet.py:900-902`
问题：这次只改了 `source-cache.mjs` 与源码缓存夹具；测试里仍会临时创建/克隆 git 仓库并执行 `commit` 等命令，但没有 `-c maintenance.auto=false`。如果这些步骤在 git 2.56 上也会后台启动维护，`TemporaryDirectory`/临时克隆目录的清理仍可能撞上同样的竞态。
证据：
```python
subprocess.run(['git', 'clone', '-q', '--bare', str(work), str(cache)], check=True)
subprocess.run(['git', 'clone', '-q', '--shared', '--no-checkout', str(REPO), str(clone / 'repo')], check=True)
```
建议：这些测试的 git 调用统一加 `-c maintenance.auto=false`（或 `--no-auto-maintenance`），至少给 `test_the_remote_check_reads_the_real_cache` 这类会 clone 后清理目录的用例加上。

### 4. 低：安装助手的 checkout git 调用没有带新配置，与“每个 cache 和 checkout git 调用都设置”的说法不符
分类：读代码证实（功能性影响未发现）
文件：`scripts/delivery-mode/packet-template/install/__PKT_LABEL__-artifact-install.mjs:46`、`:50`、`:73`、`:97`；对照 `scripts/delivery-mode/packet-template/install/source-cache.mjs:5`
问题：提交说明称“每个 cache 和 checkout git 调用”都设置 `maintenance.auto=false`，但安装助手在 checkout 上直接调 `git bundle list-heads`、`git rev-parse`、`git status`，都没有该参数。好在这些是只读命令，通常不会触发自动维护，所以不是功能错误，只是说法与代码不一致。
证据：
```js
fail(run("git", ["bundle", "list-heads", bundle], "bundle-heads") === `${head} HEAD`, ...);
fail(run("git", ["-C", checkout, "rev-parse", "HEAD"]) === head && run("git", ["-C", checkout, "status", ...]) === "", ...);
```
建议：改准提交说明；若要严格一致，也给安装助手的这些 git 命令加上同一组 `-c`。

### 5. 低：禁用自动维护后源码缓存不再自动打包/清理不可达对象，文档未记录这个后果
分类：推测（由代码行为推导，实际磁盘影响未测量）
文件：`scripts/delivery-mode/packet-template/install/source-cache.mjs:5`；`docs/adr/0151-ship-incremental-source-bundles-to-a-server-side-cache.md:42`、`:59-64`
问题：缓存设计为“只增不减”，`release-cleanup` 也不碰它；以前 `git fetch` 的自动维护可能在达到阈值时重打包、清理不可达对象。现在一律禁用，长期多次发布后 loose object 和不可达对象只能靠人工维护，ADR 没有说明这个变化。当前缓存约 118MB，影响应有限。
证据：`quietGit` 固定带 `-c maintenance.auto=false`；ADR 0151 写“缓存只增不减，`release-cleanup.py` 只清理 `releases`、`operations` 等指定目录，不碰缓存”。
建议：在 ADR 0151 的“后果”或安装说明里写明禁用自动维护及其理由；如担心增长，在安装完成后由脚本对缓存显式运行一次受控的 `git gc`/`maintenance`，而不是依赖 fetch 后台任务。

**作者说法核对（读代码能确认的部分）**
- “加 `-c maintenance.auto=false`”属实：`source-cache.mjs:5`。
- “夹具加 `GIT_TRACE` 检查”属实：`verify-source-cache-fixtures.mjs:71-79`。
- “任何维护子进程出现就失败”不准确：只匹配 `maintenance run`，不匹配 `gc --auto`，也不校验 trace 是否真的产生（见意见 1）。
- “每个 cache 和 checkout git 调用都设置”不准确：安装助手的若干 checkout 调用没有设置，虽然这些调用是只读的（见意见 4）。
- “夹具的 trace 检查在修复前失败”仓库内无自动反向用例，未核实。

**侧重检查**
- 错误路径：`finally` 里的 `rmSync(root, { recursive: true, force: true })` 仍是唯一清尾；新增 trace 文件位于 `root` 内，读取发生在删除前，没有新增清理顺序问题。`readFileSync(trace)` 若文件缺失会直接抛错让夹具失败，不会静默通过；但 trace 格式不符或没有 `run_command` 行时会静默通过（见意见 1）。
- 不合规范或不可信输入：本改动没有新增外部输入。`GIT_TRACE` 只由夹具设置，生产安装路径不设置；`HIMAWARI_TEST_TEMP_ROOT` 的使用与原来相同。
- 安全：`-c maintenance.auto=false` 只作用于单次 git 进程，不写仓库或全局配置，命令行配置优先级高于仓库配置；没有引入删除、提权或网络操作。`core.hooksPath=/dev/null` 仍是原有防护。
- 资源耗尽：见意见 5；trace 文件很小，本身不是资源风险。
- 不可撤销操作：没有。禁用维护只会减少后台操作，不会删除 ref、对象或已安装内容。
- 规则/文档一致性：ADR 0151、`install/P5-new-prefix.md` 未提到禁用自动维护；提交说明有两处与代码不完全一致；仓库没有写最低 git 版本。生产机是 Ubuntu 24.04、Hermes 是 Ubuntu 22.04（文档明确），但两者的具体 git 版本未在仓库中核实。

**必答问题**
1. 不会改变模型已经见过的请求开头。改动只在 `scripts/delivery-mode/packet-template/install/` 下的两个交付脚本，不碰系统提示、工具定义、历史消息、遮盖或压缩。发给模型的内容仍按 `prompt-prefix.md` 的规则只在末尾追加，每轮会变的值仍应只在最后一条消息里。
2. 不会让同一段文字在不同请求里变成不同字节。这里改的是 git 仓库的本地维护行为，不涉及发给模型的文本序列化；git 对象内容按哈希寻址，检出的源码树字节也不因是否打包维护而改变。唯一“随环境变化”的是测试结果本身：不同 git 版本的 `GIT_TRACE` 格式可能不同（见意见 1）。
3. 有正向自动检查：夹具已列入 `run-packet-checks.py:15` 的 `NODE_FIXTURES`，并由 `test_make_packet.py:1300-1314` 在真实 git 上运行。反向用例没有提交成自动检查；作者“修复前失败”的说法是手工验证，仓库里没有记录，无法核实。另外检测器存在“没有 trace 也通过”的假阴性（见意见 1）。
4. 产生处是 `source-cache.mjs:5` 和夹具的 `git()` 助手 `verify-source-cache-fixtures.mjs:10`；使用方是 git 本身，仓库里没有解析或校验这个配置键的代码。`source-cache.mjs` 的所有 git 调用都通过 `quietGit` 带上了它；安装助手的若干只读 checkout 调用没带，但不会触发自动维护。旧版 git 对 `git -c` 的未知键不会报错：它接受任意 `section.key=value`，`false` 是合法布尔值；只是 2.29 以前不认这个键，那时 `fetch` 走的是 `gc --auto` 路径，这个配置就不起作用（生产是 Ubuntu 24.04，按发行版通常版本为 git 2.43，但未在机器上核实，所以实际不构成当前问题）。`GIT_TRACE` 的 `run_command:` 行在现代 git 上存在，但本仓库没有断言这一点，也没有测过不同版本，属于未核实项；格式变化时夹具会静默通过，这是意见 1 要补的洞。
