## 核查范围

本轮只对照增量 `b5f3a82..7c7ea7c`（以及它相对于基准 `07181db` 的文件清单）核对，重点读了：`scripts/disk-hygiene/prune-local.py`、`test_prune_local.py`、`scripts/ui-review-artifacts.mjs`、它的测试、`clients/apple/scripts/ui-review.sh`、`xcode-build.sh`、`xcode-cache.sh`、`scripts/git-hooks/pre-push`、`scripts/check-repo-hygiene.mjs`、ADR 0276、`.agents/instructions/disk-space-hygiene.md`、`clients/apple/README.md`。上一轮意见之外的旧代码没有整份重读；证据指向旧代码时跟到了 `deploy.sh`、`rollback.sh`、`retention.json`。

## 意见（按严重度）

### 1. 中低 — `fetch` 改为把所有文件读进内存后才写出，新增内存耗尽风险；写入中途失败仍会留下部分文件

文件:行：`scripts/ui-review-artifacts.mjs:133-142`

问题：上一轮意见 1 要求“清单对不上时一个文件都不写出”。修法是把全部文件内容先放进 `verified` 数组，全部核对通过后统一 `writeFileSync`。这确实修好了清单不匹配的提前写出，但把“逐文件内存”变成了“整批内存”。远端引用里的文件内容是不可信输入，`git show` 的 `maxBuffer` 又是 1GB（`scripts/ui-review-artifacts.mjs:39`），一批很多个大文件就能把云端线程的内存吃光。另外，核对通过之后的写入如果第 3 个文件遇到磁盘满/权限错误，前两个文件已经写出，函数抛错退出，`finally` 只删临时引用，不清理已写出的文件。

证据：
```js
const verified = [];
for (const file of manifest.files) {
  ...
  const content = git(cwd, ["show", `${local}:${file.path}`], { binary: true });
  if (content.length !== file.bytes || sha256(content) !== file.sha256)
    throw new Error(`UI_REVIEW_MANIFEST_MISMATCH ${file.path}`);
  verified.push({ path: file.path, content });
}
for (const file of verified) writeFileSync(join(out, file.path), file.content);
```
```js
} finally {
  git(cwd, ["update-ref", "-d", local]);
}
```

建议：不要缓存全部内容。先做一遍只校验大小和 SHA-256 的遍历（逐文件丢弃 Buffer），全部通过后第二遍 `git show` 再写入；或写到 `out` 同文件系统的临时目录，全部成功后再整体 `rename`，写入失败时删掉临时目录。这样既保持“一个文件都不写出”，又不把整批内容压在内存里。

### 2. 中低 — 上线包保护仍按包名日期选“最近两次”，没有按部署时间或实际在服务版本；保留个数还写死为 2

文件:行：`scripts/disk-hygiene/prune-local.py:17-18`、`:290-300`、`:311-317`

问题（读代码证实）：`deployed()` 只看包目录里有没有任意一条 `deploy-*.log` 含 `DEPLOY_RESULT {"result":"passed"`；选择时沿用 `packets` 的排序键 `(child.name[:10], child.stat().st_mtime)`，也就是包名日期，而不是 deploy 日志时间。`DEPLOYED_PACKETS_KEPT = 2` 又是硬编码，没有进 `retention.json`。

问题（推测的失败场景）：如果先部署 A，再部署 B、C，然后连续回滚到 A，当前在服务的包 A 的包名日期可能排不进“最近两个已部署包”，它就不再受保护，超过 1MB 的文件会被瘦身。ADR 0276:107 和 `.agents/instructions/disk-space-hygiene.md:11` 说保留的是“在服务的版本和回滚目标”，代码并没有核对实际在服务版本，只做了日期推断。重复回滚或重部署旧包时这个推断不成立。另外 ADR 0276:101 说“所有期限和保留个数写在 `retention.json`……不写死”，`DEPLOYED_PACKETS_KEPT` 与这句话不一致，改 `retention.json` 也不会改变“保留两个”的行为。

证据：
```python
DEPLOY_PASSED = 'DEPLOY_RESULT {"result":"passed"'
DEPLOYED_PACKETS_KEPT = 2
```
```python
packets.sort(key=lambda child: (child.name[:10], child.stat().st_mtime), reverse=True)
protected = set(packets[:config['keepPackets']])
for packet in [packet for packet in packets if deployed(packet)][:DEPLOYED_PACKETS_KEPT]:
```
```python
DEPLOY_PASSED = 'DEPLOY_RESULT {"result":"passed"'
```

建议：按 `deploy-*.log` 里的时间（或日志 mtime）对已成功部署的包排序，取最近两个；把个数改成 `retention.json` 的新键（例如 `deployedPackets`），启动时校验为正整数。如果确实无法知道生产实际在服务版本，就在文档里写明这是基于 deploy 日志的推断，而不是断言“它们就是在服务和回滚目标”。

### 3. 低 — 推送前钩子仍未按实际推送的引用检查，这一轮只改了 ADR 承认限制

文件:行：`scripts/git-hooks/pre-push:20-22`、`scripts/check-repo-hygiene.mjs:82-91`、`:97-114`

问题：上一轮意见 2 指出的代码行为没有变：钩子不读 pre-push 从 stdin 拿到的 `<local ref> <local sha> <remote ref> <remote sha>`，而是直接跑 `check-repo-hygiene.mjs`，后者用 `merge-base HEAD origin/main` 和 `base...HEAD`。推送一个不是当前 `HEAD` 的分支时，钩子检查的是当前检出的 HEAD，不是实际要推送的提交。增量里 ADR 0276:92 改成了“推送没签出的分支时钩子查不到那个分支，由 CI 拦”，文档现在和代码一致，但代码层面的漏洞仍在，CI 故障时大文件仍可能进 main。

证据：
```sh
node "$root/scripts/check-repo-hygiene.mjs" >&2 || {
  echo "PUSH_REPO_HYGIENE_FAILED npm run check:repo-hygiene 失败或脚本缺失，推送被拦下" >&2
  exit 1
}
```
```js
const reference = env.HIMAWARI_REPO_HYGIENE_BASE ?? "origin/main";
try {
  return git(root, ["merge-base", "HEAD", reference]).trim();
```
```js
const raw = git(root, ["diff", "--raw", "-z", "-M", "--no-abbrev", `${base}...HEAD`]);
```

建议：让钩子读取 stdin 的每一行，对每个待推送的 `<local sha>` 用 `<remote sha>..<local sha>` 或 `merge-base <remote sha> <local sha>...<local sha>` 检查；如果暂时只检查 HEAD，至少要在钩子输出里明确警告“本次只检查了 HEAD”，不要只靠 ADR。

### 4. 低 — `appleCache` 校验仍允许任意绝对路径，定时 `--apply` 可以删该路径下 `DerivedData/*`

文件:行：`scripts/disk-hygiene/prune-local.py:64-67`、`:173-186`

问题：上一轮意见 3 的“路径没有边界校验”修了一部分：`legacyXcodeDirs` 现在必须是仓库内相对路径，`tmpXcodePrefix` 不能含 `/`，`appleCache` 必须是绝对路径且不能是根或 HOME。但 `appleCache` 仍可写成 `/Users/andy/Documents`、`/tmp` 之类的任意绝对目录，定时 `--apply` 会删该目录下 `DerivedData/` 的所有过期子目录。配置是本地可信文件，风险不高，但“配置写错就删错地方”的窗口还在。ADR 0276:111 原文也只要求“绝对路径、不能是根目录或主目录本身”，所以这是设计残余，不是文档和代码不一致。

证据：
```python
if 'appleCache' not in problems:
    cache = Path(os.path.expanduser(config['appleCache']))
    if not cache.is_absolute() or '..' in cache.parts or cache == Path(cache.anchor) or cache == Path.home():
        problems.append('appleCache')
```
```python
cache = Path(os.path.expanduser(config['appleCache'])) / 'DerivedData'
if cache.is_dir():
    candidates += [(child, cache) for child in cache.iterdir() if child.is_dir() and not child.name.endswith('.lock')]
```

建议：把 `appleCache` 限制在允许的根下（例如 `~/Library/Caches/himawari`，或 `retention.json` 里新增一个允许根），或者在删除前要求 `<appleCache>/DerivedData` 的父目录满足白名单；至少把 `/tmp`、`/Users` 这类宽目录写进反向测试。

### 5. 低 — `--approve` 恢复旧快照失败时没有检查，而且这条回滚路径没有自动测试

文件:行：`clients/apple/scripts/ui-review.sh:71-78`，`clients/apple/README.md:114`

问题：上一轮意见 8 已改成在 `mv "$staged" "$snapshots"` 失败时把 `$previous` 移回来，这是对的。但恢复用的 `mv "$previous" "$snapshots"` 本身没有检查；如果它再失败（例如 `$snapshots` 已被并发创建），`set -e` 会让脚本直接退出，旧快照留在 `.previous-$$` 而不是 `$snapshots`，输出的 “the old snapshots were put back” 和 README 的“中途出错旧快照不动”就不成立。更关键的是，整个 `--approve` 替换逻辑没有任何自动测试（`test/tooling` 下没有覆盖 `ui-review.sh` 的用例），无法在回归时验证“旧快照不动”。

证据：
```sh
[ ! -d "$snapshots" ] || mv "$snapshots" "$previous"
if ! mv "$staged" "$snapshots"; then
  [ ! -d "$previous" ] || mv "$previous" "$snapshots"
  rm -rf "$staged"
  echo "UI_REVIEW_FAILED could not move $staged into $snapshots; the old snapshots were put back" >&2
  exit 1
fi
```

建议：检查恢复命令的返回值，恢复失败时打印 `$previous` 的实际位置而不是声称已恢复；并用同目录临时名 + `trap` 清理，避免留下隐藏目录。补一个 shell 层测试（可以用假的 `mv`/只读目录）验证：替换失败时旧快照仍在原路径，或至少在 `$previous` 且输出明确。

### 6. 低（推测） — 当前 `--repo` 的排除用大小写敏感的路径字符串相等，macOS 大小写不敏感文件系统上可能认不出同一个目录

文件:行：`scripts/disk-hygiene/prune-local.py:111-116`、`:258`

问题（读代码证实）：`inside()` 和 `path.resolve() == repo` 都是基于 `Path` 字符串比较；`repo` 来自 `--repo` 的 `resolve()`。问题（推测）：macOS 默认文件系统大小写不敏感，但 `realpath`/`Path.resolve()` 不会统一大小写。如果 `--repo` 传的是当前仓库的另一种大小写写法，`git worktree list` 给出的路径和 `repo` 字符串不相等，`current-repo` 检查就不会命中，理论上可能把当前工作副本当成可删对象。实际触发要求 `--repo` 指向一个链接工作副本且大小写不同，概率低，但删错的是当前仓库，代价高。

证据：
```python
def inside(path, root):
    try:
        Path(path).resolve().relative_to(Path(root).resolve())
        return True
    except ValueError:
        return False
```
```python
elif path.resolve() == repo or inside(repo, path):
    reason = 'current-repo'
```

建议：用 `os.path.samefile()`（或比较 `st_dev`/`st_ino`）判断“是不是当前仓库/是否在它里面”，不要只比较字符串；`--repo` 和 worktree 路径都用一次 `realpath` 并在同一规则下比较。

## 上一轮意见核对

- 1（fetch 提前写出）：已改，新增 `verified` 缓冲；但带来本轮意见 1 的内存回归。
- 2（推送前钩子看 HEAD）：代码未改，只改了 ADR 承认限制；见意见 3。
- 3（路径边界）：已加校验，`appleCache` 仍有残余；见意见 4。
- 4（工作副本排除当前 repo、拒绝符号链接）：已改；`path.is_symlink()` 和 `current-repo` 都在，新增反向测试。
- 5（`--skip-if-busy` 含 Xcode）：已改，合并了 `BUSY_PATTERN|XCODE_BUSY_PATTERN`，新增整轮跳过的反向测试；但“Xcode 正在编译时只跳缓存、不跳整轮”没有独立测试。
- 6（旧上线包只按日期留 3 个）：部分改，已按 deploy 日志识别，但仍按包名日期选且个数写死；见意见 2。
- 7（`-derivedDataPath=` 绕过）：已改，反向测试覆盖。
- 8（`--approve` 不恢复旧快照）：已改，但恢复失败未检查、无测试；见意见 5。
- 9（`publish` 跟随符号链接）：已改，新增 `UI_REVIEW_ARTIFACT_SYMLINK_REJECTED` 和反向测试。
- 12（文档与代码不一致）：大部分已对齐；新增的 `DEPLOYED_PACKETS_KEPT = 2` 与“保留个数写在 retention.json”不一致，README“中途出错旧快照不动”在恢复再失败时也过强；分别见意见 2、5。

## 侧重检查

- 错误路径：查了 `fetch` 的清单缺失/JSON 损坏/tree 不匹配/大小或 SHA 不匹配/输出目录非空，确认都在写文件前失败；`publish` 的空目录、非法扩展名、非法 PR/批次、符号链接；`prune-local` 的配置缺失/非法 JSON/非法路径、`--apply` 删除失败计数、`--skip-if-busy`。结论：清单不匹配的“一个文件都不写出”已成立，但写入阶段的 I/O 失败仍会留部分文件（意见 1）。
- 不可信输入：`manifest.files[].path` 受 `FILE_NAME` 限制，不能带 `/` 或 `..`；tree 和 manifest 双向比对；`out` 必须是空目录。没有发现路径穿越。`appleCache` 仍可指定宽目录（意见 4）。
- 安全/不可撤销：工作副本删除走 `git worktree remove` 不带 `--force`；Xcode/包文件删除前拒绝符号链接；`remove_tree` 再检查一次 `is_symlink`。当前仓库排除有大小写边角（意见 6）。
- 资源耗尽：`fetch` 整批进内存（意见 1）；`deployed()` 每次整份读 deploy 日志，但一次只读一个文件，量级通常可接受，未单列。
- 规则/文档一致：ADR 0276:101/107/111、`.agents/instructions/disk-space-hygiene.md:11`、`clients/apple/README.md:95/114` 与代码总体一致；`DEPLOYED_PACKETS_KEPT` 是明确的不一致（意见 2）。另外 `xcode-cache.sh` 本身不装 `trap`，锁释放靠三个调用方各自 `trap`（`xcode-build.sh:14`、`ui-review.sh:106`、`mac-ui-review.sh:16`），现状符合“脚本退出释放”的说法，但未来新增调用方必须自己记得装 trap。
- 测试可执行性：当前环境只允许 `git` 和只读工具，我没有实际运行测试；下面关于反向用例的判断都是静态推演。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。这个增量没有动任何组装模型请求的代码；改的是仓库清理、截图交接、Xcode 缓存脚本、审查记录和说明文档。`.agents/instructions/disk-space-hygiene.md` 属于线程开始时按需加载的规则文件，按 `prompt-prefix.md` 第 42-44 行，改了提示词文字只对新对话生效，不会改已经在跑的对话的冻结开头。系统提示、工具定义、历史消息、遮盖结果都没有被触碰；发给模型的内容仍然只在末尾追加，也没有新增每轮会变的值。

2. **会不会让同一段文字在不同请求里变成不同字节？** 不涉及。增量没有产生会进入模型请求的内容。唯一触及序列化的是截图清单，`publish` 仍用 `readdirSync(dir).sort()` 后按排序结果构造 `files`，没有时间字段、随机数或无序集合进入清单；`fetch` 的 `verified` 顺序只影响写盘顺序，不影响文件字节。`deployed()` 返回布尔值，`protected` 集合只做成员判断，不产生输出顺序。

3. **有没有对应的自动检查，反向用例真的会失败吗？** 大多数有，且按代码推演反向用例会失败：
   - 配置越界：`test_config_paths_that_leave_their_root_are_refused`；修复前会真的删 `../outside`，测试会失败。
   - 当前 repo 不被删：`test_the_repository_given_as_repo_is_never_removed_as_a_worktree`；修复前会被 `worktree remove`，测试会失败。
   - Xcode 构建时整轮跳过：`test_a_running_xcode_build_skips_the_whole_round`；修复前 `done` 会被删且 mode 不是 `skipped-busy`，测试会失败。
   - 已部署包保留：`test_a_deployed_packet_keeps_its_files_however_many_packets_follow_it`；修复前 2MB 文件会被瘦身，测试会失败。
   - `-derivedDataPath=`：`apple-xcode-cache.test.mjs:76-78`；修复前会交给假 `xcodebuild` 并以 0 退出，测试会失败。
   - `publish` 符号链接：`ui-review-artifacts.test.mjs:95-99`；修复前会把链接目标当文件发布，测试会失败。
   - `fetch` 一个文件都不写出：`ui-review-artifacts.test.mjs:117-143` 用两个文件构造第二个不匹配；修复前会先写出 `a.png`，`readdirSync(out)` 不为空，测试会失败。
   没有对应自动检查的：`ui-review.sh --approve` 的恢复路径、`DEPLOYED_PACKETS_KEPT=2`/按部署时间排序、以及“Xcode 忙时只跳缓存不跳整轮”这条独立路径。另外新测试 `test_a_running_xcode_build_skips_the_whole_round` 用 `/proc` 等待子进程（`test_prune_local.py:220`），只能在 Linux 上跑；项目的 `check:disk-hygiene` 在 Linux 测试主机上跑，所以现状可接受，但不能在 Mac 上直接跑。

4. **改动产生或修改的每个值，使用它的地方都能接受吗？** 逐个核对了：
   - `DEPLOY_PASSED`（`prune-local.py:17`）对生产方 `deploy.sh:25` 的 `DEPLOY_RESULT {"result":"passed"...` 原样匹配，`run-logs/deploy-*.log` 也确实由 `deploy.sh:11` 产生，两端一致。
   - `DEPLOYED_PACKETS_KEPT`（`:18`）没有配置端；它既是“保留个数不写死”规则的例外，也无法通过 `retention.json` 调整（意见 2）。
   - `retention.json` 的三个受校验键 `appleCache`、`legacyXcodeDirs`、`tmpXcodePrefix`：默认值都能通过新校验；`install-schedule.sh` 只是原样复制配置，不另做解析，消费端只有 `prune-local.py`，没有发现第二套校验冲突。
   - `UI_REVIEW_ARTIFACT_SYMLINK_REJECTED`：只由 `ui-review-artifacts.mjs` 产生，`main` 取第一行输出，测试只做子串匹配，没有上游按错误码分支；可以接受。
   - `KEEP ... deployed/current-repo/outside-allowed-root` 这些原因串：只出现在日志、测试和说明里，代码没有别的解析器依赖固定枚举；可以接受。`current-repo` 和 `deployed` 有测试，`outside-allowed-root` 没有专门测试。
   - `-derivedDataPath=`：在 `xcode-build.sh` 里于 `xcodebuild` 之前拒绝，仓库内没有调用方传这种写法；不会破坏现有调用。
   - 清单格式未变：`publish` 和 `fetch` 对 `schemaVersion/pr/batch/files[].path/bytes/sha256` 的校验仍然对称；`fetch` 新增的缓冲只改内存行为，不改字节。
