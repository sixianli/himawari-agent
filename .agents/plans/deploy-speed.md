# 上线提速方案：失败残留自动处理、依赖包按内容复用

2026-11-15 JST，第 3 版。第 2 版经 DeepSeek 审核（`.agents/reviews/topic-deploy-speed/round-2/deepseek-v4.1-flash.md`），成立的意见已并入，见文末“审核意见怎么处理的”。只是方案，Andy 同意、当前这次上线结束后才写代码。耗时数据见 `/mnt/project-files/deploy-speed/analysis-2026-11-15.md`。

## 对标
- ChatGPT/Claude 这类产品自己的上线方式没有公开资料，这里对标公开的部署工具。Docker 镜像仓库推送前先问“这一层你有没有”，有就不传：OCI 分发规范写 “the registry indicates that its not necessary because the layer is already known”（https://github.com/opencontainers/distribution-spec/blob/main/spec.md）。Nix 的 `nix-copy-closure` 只发目标机缺的路径（https://nix.dev/manual/nix/2.26/command-ref/nix-copy-closure）。这两种做法都要求同样的输入打出同样的字节，Reproducible Builds 项目把这叫可复现构建（https://reproducible-builds.org/docs/definition/）。
- 根因修复，不是补丁。上传慢有两层根因：每次重传没变的 316 MB；而且想复用也复用不了，因为依赖包每次打出来字节都不同（前提 11）。残留挡住预检的根因是“预检要求哪些路径不存在”和“清理处理哪些路径”是两份分开写的清单，而且清理对有内容的资格目录只保留不处理（前提 2）。

## 前提（每条附来源和原话）
1. 预检要求一组目标路径都不存在。`scripts/delivery-mode/deploy-preflight.py:99` `def target_paths(binding):`，第 199 行 `('TARGET_PATH_ABSENT ' + path, facts.get('targetPath.' + path) == 'absent')`。
2. 清理遇到非空资格目录只保留。`scripts/delivery-mode/release-cleanup-remote.py:257` `keep(target, 'qualification-not-empty')`，测试 `scripts/delivery-mode/test_release_cleanup.py:364` `test_directory_with_content_stays_for_the_preflight_to_report` 固定了它。这是 I-56 当时的决定（`docs/incidents-and-gates.md:93`）。
3. 清理已有“只留小文件证据、删可重建内容”的做法。`release-cleanup-remote.py:27` `REBUILDABLE_SUBTREES = {'packet', 'validation', 'input', 'materials', 'runtime-tools', 'question-12-downloads', 'node_modules'}`，第 129 行 `def archive_small_files(source, destination, limit, apply):`。
4. 规则不许只改名了事，减少证据要先问。`.agents/instructions/disk-space-hygiene.md:8` “包括失败的尝试，并且由脚本完成而不是手工完成，也绝不能只是给它们改名了事”，同一行 “减少证据之前要先问”。
5. 清理对旧版本有四种保留理由。`release-cleanup-remote.py:200-207`：`keep(path, 'serving' if ...)`、`keep(path, 'symbolic-link')`、`keep(path, in_use(path))`、`keep(path, 'named-by-database:' + ...)`。
6. 预检要求服务在运行。`deploy-preflight.py:184` `('SERVICE_ACTIVE', facts.get('active') == 'active')`。
7. 清理失败现在不拦部署。`scripts/delivery-mode/deploy.sh:16` `|| echo "DEPLOY_CLEANUP_FAILED $1: the deployment result is unchanged; ...`。
8. 上传接收端要求成员一个不缺。`packet-template/steps/transport-packet.py:87` `require(seen == set(members), ...)`；`packet-template/steps/README.md:47` “多出成员、重复成员、路径越界或缺成员都失败”；`packet-template/steps/verify-steps.py:230` `case('receiver rejects a missing member', ...)`。
9. 包里的文件不许是硬链接。`packet-template/steps/packet-common.py:41` 要求 `before.st_nlink == 1`。所以复用只能核对后复制。
10. 真正出包用的依赖收集脚本是 acceptance 下那份。`scripts/delivery-mode/make-packet.py:784` `self.upload(TEMPLATE / 'acceptance/helpers/collect-installer-dependencies.mjs', ...)`；`install/` 下另有一份，目前两份字节相同（`cmp` 实测）。tar 参数已固定：第 88 行 `"--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner"`。本机（GNU tar 1.35、gzip 1.12）用这组参数对同一文件打包两次，哈希相同，gzip 头时间为 0；Hermes 上的版本未核实。
11. 11-15 四个包的 node-modules.tar.gz 哈希各不相同（`036e614f…`、`4855a888…`、`1a94c48b…`、`a8a99a5f…`，来自 Mac 上各包的 `packet-parameters.json`），这期间锁文件没变。比对第 3、4 个包的 `materials/node-modules.json`：37,581 个文件只有 1 个不同，`node_modules/.vite/vitest/da39a3ee…/results.json`，是 vitest 跑测试写进 node_modules 的结果缓存。包里还有 `node_modules/.vite`（4 条）和 `.vite-temp`（1 条）。这是我在 Mac 文件上直接比对的，没有放进仓库。
12. 上传目录、release、operations、资格目录分布在 `/var/tmp`、`/opt`、`/var/lib` 下。`packet-common.py:17` `UPLOAD = Path('/var/tmp/__PKT_LABEL__-packet-upload/...')`；`packet-template/inputs/bindings.draft.json:84,91,94,118`。三处是不是同一个文件系统未核实（部署日志只显示 `optFree` 与 `stateFree` 相等）。
13. 11-15 第 4 次尝试停在 `PREFLIGHT_CHECK TARGET_PATH_ABSENT /var/lib/himawari/qualification/twentyninth-20261115 failed`（10:51 部署日志）；此前另两条残留由部署线程手动移走，当时为什么没被清理，没有清理输出可查，未核实。

## 第 1 部分：上次失败的残留由 deploy.sh 自己处理（先做）

- 一份“本次部署占用路径”清单，预检和清理共同导入：在 `target_paths()` 现有路径之外补上真正的上传目录（前提 12，现有清单只有 `transportRoot` 的上一级）。清单函数校验每条路径：绝对路径、规范化后父目录正好是允许的根（releases、operations、qualification、evidence、/var/tmp 下的上传根），不是根本身，不是符号链接，否则报错。
- 清理对清单里已存在的路径：属于正在服务的版本（从服务中那版的 bindings 读出它的各路径，不靠目录名猜）、回滚目标、被进程引用、被数据库引用、是符号链接，都保留，预检照旧拦下，这是真冲突。其余按现有做法处理（前提 3）：先把报告、日志等小文件复制到 `release-cleanup/failed-attempts/<UTC 时间>/<原绝对路径镜像>/`，可重建内容（包副本、node_modules 等）删除，然后删掉原路径。不靠改名了事（前提 4）。
- 失败证据按份数加总字节上限保留，默认 2 份、上限写成可改的常量。
- 只在服务正常运行时处理（前提 6）。服务停着的失败现场不动，照现有规则先 `rollback.sh`。
- 部署前清理拆成两段：占用路径这段失败就直接停下，并说清是哪条路径；其他卫生清理失败照旧只打印（前提 7）。

门槛（同类残留已出现 3 次，按 `.claude/rules/incident-gates.md` 要硬门槛）：
- `test_release_cleanup.py`：每类占用路径都有非空残留时，清理后预检目标路径全部不存在，小文件证据在 `failed-attempts/` 下按原路径镜像保存；前提 2 那条测试有意反过来。
- 断言清理处理的清单和预检用的是同一个函数的返回值。
- 反向：服务中版本的资格目录、被进程引用、被数据库引用、符号链接、越出允许根的路径（`/`、`..`、根本身）不处理，预检照旧失败。
- `test_deploy.py`：占用路径清理失败时在预检前退出；卫生清理失败而占用路径已清空时部署继续。
- 扩充 `docs/incidents-and-gates.md` 的 I-56 那一行（同一领域、同一报错），次数改为 3，补这次的现场和门槛，不另开新行。

## 第 2 部分：依赖包按内容复用，没变就不传

2a. 先让依赖包可复现（根因）：
- 改 `acceptance/helpers/collect-installer-dependencies.mjs`（前提 10），同步 `install/` 那份及其哈希清单，加测试断言两份字节相同。
- 在复制目录树那一层就只收锁文件列出的包目录和 `.bin`、`.package-lock.json`；其他顶层条目（`.vite`、`.vite-temp` 和以后新出现的缓存）直接报错不进包，这样包内容、文件清单和 `node-modules.json` 三者一致，安装时的读回比对不受影响。报错而不是悄悄跳过，是为了以后新缓存目录出现时有人看见。
- 根因的另一半：让 vitest 的缓存目录不写进 node_modules（vitest 配置 `cacheDir`），否则上面的检查每次出包都会拦下。
- 门槛：同一环境把同一份依赖打两次包，断言哈希相同；`node-modules.json` 记下 tar 和 gzip 版本。不拿旧包做对照，因为工具升级也会改字节。

2b. 生产机已有就不传：
- 生产机建 `/opt/himawari/material-cache/sha256/<哈希>`，目录 0700、文件 0600，root 所有。写入先写临时文件、`fsync`、再 `os.replace`；读取时要求普通文件、属主 root、`nlink == 1`、`O_NOFOLLOW` 打开后核对大小和 SHA-256。
- 传输改成显式声明：Mac 先只读问一次哪些大文件已在缓存，然后在 tar 流开头发一份“这些成员由缓存补”的清单。接收端只允许清单里的成员缺席，逐个从缓存核对后复制进上传目录；没声明的缺成员、被截断的流照旧失败。同步改 `steps/README.md` 和 `verify-steps.py`，新增“声明的缺成员成功、未声明的失败、截断失败”三条用例。安装脚本和 7 个材料（前提 9 之外的安装侧）不改。
- 缓存文件核对不符：先把这个条目移出缓存再失败，保证下一次查询不命中、走全量。测试：第一次失败，第二次全量成功。
- 缓存大小门槛 `materialCacheMinBytes` 写在实例文件，由 `make-packet.py` 冻结进包参数，部署时读取，两端校验类型和范围，有测试证明改它会改变行为。
- 缓存修剪和上传共用一把锁，修剪只留正在服务、回滚目标和本次用到的哈希，另设字节上限；缓存占用算进预检的空间检查。
- 问缓存失败或缓存不存在时退回全量传。

预计效果（推断，按 11-15 上传速度换算，未实测）：锁文件不变时上传从 413 MB 降到约 97 MB，从 272–365 秒降到约 65–90 秒，每次省约 3.5–4.5 分钟。锁文件 17 天只变过 1 次。缓存最多约 3 份依赖包，约 1 GB，以字节上限为准。

## 不做或以后再说
- 生产机去拉包：2b 之后每次只剩约 97 MB。瓶颈多半是家里宽带上行（Mac 下载 3.8 MB/s，上传到生产 1.1–1.5 MB/s；推断，未单独测上行）。Hermes 也在家里，从它拉同样受限；真要快得把出包挪到机房的机器，改动大，2b 之后只能再省约 1 分钟。放弃。
- 剔除生产上不加载的二进制（onnxruntime 其他平台 255 MB，musl 和 biome 151 MB，未压缩）：2b 之后只影响锁文件变的那次上传，但每次安装都要解压 907 MB 并逐文件算哈希，剔掉能少约 45%（推断省 0.5–1 分钟）。单独 PR，第 1、2 部分上线后再定。
- S6 验收（337 秒）：要逐项核对它查的东西 CI 和安装读回是否已查过，另做。
- `--retry` 开关：第 1 部分之后不需要。
- Hermes 构建约 4 分钟：没有分步数据，下次出包时存下 `PACKET_STEP` 日志再看。

## 要 Andy 拍板的
1. 同意“上次失败的残留由 deploy.sh 自动处理：留报告和日志等小文件、删可重建内容、失败证据保留最近 2 份”作为长期规则，以后不再逐次授权。这改掉 I-56 当时“有内容就保留等人处理”的决定，也属于规则里“减少证据要先问”的那种情况。
2. 同意在生产机新建依赖缓存目录，最多约 1 GB（字节上限可改）。
3. 改的是上线脚本，按规则合并前要 Andy 说“合并”。

## 审核意见怎么处理的（round-2，17 条）
- 采纳：改错收集脚本（高 1）、路径校验（高 2）、数据库引用保留（高 3）、只改名违反磁盘规则（高 4）、坏缓存永久卡住（高 5）、传输契约要显式改（高 6）、跨盘改名（中 7，改成不再改名）、锁（中 8）、配置接线（中 9）、缓存权限和原子写（中 10）、目录撞名（中 11，按原路径镜像）、上传目录漏在清单外（中 12）、清理失败要分段（中 13）、扩充 I-56 不开新行（中 14）、可复现检查不比旧包（中 15）、在复制层排除（中 16）、缓存容量（中 17）。
- 补充：可复现的根因还要让 vitest 缓存不写进 node_modules，审核没提。
