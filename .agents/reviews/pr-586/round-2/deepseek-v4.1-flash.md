## 本轮查过的范围

- 对比 `e35ba169e9529b030728e8a6e6a53634d0c1b761..2c570b3aa9c721d39570b3fdf55c2703e8168976` 的增量，重点读了 `scripts/delivery-mode/` 下的清理、缓存、部署、出包、维护脚本和对应测试、文档。
- 增量里还夹带了与上线提速无关的 MCP 连接、提示词目录、Control Center 等大块改动。我只为回答必答问题看了 `packages/prompt-catalog/` 和 `apps/agent-service/src/production-mcp-read.ts` 的相关行，没有完整复核整套 MCP 连接功能，标「未核实」。
- 受工具限制不能运行测试，所以材料里「全过」「73 条」都只能从代码断言上判断，未实际执行。

## 侧重检查

- 不可逆删除：检查了 releases、operations、evidence、transport stage、资格目录的目标路径清理和归档顺序，发现失败尝试的 release 目录仍走通用删除、绕过 `failed-attempts` 归档（见意见 1）。
- 数据库引用：检查了新增的 `targetPaths` 数据库扫描，发现不可读表被静默跳过、证据根内的大文件仍会被裁剪（见意见 2、4）。
- 缓存错误路径：检查了缓存目录不存在/权限不对/是符号链接/是文件、条目是目录、条目权限或属主不对、lock 不可打开、缓存查询失败、SHA 不符等路径；主要缺口见意见 3、7。
- 路径与权限：`valid_target_path` 仍要求绝对路径、规范化后不变、父目录在允许列表；符号链接不跟随；缓存写入用临时文件加 `os.replace`、`O_NOFOLLOW`；这些未发现新错误。
- 规则、说明文档和代码一致性：`historyComparison` 整套删除后实例文件、ADR 0279、I-108、维护说明已更新，未发现残留消费者；但 S8 和缓存自愈的措辞仍有夸大（见意见 3、6）。
- SQL：表名/列名有转义，值走参数绑定；未发现新增注入点。

## 读代码证实的问题

### 1、中：失败尝试的 release 目标目录仍被通用 releases 循环直接删除，跳过 failed-attempts 归档

- 文件:行：`scripts/delivery-mode/release-cleanup-remote.py:206`、`:339`、`:348`
- 问题：上一轮意见 4 说 releases 和 operations 两类目标路径都绕过归档。这次只补了 `currentOperations` 的归档，`newPrefix` 仍然在 `children(releasesRoot)` 循环里被 `remove(path, 'old-release')` 直接删掉。随后 `clear_target_paths` 把已删除路径放进 `handled` 并跳过，所以不会补归档。
- 证据：
```python
for path in children(plan['releasesRoot']):
    ...
    else:
        remove(path, 'old-release')
...
handled = {item['path'] for item in result['deleted']} | ...
...
if path in handled or not os.path.lexists(path):
    continue
```
  失败尝试的 release 目录就是 `targetPaths` 里的 `newPrefix`；若里面有 `*.json`、`*.log` 等小报告，会随目录删除，违反 ADR 0281「目标路径先把报告和日志复制到 `failed-attempts/<时间>/<原绝对路径>/` 再删除」。
- 建议：在 releases 循环里先判断该路径是否在 `plan['targetPaths']`，是则改用 `failed_attempt_destination` 归档，或者从 releases 循环排除所有 `targetPaths`，统一交给 `clear_target_paths`；补一条在 `self.failed['prefix']` 下放 `.json`、断言归档文件存在的反向用例。

### 2、中低：被数据库引用的 evidence 目录仍会被裁掉 10 MiB 以上的文件

- 文件:行：`scripts/delivery-mode/release-cleanup-remote.py:287`、`:295`、`:299`
- 问题：新增的数据库保护只把 `targetPaths` 本身放进 `named_by_database`。证据清理循环对目录内每个大于 `largeFileBytes` 的文件调用 `in_use(filename)`，而 `named_by_database` 的键是目录路径，不是目录内文件，所以数据库引用 `evidenceRoot` 时，目录会被保留，但里面的旧数据库副本等大文件仍可能被删。
- 证据：
```python
for path in evidence_roots:
    if path == current['evidence']:
        keep(path, 'serving-evidence')
        continue
    ...
        if ... and filename not in recent_copies and not in_use(filename):
            ... os.unlink(filename)
    if path == plan['currentEvidence'] and not in_use(path):
```
  `in_use` 只在 `path in named_by_database` 时命中；文件路径不会命中以 `evidenceRoot` 为键的记录。
- 建议：在裁剪大文件前先判断文件是否位于任何 `targetPaths` 数据库引用目录之下（或把 `named_by_database` 的匹配扩展为「路径相等或位于其下」）；补一条「数据库引用 evidence 根，根内放一个超过 10 MiB 的 `.sqlite`，清理后仍在」的用例。

### 3、低：缓存里名字不是本次成员的坏目录仍删不掉，和文档「坏条目会被替换/修剪」不一致

- 文件:行：`scripts/delivery-mode/packet-template/steps/transport-packet.py:126`、`:145`、`:159`
- 问题：自愈加修剪只对本次 `members` 里出现的 SHA 名称把目录 `shutil.rmtree` 掉；`present` 里其它名称的目录仍被当作普通条目。超过 `maxBytes` 时修剪循环直接 `os.unlink(entries / name)`，遇到目录会抛 `IsADirectoryError`，`store_in_cache` 整体中止，缓存保持超限；每次传输都会重复，直到有人手工清理。
- 证据：
```python
if os.path.lexists(final):
    info = final.lstat()
    ...
    if stat.S_ISDIR(info.st_mode):
        shutil.rmtree(final)
...
for mtime, name, size in sorted(present):
    if total <= spec['maxBytes']:
        break
    if name in kept:
        continue
    os.unlink(entries / name)
```
- 建议：修剪时对目录用 `shutil.rmtree`、对非普通文件用 `os.unlink`，或先统一清掉 `sha256/` 下所有非普通文件；补一条「非当前成员 SHA 的目录条目，超上限时被删掉」的用例。文档 `steps/README.md:48` 的「已有但查询不会报命中的条目……传完后被替换」也应改成「本次包里的同名条目会被替换，其它坏条目在修剪时清掉」。

### 4、低：目标路径的数据库保护在读不到表时静默失效

- 文件:行：`scripts/delivery-mode/release-cleanup-remote.py:109`、`:183`
- 问题：任何 `sqlite3.OperationalError` 都只把表名记进 `unreadableTables`，清理继续执行。若数据库被锁（清理运行时服务必须 active）、损坏或某表读取异常，目标路径的数据库引用就查不到，`clear_target_paths` 会把「没有被保护」的目录当残留删除。整个流程没有任何地方因 `unreadableTables` 非空而停下。
- 证据：
```python
try:
    rows = database.execute(query, ...).fetchall()
except sqlite3.OperationalError:
    found.setdefault('unreadableTables', []).append(table)
    continue
```
```python
result['unreadableTables'] = named_by_database.pop('unreadableTables', [])
```
  之后只用于报告，没有失败分支。
- 建议：当存在 `unreadableTables` 且这次还要处理目标路径时，至少延迟删除目标路径并以明确错误码停下；补一条「某张表查询报错时不删目标路径」的反向用例。

### 5、低：verify-steps 的 fixture 包仍没有 `packet-parameters.json`，新用例绕过了真正的 `main()` 接线

- 文件:行：`scripts/delivery-mode/packet-template/steps/verify-steps.py:74`、`:370`
- 问题：上一轮意见 7 指出 fixture 包没有 `packet-parameters.json`，`cache_settings` 从未被执行。这次新增的用例确实执行了 `cache_settings`，但它直接构造 `parameters` 目录并修改模块全局 `local.packet`，没有走 `build_packet()`，也没有走 `main()` 里 `settings = cache_settings(frozen)` → `cached_members()` → `stream_packet()` → `remote_command()` 的整条接线。fixture 包仍然没有这个文件，所以「旧行为路径」和「真实包参数读取」仍未被端到端覆盖。
- 证据：
```python
def build_packet(root):
    ...
    for path in packet.rglob('*'):
```
  只放入 `steps/`、`install/`、`materials/`、`inputs/`、`freeze-manifest.json`，没有 `packet-parameters.json`。
```python
def local_side_reads_the_frozen_cache_settings():
    local = load(...)
    parameters = root / 'parameters-fixture'
    parameters.mkdir()
    local.packet = parameters
```
- 建议：在 `build_packet()` 里写入带 `MATERIAL_CACHE_JSON` 的 `packet-parameters.json`，让 `main()`/`wrapper('S1_TRANSPORT')` 的 fixture 走一次真实读取，断言 tar 流缺少命中成员且远端命令末尾带缓存 spec；同时保留直接单测。

### 6、低：S8 文档说 S3 与 S7「读回相同」，代码只比较历史摘要

- 文件:行：`scripts/delivery-mode/packet-template/maintenance/run-maintenance.mjs:205`；`scripts/delivery-mode/packet-template/steps/README.md:78`；`docs/adr/0279-history-is-compared-only-while-the-service-is-stopped.md:45`
- 问题：S8 实际调用的是 `verifyHistoryUnchanged`，只比较 `before.history` 和 `after.history`，不比较 schema、gate、authority 等完整读回。README/ADR 的「S3 读回和 S7 读回相同」容易被读成整份读回相等；更窄的 `P-readback-design.md` 写的是「两份历史读回相同」，与代码一致。
- 证据：
```javascript
verifyHistoryUnchanged(jsonFile(`${evidenceRoot}/s3-copy-after__PKT_CURRENT_SCHEMA__.json`), jsonFile(`${evidenceRoot}/s7-catalog-after__PKT_TARGET_SCHEMA__.json`));
```
- 建议：把 README 和 ADR 的措辞改成「S3 与 S7 的历史摘要相同」，或明确列出 S8 另外单独做的检查，避免读者以为整份读回逐字段相等。

## 推测

### 7、低（推测）：缓存查询之后 lock 损坏或缓存目录被改坏，且 `fill` 非空时，重试会一直失败而不是退回整包

- 文件:行：`scripts/delivery-mode/packet-template/steps/transport-packet.py:222`；`scripts/delivery-mode/packet-template/steps/run-local-step.py:33`
- 问题：本地只读查询只检查 `material-cache` 和 `material-cache/sha256` 两个目录及命中文件，不检查 `material-cache/lock`。如果查询报告命中、Mac 因此把成员留在流外，而接收端随后打不开 lock（lock 是目录、符号链接、权限异常等），`receive_archive` 会走 `require(not spec['fill'], message)`，直接失败；下一次查询仍然报告命中，于是每次重试都失败。这与文档「缓存目录不安全或建不起来时，整包传输照常进行」的直观承诺不一致。
- 证据：
```python
try:
    entries = cache_directories(cache, uid, gid)
    lock = os.open(cache / 'lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
except (RuntimeError, OSError) as error:
    ...
    require(not spec['fill'], message)
    result = receive_members(stream, target, expected_freeze, uid, gid, common, None, [])[0]
```
  这条路径需要查询成功后缓存状态才变化，触发条件未核实。
- 建议：查询时也检查 lock 能否以只读方式安全打开（不改内容），或在接收端无法打开缓存时把「本次缓存不可用」作为可重试/下次整包的明确结果，并让本地查询在下一轮不再把该缓存当作可用。

## 必答问题

1. **请求开头**：上线提速部分不改变任何模型请求，只改 Mac/生产端的清理、传输和出包脚本，不涉及系统提示、工具定义、历史消息或遮盖结果。增量里另夹带的 MCP 改动新增了固定 prompt `mcp.server-connection-required`，现有 prompt 文本未改；MCP server instructions 只在没有连接密钥时切换为这段新固定文本，并且是按连接会话选择的，不是往主代理已有历史前缀里插入或改写。就我读到的这些行，不存在「把每轮变化的值写进前缀」的问题；MCP 整套改动未完整复核（未核实）。
2. **同一段文字跨请求的字节**：上线清理/缓存/出包新增的字段 `MATERIAL_CACHE_JSON`、`fill`、`minBytes`、`maxBytes`、`targetPaths`、`cacheStoreError` 都是确定性的；删除 `HISTORY_COMPARISON` 反而去掉了随版本变化的字段。缓存查询和时间戳只用于缓存与报告，不写入模型提示。MCP 的日统计用 `now` 和时区，但不进入模型文本。未发现属于本次上线提速的「同文不同字节」问题；MCP 部分未核实。
3. **自动检查与反向用例**：新增的 `test_paths_other_than_releases_named_by_the_database_stay...`、`test_a_database_row_naming_a_longer_sibling_path...`、`test_target_paths_left_after_a_passed_deploy_do_not_change_its_result`、缓存目录不可建、坏缓存条目替换等，从断言逻辑看改前会失败，是有效反向用例。但缺口是：意见 1 没有 release 前缀归档用例；意见 3 没有「非当前 SHA 的目录条目」用例；意见 5 的缓存接线用例绕过了真实 `main()`；意见 4 没有不可读表的用例。测试我没有运行（未核实）。
4. **产生/使用两端核对**：`MATERIAL_CACHE_JSON` 由 `make-packet.material_cache` 产生，消费端 `run-local-step.cache_settings` 同样要求恰为 `minBytes`/`maxBytes` 且为正整数，两端一致；`cache_spec` 生产者拼 `fill/minBytes/maxBytes`，消费者 `transport.cache_spec` 也要求这个精确集合，一致；`targetPaths` 由 `release-cleanup.cleanup_plan` 经共享的 `deploy-target-paths.py` 产生，预检和远端清理使用同一模块，父目录校验一致；`failed_attempt_destination` 的两处使用端一致。新 `cacheStoreError` 前缀只有测试消费，没有生产端依赖精确值。删除 `HISTORY_COMPARISON`/`HISTORY_COMPARISON_JSON` 后没找到残留消费者，实例文件再带该键会被 `PACKET_HISTORY_COMPARISON_SWITCH_REMOVED` 拒绝，S8 也不再写 `s8-history-preserved.json`，未发现残留读取端。唯一不一致是 `targetPaths` 里 `newPrefix` 在清理端的使用方式：它是目标路径，却没有像其它目标路径那样先归档，见意见 1。作者说法里「缓存缺省时传输命令和旧版逐字节相同」只对「不带第四个缓存参数」这一形式成立；新生成的包参数始终多出 `MATERIAL_CACHE_JSON` 键（缺省值为字符串 `null`），因此整包字节和冻结 SHA 不会与旧版相同。
