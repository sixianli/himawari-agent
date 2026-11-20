CLAIM|1|一致|docs/incidents-and-gates.md:93|2026-11-15 第二十九版上线尝试了 4 次，第 4 次停在上线前检查（预检，`deploy-preflight.py`）|2026-11-15 第二十九版第 4 次尝试又停在 `PREFLIGHT_CHECK TARGET_PATH_ABSENT /var/lib/himawari/qualification/twentyninth-20261115`
CLAIM|2|找不到|-|前 3 次失败后|-|-
CLAIM|3|一致|docs/incidents-and-gates.md:93|原因是上一次失败留下的资格目录还在|前一次 S6 失败后这个目录里有内容，清理按当时的规则保留（`qualification-not-empty`）
CLAIM|4|找不到|-|完整测量见 `/mnt/project-files/deploy-speed/analysis-2026-11-15.md`|-|-
CLAIM|5|一致|.agents/plans/deploy-speed.md:1|方案见 `.agents/plans/deploy-speed.md`|# 上线提速方案：失败残留自动处理、依赖包按内容复用
CLAIM|6|找不到|-|两轮模型审核记录见 `.agents/reviews/topic-deploy-speed/`|-|-
CLAIM|7|找不到|-|每次上线都要从 Mac 往生产机传约 413 MB 的上线包，耗时 272–365 秒|-|-
CLAIM|8|找不到|-|其中依赖包 `node-modules.tar.gz` 约 282 MB、python 约 34 MB|-|-
CLAIM|9|找不到|-|它们 17 天里只因锁文件（`package-lock.json`，锁定依赖版本的文件）变化而真正变过 1 次|-|-
CLAIM|10|一致|scripts/delivery-mode/deploy-preflight.py:204|预检要求一组目标路径都不存在|        *[('TARGET_PATH_ABSENT ' + path, facts.get('targetPath.' + path) == 'absent') for path in paths],
CLAIM|11|一致|scripts/delivery-mode/deploy-preflight.py:211；scripts/delivery-mode/release-cleanup.py:60|清单现在由预检和清理共用|        'targetPaths': owned.target_paths(binding),
CLAIM|12|一致|scripts/delivery-mode/deploy-target-paths.py:4|`scripts/delivery-mode/deploy-target-paths.py` 第 4 行 `def target_paths(binding):`|def target_paths(binding):
CLAIM|13|一致|scripts/delivery-mode/release-cleanup-remote.py:257@5b1d5c49a6464f3197b9265a2ba1df90824a62a6|改动前，清理遇到有内容的资格目录只保留，所以同名路径下次必然过不了预检|            keep(target, 'qualification-not-empty')
CLAIM|14|一致|docs/incidents-and-gates.md:93|（I-56，`docs/incidents-and-gates.md`）|I-56
CLAIM|15|一致|.agents/instructions/disk-space-hygiene.md:8|项目规则不许只给失败产物改名了事：`.agents/instructions/disk-space-hygiene.md` 第 8 行原文“也绝不能只是给它们改名了事”|也绝不能只是给它们改名了事
CLAIM|16|一致|scripts/delivery-mode/packet-template/steps/packet-common.py:42|上线包里的文件不许是硬链接：`scripts/delivery-mode/packet-template/steps/packet-common.py` 第 42 行要求 `before.st_nlink == 1`|    require(path.resolve() == path and stat.S_ISREG(before.st_mode) and before.st_uid == uid and before.st_nlink == 1 and not before.st_mode & 0o022, '__PKT_LABEL_UPPER___PACKET_FILE_UNSAFE:' + str(path))
CLAIM|17|找不到|-|依赖包每次出包字节都不同|-|-
CLAIM|18|找不到|-|11-15 四个包的 `NODE_MODULES_TAR_SHA256` 各不相同而锁文件没变|-|-
CLAIM|19|找不到|-|第 3、4 个包的 `node-modules.json` 37,581 个文件只差 `node_modules/.vite/vitest/…/results.json`|-|-
CLAIM|20|找不到|-|是 vitest（测试运行器）写进 node_modules 的测试结果缓存|-|-
CLAIM|21|找不到|-|这一条来自 Mac 上的包文件比对，仓库里没有原件|-|-
CLAIM|22|找不到|-|Mac 上传到生产机只有 1.1–1.5 MB/s，生产机外网下载 13.8 MB/s（11-15 各测一次，见分析文档第 7 节）|-|-
CLAIM|23|一致|scripts/delivery-mode/release-cleanup-remote.py:316|`release-cleanup-remote.py` 的 `clear_target_paths` 在其他清理之后|    clear_target_paths(plan, current, result, named_by_database, in_use, remove, keep, apply, stamp)
CLAIM|24|一致|scripts/delivery-mode/release-cleanup-remote.py:335|逐个看预检要求不存在的路径|    for path in plan['targetPaths']:
CLAIM|25|一致|scripts/delivery-mode/release-cleanup-remote.py:330|属于正在服务的版本、回滚目标保留|    protected = {current['prefix']: 'serving', current['operations']: 'serving', current['stage']: 'serving', current['evidence']: 'serving', current['rollbackPrefix']: 'rollback-target'}
CLAIM|26|一致|scripts/delivery-mode/release-cleanup-remote.py:332|属于正在服务的版本（含它的资格目录）保留|        protected[current['qualification']] = 'serving'
CLAIM|27|一致|scripts/delivery-mode/release-cleanup-remote.py:343|被进程或数据库引用保留|            reason = protected.get(path) or in_use(path) or ('named-by-database:' + named_by_database[path] if path in named_by_database else None)
CLAIM|28|一致|scripts/delivery-mode/release-cleanup-remote.py:340|或者是符号链接的，保留|        if os.path.islink(path) or not os.path.isdir(path):
CLAIM|29|一致|scripts/delivery-mode/release-cleanup.py:97|保留并报 `CLEANUP_TARGET_PATH_LEFT`|        print('CLEANUP_TARGET_PATH_LEFT ' + item['reason'] + ' ' + item['path'])
CLAIM|30|一致|scripts/delivery-mode/release-cleanup-remote.py:348-350|其余先把报告和日志等小文件复制到 `release-cleanup/failed-attempts/<时间>/<原绝对路径>/`，再删除|        result['archived'] += archive_small_files(path, destination, plan['smallFileBytes'], apply)
CLAIM|31|一致|scripts/delivery-mode/release-cleanup-remote.py:337|越出允许父目录的路径以 `CLEANUP_TARGET_PATH_INVALID` 拒绝|            fail('CLEANUP_TARGET_PATH_INVALID')
CLAIM|32|一致|scripts/delivery-mode/release-cleanup-remote.py:355|失败现场保留最近 2 份|        if position >= plan['keepFailedAttempts'] or (position > 0 and total > plan['failedAttemptBytes']):
CLAIM|33|一致|scripts/delivery-mode/release-cleanup-remote.py:355|总量超过 200 MB 时只留最新一份|        if position >= plan['keepFailedAttempts'] or (position > 0 and total > plan['failedAttemptBytes']):
CLAIM|34|一致|scripts/delivery-mode/release-cleanup.py:19|`release-cleanup.py` 的 `KEEP_FAILED_ATTEMPTS`|KEEP_FAILED_ATTEMPTS = 2
CLAIM|35|一致|scripts/delivery-mode/release-cleanup.py:20|`release-cleanup.py` 的 `FAILED_ATTEMPT_BYTES`|FAILED_ATTEMPT_BYTES = 200 * 1024 ** 2
CLAIM|36|一致|scripts/delivery-mode/deploy.sh:20|部署前那次清理后仍有路径被占用时，`deploy.sh` 在预检前以 `target-paths-left` 停下|    result target-paths-left PREFLIGHT 4
CLAIM|37|一致|scripts/delivery-mode/test_collect_dependencies.py:62|依赖收集脚本（`acceptance/helpers/collect-installer-dependencies.mjs`，`install/` 下是同一份）|        self.assertEqual((TEMPLATE / 'install/collect-installer-dependencies.mjs').read_bytes(), COLLECTOR.read_bytes())
CLAIM|38|一致|scripts/delivery-mode/packet-template/acceptance/helpers/collect-installer-dependencies.mjs:90|在每个依赖根下只收锁文件列出的包、`.bin` 和 `.package-lock.json`|    fail(locked.has(name) || NPM_ENTRIES.has(name), `P5_MODULE_UNEXPECTED_ENTRY:${relative}/${name}`);
CLAIM|39|一致|scripts/delivery-mode/packet-template/acceptance/helpers/collect-installer-dependencies.mjs:79|`.vite`、`.vite-temp`、`.cache` 这几个工具缓存跳过|const TOOL_CACHE_ENTRIES = new Set([".vite", ".vite-temp", ".cache"]);
CLAIM|40|一致|scripts/delivery-mode/packet-template/acceptance/helpers/collect-installer-dependencies.mjs:90|其他不认识的条目以 `P5_MODULE_UNEXPECTED_ENTRY` 报错|    fail(locked.has(name) || NPM_ENTRIES.has(name), `P5_MODULE_UNEXPECTED_ENTRY:${relative}/${name}`);
CLAIM|41|一致|scripts/delivery-mode/instances/andy-production.json:33|实例文件的 `materialCache` 的 `minBytes` 16 MiB|    "minBytes": 16777216,
CLAIM|42|一致|scripts/delivery-mode/instances/andy-production.json:34|实例文件的 `materialCache` 的 `maxBytes` 1 GiB|    "maxBytes": 1073741824
CLAIM|43|一致|scripts/delivery-mode/make-packet.py:441|`materialCache` 可改|    setting = instance.get('materialCache')
CLAIM|44|一致|scripts/delivery-mode/make-packet.py:458|`materialCache` 冻结进包参数 `MATERIAL_CACHE_JSON`|        'MATERIAL_CACHE_JSON': material_cache(instance),
CLAIM|45|一致|scripts/delivery-mode/packet-template/steps/run-local-step.py:44|传输前 Mac 经 SSH 只读查生产机 `/opt/himawari/material-cache/sha256/<SHA>` 里有哪些大成员|    '        info = os.lstat(root + "/sha256/" + digest)\n'
CLAIM|46|一致|scripts/delivery-mode/packet-template/steps/run-local-step.py:111|tar 流里不放它们|        for member in ['freeze-manifest.json', *sorted(set(frozen['members']) - set(skipped))]:
CLAIM|47|一致|scripts/delivery-mode/packet-template/steps/run-local-step.py:90|并把名单交给接收端|        spec = '' if cache is None else ' ' + shlex.quote(base64.b64encode(json.dumps(cache, sort_keys=True).encode()).decode())
CLAIM|48|一致|scripts/delivery-mode/packet-template/steps/transport-packet.py:203|接收端只允许名单里的成员缺席|        require(seen == set(members), '__PKT_LABEL_UPPER___TRANSPORT_MEMBERS_INCOMPLETE')
CLAIM|49|一致|scripts/delivery-mode/packet-template/steps/transport-packet.py:94|从缓存核对大小和 SHA-256 后复制进上传目录|    return written == expected['bytes'] and digest.hexdigest() == expected['sha256']
CLAIM|50|一致|scripts/delivery-mode/packet-template/steps/transport-packet.py:204|再照旧整体核对冻结清单|    verified = common.verify_frozen(target, common.APPROVED_REF, uid, exact=True)
CLAIM|51|一致|scripts/delivery-mode/packet-template/steps/transport-packet.py:104-105|核对不符就删掉那条缓存并失败|        os.unlink(source)
CLAIM|52|一致|scripts/delivery-mode/packet-template/steps/verify-steps.py:287|下次自动整包传|    case('a changed cache entry is refused and removed so the next transport sends it in full', tampered_entry_is_dropped)
CLAIM|53|一致|scripts/delivery-mode/packet-template/steps/transport-packet.py:228|传完把大成员存进缓存|            result['cache'] = store_in_cache(entries, target, members, spec, uid, gid)
CLAIM|54|一致|scripts/delivery-mode/packet-template/steps/transport-packet.py:73|root:0700 目录|        require(stat.S_ISDIR(info.st_mode) and info.st_uid == uid and stat.S_IMODE(info.st_mode) == 0o700 and directory.resolve() == directory, '__PKT_LABEL_UPPER___TRANSPORT_CACHE_DIRECTORY_UNSAFE')
CLAIM|55|一致|scripts/delivery-mode/packet-template/steps/transport-packet.py:131|0600 文件|            matched = copy_verified(descriptor, temporary, expected, uid, gid, 0o600)
CLAIM|56|一致|scripts/delivery-mode/packet-template/steps/transport-packet.py:137|先写临时文件再改名|        os.replace(temporary, final)
CLAIM|57|一致|scripts/delivery-mode/packet-template/steps/transport-packet.py:147-152|超过上限先删本次没用到的最旧条目|    for mtime, name, size in sorted(present):
CLAIM|58|一致|scripts/delivery-mode/packet-template/steps/transport-packet.py:219|缓存目录不安全时，整包传输照常进行|        result = receive_members(stream, target, expected_freeze, uid, gid, common, None, [])[0]
CLAIM|59|一致|scripts/delivery-mode/packet-template/steps/run-local-step.py:74|查询失败时，整包传输照常进行|    if child.returncode != 0 or line is None:
CLAIM|60|一致|scripts/delivery-mode/test_release_cleanup.py:408|门槛：`scripts/delivery-mode/test_release_cleanup.py` 的 `TargetPathClearingTest`|class TargetPathClearingTest(CleanupCase):
CLAIM|61|一致|scripts/delivery-mode/test_deploy.py:770|`scripts/delivery-mode/test_deploy.py` 的清理流程测试|class ProductionCleanupFlowTest(DeployHarness):
CLAIM|62|一致|scripts/delivery-mode/test_collect_dependencies.py:20|`scripts/delivery-mode/test_collect_dependencies.py`|class CollectedDependenciesTest(unittest.TestCase):
CLAIM|63|一致|scripts/delivery-mode/packet-template/steps/verify-steps.py:265|`scripts/delivery-mode/packet-template/steps/verify-steps.py` 的缓存用例|    case('receiver stores large frozen members in a private content-addressed cache', stores_large_members)
CLAIM|64|找不到|-|出包时在 Hermes 上运行|-|-
CLAIM|65|一致|scripts/delivery-mode/test_collect_dependencies.py:82|改为同一环境打两次比较（`scripts/delivery-mode/test_collect_dependencies.py`）|        self.assertEqual(digest(first_output), digest(second_output))

未能核对的部分：`/mnt/project-files/deploy-speed/analysis-2026-11-15.md` 被外部目录权限拒绝，`.agents/reviews/topic-deploy-speed/` 被记录路径保护拒绝读取；Mac 包比对、上传测速和 Hermes 运行情况等外部事实没有仓库内证据。
