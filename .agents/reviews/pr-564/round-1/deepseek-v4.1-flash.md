## 侧重检查

我读了 `check-repo-hygiene.mjs`、`ui-review-artifacts.mjs`、`xcode-cache.sh`、`xcode-build.sh`、`ui-review.sh`、`mac-ui-review.sh`、`prune-local.py`、`prune-rebuildable.py`、`install-schedule.sh`、两份 JSON 配置、相关测试、ADR 0276、`.agents/instructions/disk-space-hygiene.md`、`clients/apple/README.md` 和 `pre-push`。受工具限制没有运行测试，以下结论来自读代码和 `git diff`。

侧重检查过的路径和结论：

- 不可信清单/文件：`fetch` 会先写已核对的文件，后面的文件失败时前面已经落盘（读代码证实，见意见 1）；`publish` 会跟随符号链接读取目标文件（读代码证实，见意见 9）。
- 不可撤销删除：`retention.json` 的路径值只有非空字符串校验，没有根目录边界；工作副本回收没有排除 `--repo` 自己，也没有拒绝符号链接（读代码证实，见意见 3、4）。旧上线包按日期保留，不读实际在服务/回滚版本（推测风险，见意见 6）。
- 并发/锁：正常退出和失败退出都会走 `trap` 释放锁，死进程的锁可被接管；但释放锁不校验所有权，陈旧的 `.lock` 目录会被永久保留（读代码证实，安全性影响低）。
- 资源耗尽：`fetch`/`publish` 把文件整个读进内存，`git show` 的 `maxBuffer` 为 1GB；恶意引用可以让云端线程耗内存/磁盘，但正常的 `git fetch` 本身也会下载对象，不算本 PR 新引入的主要风险。
- 文档/规则一致性：发现进程名单、`PRUNE_RESULT`、`check-ignore`、截图脚本末尾回收等几处说法与代码不一致（见意见 5、12）。
- `.github` 目录不在当前稀疏检出里，**CI static 作业是否真的跑 `check:repo-hygiene` 未核实**。

## 复核意见

### 1. 中 — `fetch` 在清单不匹配时已经写出前面的文件，违背“一个文件都不写出”

文件:行：`scripts/ui-review-artifacts.mjs:130-139`

问题：函数先 `mkdirSync(out)`，然后在循环里逐个核对并立即 `writeFileSync`。如果清单里第一个文件匹配、第二个文件不匹配，第一个文件已经留在 `--out` 目录里。作者的说法“任何一个文件对不上清单时一个文件都不写出”不成立。

证据：

```js
132:     for (const file of manifest.files) {
133:       if (!FILE_NAME.test(file.path))
134:         throw new Error(`UI_REVIEW_ARTIFACT_FILE_REJECTED ${file.path}`);
135:       const content = git(cwd, ["show", `${local}:${file.path}`], { binary: true });
136:       if (content.length !== file.bytes || sha256(content) !== file.sha256)
137:         throw new Error(`UI_REVIEW_MANIFEST_MISMATCH ${file.path}`);
138:       writeFileSync(join(out, file.path), content);
139:     }
```

现有反向用例只放了单个文件 `a.png`（`test/tooling/ui-review-artifacts.test.mjs:94-119`），所以测不到“前面文件已写出、后面文件失败”的情况。

建议：先把所有文件读入临时目录或内存并全部核对，最后再整体移入 `out`；失败时删除本次创建的 `out` 内容，并补一个“两个文件、第二个被篡改、断言 `out` 为空”的反向用例。

### 2. 中 — 推送前钩子检查的是当前 `HEAD` 相对 `origin/main`，不是实际推送的引用

文件:行：`scripts/git-hooks/pre-push:20`、`scripts/check-repo-hygiene.mjs:82-90`

问题：`pre-push` 直接运行 `check-repo-hygiene.mjs`，没有把 git 通过标准输入传进来的待推送引用交给脚本；脚本默认基准是 `origin/main`，比较对象是当前 `HEAD`。因此 `git checkout main; git push origin feature-with-bigfile`、`git push --all`、推送当前未检出的分支时，钩子检查的不是实际要推的提交，可以绕过这个大文件阻断。ADR 0276 第 90 行说“推送前钩子用待推送的提交”，与代码不一致。

证据：

```js
// scripts/git-hooks/pre-push
20: node "$root/scripts/check-repo-hygiene.mjs" >&2 || {

// scripts/check-repo-hygiene.mjs
83:   const reference = env.HIMAWARI_REPO_HYGIENE_BASE ?? "origin/main";
85:     return git(root, ["merge-base", "HEAD", reference]).trim();
```

建议：`pre-push` 读取 stdin 的 `<local ref> <local sha> <remote ref> <remote sha>`，对每个非删除的 local sha 调检查；脚本支持 `--commit <sha>` 或环境变量指定待检查提交，基准按该提交算 `merge-base`。至少要在 `HEAD` 与待推 local sha 不同时报错退出，而不是静默检查 `HEAD`。

### 3. 中 — `retention.json` 的路径值没有边界校验，定时 `--apply` 可删到配置指定的任意目录

文件:行：`scripts/disk-hygiene/prune-local.py:52-54`、`158-164`、`145-149`、`96-101`

问题：`appleCache`、`legacyXcodeDirs` 只校验“非空字符串”或“非空字符串列表”，没有拒绝绝对路径、`..`、符号链接根目录；删除时也没有用已有的 `inside()` 再确认目标在允许根目录下。`appleCache` 被设成 `~/Documents` 时，脚本会删除 `~/Documents/DerivedData/*`；`legacyXcodeDirs` 写 `../..` 时，候选路径会跑出仓库。ADR 0276 第 109 行说“删除前……解析后仍在允许的根目录下”，代码没有做到。

证据：

```python
52:     for key in ('appleCache', 'tmpXcodePrefix'):
53:         if not isinstance(config.get(key), str) or not config[key]:
54:             problems.append(key)

158:     cache = Path(os.path.expanduser(config['appleCache'])) / 'DerivedData'
...
162:         candidates += [repo / relative for relative in config['legacyXcodeDirs'] if (repo / relative).is_dir()]

145: def remove_tree(path):
147:     if target.is_symlink():
148:         raise OSError('refusing a symbolic link')
149:     shutil.rmtree(target)
```

建议：配置加载时拒绝绝对路径和含 `..` 的 `legacyXcodeDirs`，把 `appleCache` 限定在明确允许的缓存根；删除前统一用 `inside(path, allowed_root)` 校验并 `lstat` 拒绝符号链接。也可以把 `retention.json` 的哈希写进安装记录，避免定时任务读到未审阅的配置。

### 4. 中 — 工作副本回收没有排除“当前 `--repo` 自己”，也不拒绝符号链接

文件:行：`scripts/disk-hygiene/prune-local.py:233`、`258`

问题：`git worktree list` 的第一个条目是主工作副本，代码直接 `entries[1:]`，但如果 `--repo` 本身是一个链接工作副本（`git worktree add` 建出来的目录），当前目录会出现在 `entries[1:]` 里；只要它已合入、干净、过期、没有进程以它为 cwd，就可能被自己的脚本 `git worktree remove`。此外删除前没有检查 `path.is_symlink()`，与 ADR 0276 第 104、109 行“删除前确认不是符号链接”不一致。

证据：

```python
233:     for entry in entries[1:]:
...
258:         run.delete('worktree', path, size, lambda path=path: git(repo, 'worktree', 'remove', str(path)))
```

建议：在循环里先跳过 `path.resolve() == repo.resolve()`，并拒绝 `path.is_symlink()`；最好再把可删除的工作副本限定在配置的 `worktreeParents` 或 `git worktree list` 明确登记的路径内。

### 5. 中低 — `--skip-if-busy` 没有包含 Xcode 进程，ADR 说的“整轮跳过”没有实现

文件:行：`scripts/disk-hygiene/prune-local.py:313-319`、`scripts/disk-hygiene/prune-rebuildable.py:16`、`docs/adr/0276-...md:99`

问题：`--skip-if-busy` 用的是旧的 `BUSY_PATTERN`（vitest/playwright/scripts/ci/npm），没有 `xcodebuild`、`simctl`、`swiftc`。因此 Xcode 正在编译时，整轮不会跳过；只是 `prune_xcode()` 自己检测到 Xcode 忙后不删 Xcode 缓存。工作副本和旧上线包仍会被处理。作者说的“Xcode 正在编译时不删缓存”对缓存部分成立，但“`--skip-if-busy` 在有构建进程时整次跳过”不成立，也与 ADR 第 99 行“进程名单加上 xcodebuild、simctl、swiftc”不一致。

证据：

```python
15: XCODE_BUSY_PATTERN = r'xcodebuild|simctl|swift-frontend|swiftc'
...
314:         host, _ = rebuildable.busy_processes(rebuildable.BUSY_PATTERN, options.proc_root)
319:     xcode_busy = bool(rebuildable.busy_processes(XCODE_BUSY_PATTERN, options.proc_root)[0])
```

建议：`--skip-if-busy` 改成检查 `BUSY_PATTERN` 与 `XCODE_BUSY_PATTERN` 的并集，或者明确拆成两个开关并把文档改成“只跳过 Xcode 缓存清理”。

### 6. 中低 — 旧上线包只按日期保留 3 个，不核对实际在服务和回滚目标

文件:行：`scripts/disk-hygiene/prune-local.py:275-287`、`docs/adr/0276-...md:105`

问题：代码按包名日期排序后直接保留前 `keepPackets` 个，不读“当前在服务版本”和“回滚目标”的实际状态。ADR 假设“当前在服务的和它的回滚目标是最近上线的两个”，但如果连续出现两个已打包未上线或部署失败的包，真正的回滚目标可能落到第 4 个及以后，脚本会开始删它的大文件。这一点属于**推测**，需要结合部署记录确认。

证据：

```python
276:             packets.sort(key=lambda child: (child.name[:10], child.stat().st_mtime), reverse=True)
277:             for packet in packets[config['keepPackets']:]:
...
285:                         if status.st_size <= config['packetSlimFileBytes'] or status.st_mtime >= cutoff:
286:                             continue
287:                         run.delete('packet-file', path, status.st_size, path.unlink)
```

建议：不要让回收脚本只凭日期推断线上状态；从部署记录/软链/状态文件读取当前版本和回滚版本，或把“必须保留的上线包”显式写进 `retention.json`，再按日期收缩其余包。

### 7. 低中 — `xcode-build.sh` 只拦截精确的 `-derivedDataPath`，`-derivedDataPath=...` 可以绕过

文件:行：`clients/apple/scripts/xcode-build.sh:10-12`

问题：循环只匹配完整的 `-derivedDataPath`，`xcodebuild` 也接受 `-derivedDataPath=/tmp/dd-123` 这种单参数形式，脚本会放行并让调用者重新制造按 PR 的编译缓存。

证据：

```bash
10: for argument in "$@"; do
11:   case "$argument" in -derivedDataPath) echo "XCODE_BUILD_DERIVED_DATA_GIVEN ..." >&2; exit 2 ;; esac
12: done
```

建议：匹配 `-derivedDataPath` 和 `-derivedDataPath=*`，并补一个反向用例。

### 8. 低中 — `--approve` 在旧快照已移走后失败时不会恢复旧快照

文件:行：`clients/apple/scripts/ui-review.sh:71-73`

问题：作者说法“不齐全时旧截图不动”对“源目录缺场景”和“拷贝后缺场景”成立。但如果 `mv "$snapshots" "$previous"` 成功后，`mv "$staged" "$snapshots"` 失败（权限、跨文件系统等），脚本直接退出，旧快照留在 `.previous-$$`，`snapshots` 目录不存在，不会回滚。这是低概率但确实的非原子替换。

证据：

```bash
71:   [ ! -d "$snapshots" ] || mv "$snapshots" "$previous"
72:   mv "$staged" "$snapshots"
73:   rm -rf "$previous"
```

建议：在这两步外面加 `trap`，失败时把 `previous` 移回 `snapshots`；或先确认 `staged` 与 `snapshots` 在同一文件系统再执行。

### 9. 低 — `publish` 跟随符号链接，可能把链接目标当成截图推走

文件:行：`scripts/ui-review-artifacts.mjs:56-60`、`68`

问题：`statSync(...).isFile()` 和 `readFileSync` 都会跟随符号链接；截图目录里若有 `secret.png -> ~/.ssh/id_rsa`，脚本会把目标内容作为 `secret.png` 推送到一次性引用。文件名和扩展名校验不能阻止这种情况。

证据：

```js
56:   const names = readdirSync(dir)
57:     .filter((name) => statSync(join(dir, name)).isFile())
...
68:       const content = readFileSync(join(dir, name));
```

建议：改用 `lstatSync` 并拒绝符号链接，只接受普通文件；同时确认 `resolve(join(dir, name))` 仍在 `dir` 内。

### 10. 低 — `R100` 改名被跳过且只按目的地识别生成文件，可以把已跟踪截图改名到普通目录

文件:行：`scripts/check-repo-hygiene.mjs:112-115`、`164-173`、`test/tooling/repo-hygiene.test.mjs:112-123`

问题：检查明确跳过 `R100`（完全相同的改名），而“被跟踪的生成文件”只检查当前路径是否以 `clients/apple/ui-review/latest/` 等目录开头、是否以 `.mp4/.mov` 结尾。把旧 main 里已跟踪的 `clients/apple/ui-review/latest/foo.png` 纯改名到 `docs/foo.png`，这次 diff 里是 `R100`，不会被大小检查，新路径也不是配置里的生成目录，因此能通过。测试还专门断言“纯改名已有大文件通过”，所以这是有意行为，但它和“截图不再进 main”的目标有缝隙。

证据：

```js
113:     if (kind === "R" && status === "R100") continue;
...
165:     const generatedPath = config.generatedPaths.find((prefix) => path.startsWith(prefix));
166:     const extension = config.generatedExtensions.find((suffix) =>
167:       path.toLowerCase().endsWith(suffix),
168:     );
```

另外，作者说“只看 merge-base...HEAD 的新增和修改”并不完整：`trackedFiles(root)` 和 `ignoredPaths(...)`（`check-repo-hygiene.mjs:184-189`）会扫描全仓库，不只看 diff。

建议：当 `R100` 的源路径落在 `generatedPaths` 或生成扩展名下时，不要跳过；至少对“从生成目录移出”的改名按新增文件检查。若要保留“纯改名不检查”的规则，就明确它只适用于非生成目录之间的改名，并加反向用例。

### 11. 低 — 几条关键声明的反向用例缺失

文件:行：`test/tooling/ui-review-artifacts.test.mjs:94-119`、`test/tooling/apple-xcode-cache.test.mjs:52-69`、`test/tooling/apple-xcode-cache.test.mjs:159-167`、`scripts/disk-hygiene/test_prune_local.py:74-196`

问题：现有测试覆盖了不少正向和部分反向路径，但以下声明的关键反例没有用例：

- `fetch` 多文件中后面的文件不匹配时是否一个都不写（现有只测单文件，见意见 1）。
- `fetch` 失败时临时 ref 是否真的删除。
- `xcode-build.sh` 的锁在 `xcodebuild` 失败时是否释放（现有只测成功）。
- `--approve` 在 `mv` 中途失败时旧快照是否恢复。
- `prune-local.py` 在 `xcodebuild` 运行时是否整轮跳过、`origin/main` 缺失、`lsof`/`/proc` 不可用、`git status` 失败时是否保留（现有只有合并/脏/忽略/锁/保留清单等用例）。

建议：按上面每一条补一个反向用例，尤其是 `fetch` 多文件和 `prune-local` 的“判断失败一律保留”。

### 12. 低 — 文档与代码的其他不一致

文件:行：`docs/adr/0276-...md:91`、`109`；`scripts/disk-hygiene/prune-local.py:326`

问题：

- ADR 说“截图脚本结束时也跑一次”`prune-local`（第 99 行），但 `ui-review.sh` 和 `mac-ui-review.sh` 里没有任何 `prune-local` 调用（grep 无结果）。
- ADR 第 109 行说结果写成 `PRUNE_RESULT`，新脚本实际输出 `PRUNE_LOCAL_RESULT`（`prune-local.py:326`）。
- ADR 第 91 行说用 `git check-ignore --no-index` 查被强制加入的文件，实际被跟踪生成文件是用 `git ls-files` 查的（`check-repo-hygiene.mjs:130-132`、`184-185`），`check-ignore` 只用于 `mustBeIgnored` 探针。

证据：

```python
326:     print('PRUNE_LOCAL_RESULT ' + json.dumps({'mode': 'apply' if options.apply else 'dry-run', ...}))
```

建议：要么在截图脚本退出时真正调用一次 `prune-local`，要么删掉 ADR 的这句话；把 ADR 里的日志键名和检查手段改成代码实际行为，避免后来的人按文档排查时找不到对应输出。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**

不会改变产品模型请求。这个 PR 只改了工具脚本、shell、Python、JSON 配置、测试和文档，没有改 `packages/prompt-catalog`、模型适配器、系统提示组装、工具定义、历史存储或出口遮盖。也没有引入“每轮会变”的值进入请求开头。发给模型的内容仍然只在末尾追加，每轮变化的值仍然只能放在最后一条消息里。

需要说明：`.agents/instructions/disk-space-hygiene.md` 新增了一行。如果某个代理工具确实把 `.agents/instructions` 拼进自己的系统提示，那么那个代理会话的开头会变一次；但它不是 Himawari 产品对话的请求，也不涉及本 PR 的模型请求路径。**该代理工具是否这样拼装未核实。**

**2. 会不会让同一段文字在不同请求里变成不同字节？**

没有发现。新增的清单 `manifest.json` 对文件按名称排序，对象键顺序固定，没有时间戳；检查脚本、配置和清理脚本都不进入模型请求。没有新增依赖前后文的遮盖、带时间的字段或无序集合。`publish` 产生的 git 提交哈希会因提交时间不同而不同，但提交哈希不是发给模型的文字。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**

部分有。`repo-hygiene` 覆盖了大文件、总量、白名单、缺基准、工作副本目录未忽略等；`ui-review-artifacts` 覆盖了推送/取回、非法文件名、单文件篡改；`xcode-cache` 覆盖了锁超时、死锁接管、成功释放；`prune-local` 覆盖了缓存、工作副本、旧上线包、坏配置；`--approve` 覆盖了完整替换和缺场景不替换。

但关键反向用例有缺口：意见 1 的多文件部分写出、意见 5 的 Xcode 忙时整轮跳过、意见 3 的路径越界、意见 4 的当前工作副本/符号链接、意见 8 的移动失败回滚、意见 11 列出的其他路径都没有测试。尤其是“`fetch` 任意文件不匹配时一个文件都不写出”这条声明，如果补上两文件用例，按当前代码会失败。

**4. 改动产生或修改的每个值，使用它的地方都能接受吗？**

逐个核对的结果：

- `scripts/repo-hygiene/config.json` 的 `schemaVersion`、`maxFileBytes`、`maxChangeBytes`、`generatedPaths`、`generatedExtensions`、`mustBeIgnored`、`allowedLarge` 都被 `parseConfig`/`evaluate` 使用，类型和结尾斜杠要求一致；`.gitignore` 里的三个目录与 `mustBeIgnored` 一致。未发现键名或格式错配。
- `scripts/disk-hygiene/retention.json` 的 `schemaVersion`、`minAgeHours`、`appleCache`、`xcodeIdleDays`、`legacyXcodeDirs`、`tmpXcodePrefix`、`worktreeIdleDays`、`worktreeKeep`、`worktreeIgnoredAllowed`、`worktreeParents`、`keepPackets`、`packetSlimFileBytes`、`packetKeepSuffixes` 都被 `load_config` 和对应处理函数使用，安装脚本也原样复制到 `~/.local/share/himawari/retention.json`。键名没有漏配。**但路径值没有边界校验，见意见 3。**
- `refs/review-artifacts/pr-<pr>/<batch>` 在 `publish`、`fetch`、`delete`、`list` 中由同一个 `artifactRef` 生成和校验；`manifest.json` 的 `schemaVersion`、`pr`、`batch`、`files[].path/bytes/sha256` 生产端和消费端字段一致；路径和批次的字符集校验两端一致。
- `.gitignore` 的 `.claude/worktrees/`、`.agents/local/`、`.cb-delegate/` 与 `retention.json` 的 `worktreeParents`、`repo-hygiene` 的 `mustBeIgnored` 一致；`worktreeKeep` 的 `../himawari-deploy-wt`、`.ci-output/worktrees` 与文档描述一致。
- `xcode-cache.sh` 的平台名 `ios|mac|watch` 与 `xcode-build.sh`、`ui-review.sh`、`mac-ui-review.sh`、`retention.json` 的 `DerivedDataWatch` 描述一致；`HIMAWARI_APPLE_CACHE`、`HIMAWARI_XCODE_LOCK_WAIT` 在 README 中有说明。
- `HIMAWARI_REPO_HYGIENE_BASE` 只在本脚本和测试里出现；**当前稀疏检出里没有 `.github` 工作流，CI 是否真的传入这个基准未核实**；推送前钩子没有传，见意见 2。
- `PRUNE_LOCAL_RESULT`、`PRUNE_LOCAL_VERSION` 被新脚本和 `test_prune_local.py`/`test_install_schedule.py` 使用；ADR 里写的 `PRUNE_RESULT` 是旧脚本的名字，属于文档不一致，不会让脚本运行失败。
- `packetKeepSuffixes`、`worktreeIgnoredAllowed` 等配置值的消费逻辑能接受默认 JSON 里的值；但前者允许空列表，空列表会让日志/报告后缀保护失效，建议在配置校验里要求非空。
