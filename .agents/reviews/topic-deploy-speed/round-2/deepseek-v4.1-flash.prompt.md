你是独立的方案审核者。
你能用的工具：read、grep、glob、websearch、webfetch，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。
下面是一份还没动手实施的方案。逐条对照代码和一手来源核对：有没有漏掉的场景、判断错的地方、和业界成熟做法不一致的地方。方案作者的说法可能有错。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.agents/instructions/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
你的额外侧重：错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销的操作，以及规则文件、说明文档和代码是否一致。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你查过的这类路径和结论。
输出格式：按严重度从高到低排列，每条写：严重度、问题、证据（文件:行引用的代码，或网址和原话）、你建议怎么改。把「证实的」和「推测」分开写。最后写：如果由你来定，你会怎样改这份方案，并逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 3cbd77356f7f65db72d28ae15ee687fa4dd3e912。
待审核的方案：
# 上线提速方案：失败残留自动处理、依赖包按内容复用

2026-11-15 JST，第 2 版（并入 DeepSeek 独立方案和新核实的数据）。只是方案，Andy 同意、当前这次上线结束后才写代码。耗时数据见 `/mnt/project-files/deploy-speed/analysis-2026-11-15.md`。

## 对标
- ChatGPT/Claude 这类产品自己的上线方式没有公开资料，这里对标公开的部署工具。Docker 镜像仓库推送前先问“这一层你有没有”，有就不传：OCI 分发规范写 “the registry indicates that its not necessary because the layer is already known”（https://github.com/opencontainers/distribution-spec/blob/main/spec.md）。Nix 的 `nix-copy-closure` 先问目标机缺哪些路径，只发缺的（https://nix.dev/manual/nix/2.26/command-ref/nix-copy-closure）。这两种做法都要求“同样的输入打出同样的字节”，Reproducible Builds 项目把这叫可复现构建（https://reproducible-builds.org/docs/definition/）。
- 根因修复，不是补丁。上传慢的根因有两层：每次都重传没变的 316 MB；而且就算想复用也复用不了，因为依赖包每次打出来字节都不一样（见前提 11）。残留挡住预检的根因是“预检要求哪些路径不存在”和“清理处理哪些路径”是两份分开写的清单，且清理对有内容的资格目录只保留不处理。

## 前提（每条附来源和原话）
1. 预检要求一组目标路径都不存在。`scripts/delivery-mode/deploy-preflight.py:99` `def target_paths(binding):`，第 199 行 `('TARGET_PATH_ABSENT ' + path, facts.get('targetPath.' + path) == 'absent')`。
2. 清理遇到非空资格目录只保留。`scripts/delivery-mode/release-cleanup-remote.py:257` `keep(target, 'qualification-not-empty')`。这是 I-56 当时的决定，测试 `scripts/delivery-mode/test_release_cleanup.py:364` `test_directory_with_content_stays_for_the_preflight_to_report` 固定了它。
3. 清理已有“改名留现场”的先例。`release-cleanup-remote.py:296` `target = path + '.attempt-failed-' + stamp`。
4. 失败现场按个数保留。`scripts/delivery-mode/release-cleanup.py:17` `KEEP_FAILED_ACCEPTANCE = 2`。
5. 预检要求服务在运行。`deploy-preflight.py:184` `('SERVICE_ACTIVE', facts.get('active') == 'active')`。
6. 清理失败现在不拦部署。`scripts/delivery-mode/deploy.sh:16` `|| echo "DEPLOY_CLEANUP_FAILED $1: the deployment result is unchanged; ...`。
7. 上传时服务器逐文件核对哈希，再按冻结清单整体核对。`scripts/delivery-mode/packet-template/steps/transport-packet.py:87` `require(seen == set(members), ...)`，第 88 行 `verify_frozen(target, common.APPROVED_REF, uid, exact=True)`。
8. 包里的文件不许是硬链接。`packet-template/steps/packet-common.py:41` 读文件时要求 `before.st_nlink == 1`。所以第 1 版方案的“硬链接复用”不成立，改成核对后复制。
9. 安装要求正好 7 个材料。`packet-template/install/__PKT_LABEL__-artifact-install.mjs:21` `materials.files.length === 7`。
10. 依赖包打包时 tar 参数已经固定。`packet-template/install/collect-installer-dependencies.mjs:88` `"--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner"`。我在本机（GNU tar 1.35、gzip 1.12）用这组参数对同一文件打包两次（中间改了文件时间），两次哈希相同，gzip 头里时间为 0。Hermes 上的 tar/gzip 版本未核实。
11. 11-15 四个包的 node-modules.tar.gz 哈希各不相同（`036e614f…`、`4855a888…`、`1a94c48b…`、`a8a99a5f…`，来自各包的 `packet-parameters.json`），而锁文件这期间没变。比对第 3、4 个包的 `materials/node-modules.json`：37,581 个文件里只有 1 个不同，`node_modules/.vite/vitest/da39a3ee…/results.json`，这是 vitest 跑测试时写进 node_modules 的结果缓存，不是依赖。包里还有 `node_modules/.vite`（4 个条目）和 `node_modules/.vite-temp`（1 个）。
12. 11-15 第 4 次尝试停在 `PREFLIGHT_CHECK TARGET_PATH_ABSENT /var/lib/himawari/qualification/twentyninth-20261115 failed`（10:51 部署日志）；此前另两条残留是部署线程手动移走的。那两条当时为什么没被清理，没有清理输出可查，原因未核实。
13. 生产机 /opt 和状态盘可能是同一个文件系统：部署日志 `PREFLIGHT_FACTS` 里 `optFree` 和 `stateFree` 都是 `63679520768`。这是推断，实施时用 `stat -c %d` 比设备号确认；不是同一个就只改名同盘部分，其余保留由预检拦。

## 第 1 部分：上次失败的残留由 deploy.sh 自己移开（先做）

- 把 `target_paths(binding)` 挪进预检和清理共同导入的模块，两边只剩一份清单。这和 I-56 记录里提过的“统一的本次部署占用路径清单”是同一个方向，但只做到共用函数，不新建 `owned-paths.json`。
- 清理对清单里每条已存在的路径：属于正在服务的版本（含它的资格目录，从当前 operations 目录名推出）、回滚目标、或被进程引用，就保留，预检照旧拦下，这是真冲突；否则整条路径改名移到 `/var/lib/himawari/release-cleanup/failed-attempts/<时间>/`，并记下原路径。只改名不删除。这会改掉 I-56 的“有内容就保留”，前提 2 的测试要有意反过来，`test_deploy.py:101` 的 `test_leftover_target_path_is_refused` 保留（预检本身规则不变）。
- 只在服务正常运行时移（前提 5）。服务停着的失败现场不动，照现有规则先 `rollback.sh`。
- 改名失败就保留，让预检报错，不退而求其次复制或删除。
- `failed-attempts/` 按个数保留，默认 2，与 `KEEP_FAILED_ACCEPTANCE` 一样写成可改的常量。
- 部署前那次清理失败改成直接停下（前提 6 现在是只打印），因为清理失败后预检必然被残留拦下，早停省时间，报错也更准。部署后那次清理失败仍只打印，不影响结果。

门槛（同类残留已出现 3 次，按 `.claude/rules/incident-gates.md` 要硬门槛）：
- `test_release_cleanup.py`：三类目标路径都有非空残留时，清理后预检目标路径全部不存在，内容完整出现在 `failed-attempts/` 下。
- 断言清理处理的清单就是 `target_paths()` 的返回值，以后预检加路径，清理自动跟上。
- 反向：正在服务版本的资格目录、被进程引用的路径不移动，预检照旧失败。
- `test_deploy.py`：部署前清理失败时 deploy.sh 在预检之前退出。
- `docs/incidents-and-gates.md` 新增一行（下一个编号 I-109），I-56 那行补一句“非空也移走”。

## 第 2 部分：依赖包按内容复用，没变就不传

2a. 先让依赖包可复现（根因）：
- 打包时不收 node_modules 里的工具缓存目录（`.vite`、`.vite-temp`，名单放在 collector 的常量里，并在打包时检查：任何不属于锁文件包、也不是 `.bin`/`.package-lock.json` 的顶层点目录都直接报错，逼着新缓存目录被看见，而不是悄悄进包）。
- 门槛：测试用同一锁文件、不同的 `.vite` 内容打两次包，断言两次 tar 哈希相同；并在 `run-packet-checks.py` 加一项：本次包的 `packageLockSha256` 与上一个包相同而 tar 哈希不同就失败。

2b. 生产机已有就不传：
- 生产机建 `/opt/himawari/material-cache/sha256/<哈希>`，root 所有，目录 0755、文件 0644。
- S1_TRANSPORT 前 Mac 经 SSH 只读问一次：冻结清单里大于 `materialCacheMinBytes`（写在 `instances/andy-production.json`，不写死）的文件，缓存里有哪些。tar 流只放缓存没有的。
- 服务器端对缓存命中的文件：重算 SHA-256、核对大小，一致才复制到上传目录（前提 8 不允许硬链接），不一致按没命中处理并以 `MATERIAL_CACHE_MISS_AFTER_QUERY` 失败，下次自动全量。之后照旧跑前提 7 的整体核对，安装脚本和 7 个材料（前提 9）完全不改，安全核对强度不变。同盘复制 316 MB 预计几秒（推断，没测）。
- 新收到的大文件核对通过后复制进缓存。缓存只留正在服务、回滚目标和本次用到的哈希，其余由 `release-cleanup-remote.py` 删除，有测试。
- 问缓存失败或缓存目录不存在时退回全量传，不报错。

预计效果（推断，按 11-15 上传速度换算）：锁文件不变时上传从 413 MB 降到约 97 MB，从 272–365 秒降到约 65–90 秒，每次省约 3.5–4.5 分钟。锁文件 17 天只变过 1 次；失败重试同样便宜。

门槛：`transport-packet` 夹具测试覆盖全中、部分中、全不中、缓存文件被篡改（拒绝且不算命中）、缓存目录权限不安全；`test_deploy.py` 覆盖“问缓存失败退回全量”。

## 不做或以后再说
- 生产机去拉包：2b 之后每次只剩约 97 MB。瓶颈多半是家里宽带上行（Mac 下载 3.8 MB/s，上传到生产 1.1–1.5 MB/s；推断，未单独测上行）。Hermes 也在家里，从它拉同样受限；真要提速得把出包挪到机房的机器，改动大，2b 之后只能再省约 1 分钟。放弃。
- 剔除生产上不加载的二进制（onnxruntime 其他平台 255 MB，musl 和 biome 151 MB，未压缩）：2b 之后只影响锁文件变的那次上传，但每次安装都要解压 907 MB 并逐文件算哈希，剔掉能少约 45%（推断省 0.5–1 分钟）。要改 `whole-locked-node-modules` 口径，单独 PR，第 1、2 部分上线后再定。
- S6 验收（337 秒）：要逐项核对它查的东西 CI 和安装读回是否已查过，另做。
- 失败后的重试开关（`--retry`）：DeepSeek 提议，第 1 部分自动移开残留后不需要，不做。
- Hermes 构建约 4 分钟：没有分步数据，下次出包时存下 `PACKET_STEP` 日志再看。

## 要 Andy 拍板的
1. 同意“上次失败的残留（包括有内容的资格目录）自动改名移到 failed-attempts、只改名不删、保留最近 2 份”作为长期规则。这改掉 I-56 当时“有内容就保留、等人处理”的决定。
2. 同意在生产机新建约 330 MB 的依赖缓存目录。
3. 改的是上线脚本，按规则合并前要 Andy 说“合并”。
