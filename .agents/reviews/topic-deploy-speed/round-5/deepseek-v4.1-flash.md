CLAIM|1|找不到|-|完整测量见 `/mnt/project-files/deploy-speed/analysis-2026-11-15.md`|未读取
CLAIM|2|一致|.agents/plans/deploy-speed.md:1|方案和两轮模型审核记录见 `.agents/plans/deploy-speed.md`|# 上线提速方案：失败残留自动处理、依赖包按内容复用
CLAIM|3|找不到|-|两轮模型审核记录见 `.agents/reviews/topic-deploy-speed/`|未读取
CLAIM|4|一致|scripts/delivery-mode/deploy-preflight.py:204|预检要求一组目标路径都不存在|*[('TARGET_PATH_ABSENT ' + path, facts.get('targetPath.' + path) == 'absent') for path in paths],
CLAIM|5|一致|scripts/delivery-mode/deploy-preflight.py:17|清单现在由预检使用|target_paths = load_target_paths().target_paths
CLAIM|6|一致|scripts/delivery-mode/release-cleanup.py:60|清单现在由清理共用|'targetPaths': owned.target_paths(binding),
CLAIM|7|一致|scripts/delivery-mode/deploy-target-paths.py:4|`scripts/delivery-mode/deploy-target-paths.py` 第 4 行 `def target_paths(binding):`|def target_paths(binding):
CLAIM|8|一致|scripts/delivery-mode/release-cleanup-remote.py:257@5834935d102709955c38e76220c6ed8a6df5cc51|改动前，清理遇到有内容的资格目录只保留|keep(target, 'qualification-not-empty')
CLAIM|9|一致|scripts/delivery-mode/release-cleanup-remote.py:257@5834935d102709955c38e76220c6ed8a6df5cc51|改动前的 `release-cleanup-remote.py` 原文是 `keep(target, 'qualification-not-empty')`|keep(target, 'qualification-not-empty')
CLAIM|10|一致|scripts/delivery-mode/deploy-preflight.py:199@5834935d102709955c38e76220c6ed8a6df5cc51|所以同名路径下次必然过不了预检|*[('TARGET_PATH_ABSENT ' + path, facts.get('targetPath.' + path) == 'absent') for path in paths],
CLAIM|11|一致|docs/incidents-and-gates.md:93|I-56，`docs/incidents-and-gates.md`|清理对有内容的资格目录只保留，所以同名路径下次必然过不了预检
CLAIM|12|一致|.agents/instructions/disk-space-hygiene.md:8|项目规则不许只给失败产物改名了事，第 8 行原文“也绝不能只是给它们改名了事”|也绝不能只是给它们改名了事
CLAIM|13|一致|scripts/delivery-mode/packet-template/steps/packet-common.py:42|上线包里的文件不许是硬链接|before.st_nlink == 1
CLAIM|14|一致|scripts/delivery-mode/packet-template/steps/packet-common.py:42|`packet-common.py` 第 42 行要求 `before.st_nlink == 1`|before.st_nlink == 1
CLAIM|15|找不到|-|11-15 四个包的 `NODE_MODULES_TAR_SHA256` 各不相同而锁文件没变|未读取
CLAIM|16|找不到|-|第 3、4 个包的 `node-modules.json` 37,581 个文件只差 `node_modules/.vite/vitest/…/results.json`|未读取
CLAIM|17|找不到|-|这一条来自 Mac 上的包文件比对，仓库里没有原件|未读取
CLAIM|18|一致|scripts/delivery-mode/release-cleanup-remote.py:326|`clear_target_paths` 在其他清理之后|clear_target_paths(plan, current, result, in_use, remove, keep, apply, stamp)
CLAIM|19|一致|scripts/delivery-mode/release-cleanup-remote.py:349|逐个看预检要求不存在的路径|for path in plan['targetPaths']:
CLAIM|20|一致|scripts/delivery-mode/release-cleanup-remote.py:344|属于正在服务的版本的，保留|protected = {current['prefix']: 'serving', current['operations']: 'serving', current['stage']: 'serving', current['evidence']: 'serving', current['rollbackPrefix']: 'rollback-target'}
CLAIM|21|一致|scripts/delivery-mode/release-cleanup-remote.py:346|含它的资格目录的，保留|protected[current['qualification']] = 'serving'
CLAIM|22|一致|scripts/delivery-mode/release-cleanup-remote.py:344|回滚目标的，保留|protected = {current['prefix']: 'serving', current['operations']: 'serving', current['stage']: 'serving', current['evidence']: 'serving', current['rollbackPrefix']: 'rollback-target'}
CLAIM|23|一致|scripts/delivery-mode/release-cleanup-remote.py:188|被进程引用的，保留|if any(reference == path or reference.startswith(path + '/') or mentions(reference, path) for reference in references):
CLAIM|24|一致|scripts/delivery-mode/release-cleanup-remote.py:190|被数据库引用的，保留|if path in named_by_database:
CLAIM|25|一致|scripts/delivery-mode/release-cleanup-remote.py:354|或者是符号链接的，保留|if os.path.islink(path) or not os.path.isdir(path):
CLAIM|26|一致|scripts/delivery-mode/release-cleanup.py:97|保留并报 `CLEANUP_TARGET_PATH_LEFT`|print('CLEANUP_TARGET_PATH_LEFT ' + item['reason'] + ' ' + item['path'])
CLAIM|27|一致|scripts/delivery-mode/release-cleanup-remote.py:362|其余先把报告和日志等小文件复制到 `release-cleanup/failed-attempts/<时间>/<原绝对路径>/`，再删除|result['archived'] += archive_small_files(path, failed_attempt_destination(plan, path, stamp), plan['smallFileBytes'], apply)
CLAIM|28|一致|scripts/delivery-mode/release-cleanup-remote.py:351|越出允许父目录的路径以 `CLEANUP_TARGET_PATH_INVALID` 拒绝|fail('CLEANUP_TARGET_PATH_INVALID')
CLAIM|29|一致|scripts/delivery-mode/release-cleanup.py:19|失败现场保留最近 2 份|KEEP_FAILED_ATTEMPTS = 2
CLAIM|30|一致|scripts/delivery-mode/release-cleanup-remote.py:368|总量超过 200 MB 时只留最新一份|if position >= plan['keepFailedAttempts'] or (position > 0 and total > plan['failedAttemptBytes']):
CLAIM|31|一致|scripts/delivery-mode/deploy.sh:20|部署前那次清理后仍有路径被占用时，`deploy.sh` 在预检前以 `target-paths-left` 停下|result target-paths-left PREFLIGHT 4
CLAIM|32|一致|scripts/delivery-mode/release-cleanup-remote.py:257@5834935d102709955c38e76220c6ed8a6df5cc51|这改掉了 I-56 当时“有内容就保留、等人处理”的做法|keep(target, 'qualification-not-empty')
CLAIM|33|一致|scripts/delivery-mode/packet-template/acceptance/helpers/collect-installer-dependencies.mjs:79|依赖收集脚本是 `acceptance/helpers/collect-installer-dependencies.mjs`|const TOOL_CACHE_ENTRIES = new Set([".vite", ".vite-temp", ".cache"]);
CLAIM|34|一致|scripts/delivery-mode/test_collect_dependencies.py:62|`install/` 下是同一份|self.assertEqual((TEMPLATE / 'install/collect-installer-dependencies.mjs').read_bytes(), COLLECTOR.read_bytes())
CLAIM|35|一致|scripts/delivery-mode/packet-template/acceptance/helpers/collect-installer-dependencies.mjs:83|在每个依赖根下只收锁文件列出的包|const locked = new Set(packages.filter((item) => item.path.startsWith(`${relative}/`) && !item.path.slice(relative.length + 1).includes("/node_modules/")).map((item) => item.path.slice(relative.length + 1).split("/")[0]));
CLAIM|36|一致|scripts/delivery-mode/packet-template/acceptance/helpers/collect-installer-dependencies.mjs:80|收 `.bin` 和 `.package-lock.json`|const NPM_ENTRIES = new Set([".bin", ".package-lock.json"]);
CLAIM|37|一致|scripts/delivery-mode/packet-template/acceptance/helpers/collect-installer-dependencies.mjs:79|`.vite`、`.vite-temp`、`.cache` 这几个工具缓存跳过|const TOOL_CACHE_ENTRIES = new Set([".vite", ".vite-temp", ".cache"]);
CLAIM|38|一致|scripts/delivery-mode/packet-template/acceptance/helpers/collect-installer-dependencies.mjs:90|其他不认识的条目以 `P5_MODULE_UNEXPECTED_ENTRY` 报错|`P5_MODULE_UNEXPECTED_ENTRY:${relative}/${name}`
CLAIM|39|一致|scripts/delivery-mode/instances/andy-production.json:27|实例文件的 `materialCache` 的 `minBytes` 是 16 MiB|"minBytes": 16777216,
CLAIM|40|一致|scripts/delivery-mode/instances/andy-production.json:28|实例文件的 `materialCache` 的 `maxBytes` 是 1 GiB|"maxBytes": 1073741824
CLAIM|41|一致|scripts/delivery-mode/make-packet.py:430|`materialCache` 可改|if not isinstance(setting, dict) or set(setting) != {'minBytes', 'maxBytes'} or any(type(setting[key]) is not int or setting[key] <= 0 for key in setting) or setting['minBytes'] > setting['maxBytes']:
CLAIM|42|一致|scripts/delivery-mode/make-packet.py:443|`materialCache` 冻结进包参数 `MATERIAL_CACHE_JSON`|'MATERIAL_CACHE_JSON': material_cache(instance),
CLAIM|43|一致|scripts/delivery-mode/packet-template/steps/run-local-step.py:68|传输前 Mac 经 SSH 只读查生产机 `/opt/himawari/material-cache/sha256/<SHA>` 里有哪些大成员|remote = 'set -eu; test "$(hostname)" = __PKT_HOSTNAME__; test "$(id -u)" = 0; exec /usr/bin/python3 -I -c ' + shlex.quote(CACHE_QUERY) + ' ' + shlex.quote(str(common.MATERIAL_CACHE)) + ' ' + shlex.quote(json.dumps(query))
CLAIM|44|一致|scripts/delivery-mode/packet-template/steps/run-local-step.py:111|tar 流里不放它们|for member in ['freeze-manifest.json', *sorted(set(frozen['members']) - set(skipped))]:
CLAIM|45|一致|scripts/delivery-mode/packet-template/steps/run-local-step.py:129|把名单交给接收端|cache = None if settings is None else {**settings, 'fill': cached_members(frozen, settings, ssh_options)}
CLAIM|46|一致|scripts/delivery-mode/packet-template/steps/transport-packet.py:214|接收端只允许名单里的成员缺席|require(seen == set(members), '__PKT_LABEL_UPPER___TRANSPORT_MEMBERS_INCOMPLETE')
CLAIM|47|一致|scripts/delivery-mode/packet-template/steps/transport-packet.py:95|从缓存核对大小和 SHA-256 后复制进上传目录|return written == expected['bytes'] and digest.hexdigest() == expected['sha256']
CLAIM|48|一致|scripts/delivery-mode/packet-template/steps/transport-packet.py:215|再照旧整体核对冻结清单|verified = common.verify_frozen(target, common.APPROVED_REF, uid, exact=True)
CLAIM|49|一致|scripts/delivery-mode/packet-template/steps/transport-packet.py:115|核对不符就删掉那条缓存并失败|raise RuntimeError('__PKT_LABEL_UPPER___TRANSPORT_CACHE_ENTRY_INVALID:' + expected['path'])
CLAIM|50|一致|scripts/delivery-mode/packet-template/steps/transport-packet.py:105|下次自动整包传|os.unlink(source)
CLAIM|51|一致|scripts/delivery-mode/packet-template/steps/transport-packet.py:74|缓存目录为 root:0700 目录|require(stat.S_ISDIR(info.st_mode) and info.st_uid == uid and stat.S_IMODE(info.st_mode) == 0o700 and directory.resolve() == directory, '__PKT_LABEL_UPPER___TRANSPORT_CACHE_DIRECTORY_UNSAFE')
CLAIM|52|一致|scripts/delivery-mode/packet-template/steps/transport-packet.py:142|缓存文件为 0600 文件|matched = copy_verified(descriptor, temporary, expected, uid, gid, 0o600)
CLAIM|53|一致|scripts/delivery-mode/packet-template/steps/transport-packet.py:148|先写临时文件再改名|os.replace(temporary, final)
CLAIM|54|一致|scripts/delivery-mode/packet-template/steps/transport-packet.py:158|超过上限先删本次没用到的最旧条目|for mtime, name, size in sorted(present):
CLAIM|55|一致|scripts/delivery-mode/packet-template/steps/run-local-step.py:74|缓存目录不安全或查询失败时，整包传输照常进行|if child.returncode != 0 or line is None:
CLAIM|56|一致|scripts/delivery-mode/test_collect_dependencies.py:82|改为同一环境打两次比较（`scripts/delivery-mode/test_collect_dependencies.py`）|self.assertEqual(digest(first_output), digest(second_output))
CLAIM|57|一致|scripts/delivery-mode/packet-template/acceptance/helpers/collect-installer-dependencies.mjs:99|要改 `whole-locked-node-modules` 校验口径|scope: "whole-locked-node-modules"
CLAIM|58|一致|scripts/delivery-mode/test_release_cleanup.py:409|门槛：`scripts/delivery-mode/test_release_cleanup.py` 的 `TargetPathClearingTest`|class TargetPathClearingTest(CleanupCase):
CLAIM|59|一致|scripts/delivery-mode/test_deploy.py:788|门槛：`scripts/delivery-mode/test_deploy.py` 的清理流程测试|def test_target_paths_left_after_the_cleanup_stop_the_deploy_before_the_preflight(self):
CLAIM|60|一致|scripts/delivery-mode/test_collect_dependencies.py:20|门槛：`scripts/delivery-mode/test_collect_dependencies.py`|class CollectedDependenciesTest(unittest.TestCase):
CLAIM|61|一致|scripts/delivery-mode/packet-template/steps/verify-steps.py:265|门槛：`scripts/delivery-mode/packet-template/steps/verify-steps.py` 的缓存用例|case('receiver stores large frozen members in a private content-addressed cache', stores_large_members)
CLAIM|62|一致|scripts/delivery-mode/packet-template/steps/README.md:91|缓存用例出包时在 Hermes 上运行|它要求在主机名为 `hermes-home` 的 Hermes 上用普通账号运行

Mac 上的包大小与哈希、上传/下载速度、17 天锁文件变化、分析文档第 7 节以及生产上线日志都没有可读原件，未能核对；`.agents/reviews/topic-deploy-speed/` 在稀疏检出中缺失，`git diff` 只显示 round-1 至 round-4，文件内容未能读取。
