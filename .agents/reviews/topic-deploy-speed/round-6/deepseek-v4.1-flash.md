CLAIM|1|一致|scripts/delivery-mode/deploy-preflight.py:204|预检要求一组目标路径都不存在|        *[('TARGET_PATH_ABSENT ' + path, facts.get('targetPath.' + path) == 'absent') for path in paths],
CLAIM|2|一致|scripts/delivery-mode/deploy-preflight.py:17|清单现在由预检和清理共用|target_paths = load_target_paths().target_paths
CLAIM|3|一致|scripts/delivery-mode/release-cleanup.py:25|清单现在由预检和清理共用|    spec = importlib.util.spec_from_file_location('deploy_target_paths', HERE / 'deploy-target-paths.py')
CLAIM|4|一致|scripts/delivery-mode/deploy-target-paths.py:4|`scripts/delivery-mode/deploy-target-paths.py` 第 4 行 `def target_paths(binding):`|def target_paths(binding):
CLAIM|5|一致|scripts/delivery-mode/release-cleanup-remote.py:257@5834935d102709955c38e76220c6ed8a6df5cc51|改动前，清理遇到有内容的资格目录只保留|            keep(target, 'qualification-not-empty')
CLAIM|6|一致|scripts/delivery-mode/deploy-preflight.py:199@5834935d102709955c38e76220c6ed8a6df5cc51|所以同名路径下次必然过不了预检|        *[('TARGET_PATH_ABSENT ' + path, facts.get('targetPath.' + path) == 'absent') for path in paths],
CLAIM|7|一致|docs/incidents-and-gates.md:93|`docs/incidents-and-gates.md` 第 93 行 I-56 原文“清理按当时的规则保留（`qualification-not-empty`）”|清理按当时的规则保留（`qualification-not-empty`）
CLAIM|8|一致|.agents/instructions/disk-space-hygiene.md:8|项目规则不许只给失败产物改名了事：`.agents/instructions/disk-space-hygiene.md` 第 8 行原文“也绝不能只是给它们改名了事”|也绝不能只是给它们改名了事
CLAIM|9|一致|scripts/delivery-mode/packet-template/steps/packet-common.py:42|上线包里的文件不许是硬链接：`scripts/delivery-mode/packet-template/steps/packet-common.py` 第 42 行要求 `before.st_nlink == 1`|    require(path.resolve() == path and stat.S_ISREG(before.st_mode) and before.st_uid == uid and before.st_nlink == 1 and not before.st_mode & 0o022, '__PKT_LABEL_UPPER___PACKET_FILE_UNSAFE:' + str(path))
CLAIM|10|找不到|-|依赖包每次出包字节都不同|-
CLAIM|11|找不到|-|11-15 四个包的 `NODE_MODULES_TAR_SHA256` 各不相同而锁文件没变|-
CLAIM|12|找不到|-|第 3、4 个包的 `node-modules.json` 37,581 个文件只差 `node_modules/.vite/vitest/…/results.json`|-
CLAIM|13|找不到|-|`node_modules/.vite/vitest/…/results.json` 是 vitest 写进 node_modules 的测试结果缓存|-
CLAIM|14|找不到|-|这一条来自 Mac 上的包文件比对，仓库里没有原件|-
CLAIM|15|找不到|-|Mac 上传到生产机只有 1.1–1.5 MB/s|-
CLAIM|16|找不到|-|生产机外网下载 13.8 MB/s|-
CLAIM|17|找不到|-|每次上线都要从 Mac 往生产机传约 413 MB 的上线包|-
CLAIM|18|找不到|-|每次上线耗时 272–365 秒|-
CLAIM|19|找不到|-|依赖包 `node-modules.tar.gz` 约 282 MB|-
CLAIM|20|找不到|-|python 约 34 MB|-
CLAIM|21|找不到|-|它们 17 天里只因锁文件变化而真正变过 1 次|-
CLAIM|22|一致|.agents/plans/deploy-speed.md:1|方案和两轮模型审核记录见 `.agents/plans/deploy-speed.md` 与 `.agents/reviews/topic-deploy-speed/`|# 上线提速方案：失败残留自动处理、依赖包按内容复用
CLAIM|23|找不到|-|两轮模型审核记录见 `.agents/reviews/topic-deploy-speed/`|-
CLAIM|24|找不到|-|完整测量见 `/mnt/project-files/deploy-speed/analysis-2026-11-15.md`|-
CLAIM|25|一致|scripts/delivery-mode/release-cleanup-remote.py:326|`release-cleanup-remote.py` 的 `clear_target_paths` 在其他清理之后|    clear_target_paths(plan, current, result, in_use, remove, keep, apply, stamp)
CLAIM|26|一致|scripts/delivery-mode/release-cleanup-remote.py:344|属于正在服务的版本（含它的资格目录）、回滚目标、被进程或数据库引用、或者是符号链接的，保留|    protected = {current['prefix']: 'serving', current['operations']: 'serving', current['stage']: 'serving', current['evidence']: 'serving', current['rollbackPrefix']: 'rollback-target'}\n    if current.get('qualification'):\n        protected[current['qualification']] = 'serving'\n            reason = protected.get(path) or in_use(path)
CLAIM|27|一致|scripts/delivery-mode/release-cleanup-remote.py:354|或者是符号链接的，保留|        if os.path.islink(path) or not os.path.isdir(path):\n            reason = 'not-a-directory'\n        if reason:\n            keep(path, reason)
CLAIM|28|一致|scripts/delivery-mode/release-cleanup.py:97|保留并报 `CLEANUP_TARGET_PATH_LEFT`|        print('CLEANUP_TARGET_PATH_LEFT ' + item['reason'] + ' ' + item['path'])
CLAIM|29|不一致|scripts/delivery-mode/release-cleanup-remote.py:354|其余先把报告和日志等小文件复制到 `release-cleanup/failed-attempts/<时间>/<原绝对路径>/`，再删除|        if os.path.islink(path) or not os.path.isdir(path):\n            reason = 'not-a-directory'\n        if reason:\n            keep(path, reason)\n            result['targetPathsLeft'].append({'path': path, 'reason': reason})\n            continue
CLAIM|30|一致|scripts/delivery-mode/release-cleanup-remote.py:350|越出允许父目录的路径以 `CLEANUP_TARGET_PATH_INVALID` 拒绝|        if not valid_target_path(path, parents):\n            fail('CLEANUP_TARGET_PATH_INVALID')
CLAIM|31|一致|scripts/delivery-mode/release-cleanup.py:19|失败现场保留最近 2 份（`release-cleanup.py` 的 `KEEP_FAILED_ATTEMPTS`）|KEEP_FAILED_ATTEMPTS = 2
CLAIM|32|一致|scripts/delivery-mode/release-cleanup.py:20|总量超过 200 MB 时只留最新一份（`release-cleanup.py` 的 `FAILED_ATTEMPT_BYTES`）|FAILED_ATTEMPT_BYTES = 200 * 1024 ** 2
CLAIM|33|一致|scripts/delivery-mode/deploy.sh:18|部署前那次清理后仍有路径被占用时，`deploy.sh` 在预检前以 `target-paths-left` 停下|  if [[ "$code" -eq 3 && "$1" == before ]]; then\n    result target-paths-left PREFLIGHT 4
CLAIM|34|一致|scripts/delivery-mode/release-cleanup-remote.py:257@5834935d102709955c38e76220c6ed8a6df5cc51|这改掉了 I-56 当时“有内容就保留、等人处理”的做法|            keep(target, 'qualification-not-empty')
CLAIM|35|一致|scripts/delivery-mode/test_collect_dependencies.py:62|依赖收集脚本（`acceptance/helpers/collect-installer-dependencies.mjs`，`install/` 下是同一份）|        self.assertEqual((TEMPLATE / 'install/collect-installer-dependencies.mjs').read_bytes(), COLLECTOR.read_bytes())
CLAIM|36|一致|scripts/delivery-mode/packet-template/acceptance/helpers/collect-installer-dependencies.mjs:90|在每个依赖根下只收锁文件列出的包、`.bin` 和 `.package-lock.json`|const NPM_ENTRIES = new Set([".bin", ".package-lock.json"]);\n    fail(locked.has(name) || NPM_ENTRIES.has(name), `P5_MODULE_UNEXPECTED_ENTRY:${relative}/${name}`);
CLAIM|37|一致|scripts/delivery-mode/packet-template/acceptance/helpers/collect-installer-dependencies.mjs:79|`.vite`、`.vite-temp`、`.cache` 这几个工具缓存跳过|const TOOL_CACHE_ENTRIES = new Set([".vite", ".vite-temp", ".cache"]);\n    if (TOOL_CACHE_ENTRIES.has(name)) continue;
CLAIM|38|一致|scripts/delivery-mode/packet-template/acceptance/helpers/collect-installer-dependencies.mjs:90|其他不认识的条目以 `P5_MODULE_UNEXPECTED_ENTRY` 报错|    fail(locked.has(name) || NPM_ENTRIES.has(name), `P5_MODULE_UNEXPECTED_ENTRY:${relative}/${name}`);
CLAIM|39|一致|scripts/delivery-mode/instances/andy-production.json:27|实例文件的 `materialCache`（`minBytes` 16 MiB、`maxBytes` 1 GiB，可改）|    "minBytes": 16777216,
CLAIM|40|一致|scripts/delivery-mode/instances/andy-production.json:28|实例文件的 `materialCache`（`minBytes` 16 MiB、`maxBytes` 1 GiB，可改）|    "maxBytes": 1073741824
CLAIM|41|一致|scripts/delivery-mode/make-packet.py:443|冻结进包参数 `MATERIAL_CACHE_JSON`|        'MATERIAL_CACHE_JSON': material_cache(instance),
CLAIM|42|一致|scripts/delivery-mode/packet-template/steps/run-local-step.py:68|传输前 Mac 经 SSH 只读查生产机 `/opt/himawari/material-cache/sha256/<SHA>` 里有哪些大成员|    remote = 'set -eu; test "$(hostname)" = __PKT_HOSTNAME__; test "$(id -u)" = 0; exec /usr/bin/python3 -I -c ' + shlex.quote(CACHE_QUERY) + ' ' + shlex.quote(str(common.MATERIAL_CACHE)) + ' ' + shlex.quote(json.dumps(query))
CLAIM|43|一致|scripts/delivery-mode/packet-template/steps/run-local-step.py:140|tar 流里不放它们|                stream_packet(child.stdin, frozen, cache['fill'] if cache else ())
CLAIM|44|一致|scripts/delivery-mode/packet-template/steps/run-local-step.py:90|并把名单交给接收端|        spec = '' if cache is None else ' ' + shlex.quote(base64.b64encode(json.dumps(cache, sort_keys=True).encode()).decode())
CLAIM|45|一致|scripts/delivery-mode/packet-template/steps/transport-packet.py:199|接收端只允许名单里的成员缺席，从缓存核对大小和 SHA-256 后复制进上传目录，再照旧整体核对冻结清单|        for name in fill:\n            require(name in members, '__PKT_LABEL_UPPER___TRANSPORT_CACHE_FILL_NOT_FROZEN')\n            filename = target / name\n            common.make_parents(filename.parent, target, uid, gid, 0o750)\n            fill_from_cache(entries, {**members[name], 'path': name}, filename, uid, gid, common)\n            seen.add(name)
CLAIM|46|一致|scripts/delivery-mode/packet-template/steps/transport-packet.py:114|核对不符就删掉那条缓存并失败，下次自动整包传|        os.unlink(source)\n        raise RuntimeError('__PKT_LABEL_UPPER___TRANSPORT_CACHE_ENTRY_INVALID:' + expected['path'])
CLAIM|47|一致|scripts/delivery-mode/packet-template/steps/transport-packet.py:74|root:0700 目录|        require(stat.S_ISDIR(info.st_mode) and info.st_uid == uid and stat.S_IMODE(info.st_mode) == 0o700 and directory.resolve() == directory, '__PKT_LABEL_UPPER___TRANSPORT_CACHE_DIRECTORY_UNSAFE')
CLAIM|48|一致|scripts/delivery-mode/packet-template/steps/transport-packet.py:142|0600 文件|            matched = copy_verified(descriptor, temporary, expected, uid, gid, 0o600)
CLAIM|49|一致|scripts/delivery-mode/packet-template/steps/transport-packet.py:139|先写临时文件再改名|        temporary = entries / ('.incoming-' + expected['sha256'] + '-' + str(os.getpid()))\n        os.replace(temporary, final)
CLAIM|50|一致|scripts/delivery-mode/packet-template/steps/transport-packet.py:158|超过上限先删本次没用到的最旧条目|    for mtime, name, size in sorted(present):\n        if total <= spec['maxBytes']:\n            break\n        if name in kept:\n            continue\n        discard(entries / name)
CLAIM|51|一致|scripts/delivery-mode/packet-template/steps/transport-packet.py:234|缓存目录不安全或查询失败时，整包传输照常进行|        result = receive_members(stream, target, expected_freeze, uid, gid, common, None, [])[0]
CLAIM|52|一致|scripts/delivery-mode/packet-template/acceptance/helpers/collect-installer-dependencies.mjs:99|要改 `whole-locked-node-modules` 校验口径|const record = { schemaVersion: 2, scope: "whole-locked-node-modules", sourceHead: head, node: process.version, platform: `${process.platform}-${process.arch}`, packageLockSha256: hash(lockBytes), lockCheck: { method: "npm ls --all plus lock package identity readback", executable: process.execPath, args: npmArgs, exitCode: 0, outputSha256: hash(npmOutput) }, dependencyRoots, packages, entries, archive: { name: path.basename(archive), bytes: statSync(archive).size, sha256: hash(readFileSync(archive)) } };
CLAIM|53|一致|scripts/delivery-mode/test_collect_dependencies.py:64|改为同一环境打两次比较（`scripts/delivery-mode/test_collect_dependencies.py`）|    def test_tool_caches_are_left_out_and_the_archive_is_the_same_each_time(self):\n        self.assertEqual(digest(first_output), digest(second_output))
CLAIM|54|一致|scripts/delivery-mode/test_release_cleanup.py:409|`scripts/delivery-mode/test_release_cleanup.py` 的 `TargetPathClearingTest`|class TargetPathClearingTest(CleanupCase):
CLAIM|55|一致|scripts/delivery-mode/test_deploy.py:770|`scripts/delivery-mode/test_deploy.py` 的清理流程测试|class ProductionCleanupFlowTest(DeployHarness):
CLAIM|56|一致|scripts/delivery-mode/test_collect_dependencies.py:20|`scripts/delivery-mode/test_collect_dependencies.py`|class CollectedDependenciesTest(unittest.TestCase):
CLAIM|57|一致|scripts/delivery-mode/packet-template/steps/verify-steps.py:265|`scripts/delivery-mode/packet-template/steps/verify-steps.py` 的缓存用例|    case('receiver stores large frozen members in a private content-addressed cache', stores_large_members)
CLAIM|58|一致|scripts/delivery-mode/packet-template/steps/verify-steps.py:16|`scripts/delivery-mode/packet-template/steps/verify-steps.py` 的缓存用例（出包时在 Hermes 上运行）|if len(sys.argv) != 2 or sys.platform != 'linux' or os.getuid() == 0 or socket.gethostname() != 'hermes-home':

未能核对的部分：Mac 上的包文件比对、部署日志和测速数字在仓库里没有原件，`/mnt/project-files/deploy-speed/analysis-2026-11-15.md` 与 `.agents/reviews/topic-deploy-speed/` 在当前环境读不到，相关条目均按“找不到”记录。决定部分按当前提交里的实现核对；其中“其余……再删除”与 `clear_target_paths` 对非目录条目（含普通文件）也保留并报 `CLEANUP_TARGET_PATH_LEFT` 的实现不一致。
