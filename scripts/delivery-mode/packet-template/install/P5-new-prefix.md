# S1：完整候选运输与独立新安装目录

S1 分两步，都经[步骤入口](../steps/README.md)运行：`S1_TRANSPORT` 把冻结包传到服务器，`S1_INSTALL` 发布运输目录、操作目录和证据根，并安装新版本。可执行入口是 [S1-publish-and-install.py](S1-publish-and-install.py)，它依次调用[完整安装助手](__PKT_LABEL__-artifact-install.mjs)、产品自带的安装程序和完整校验程序。

```sh
/usr/bin/python3 -I /var/tmp/__PKT_LABEL__-packet-upload/__PKT_DATE__-__PKT_LABEL__-change-packet-01/install/S1-publish-and-install.py --approved-frozen-__PKT_LABEL__-packet /var/tmp/__PKT_LABEL__-packet-upload/__PKT_DATE__-__PKT_LABEL__-change-packet-01
```

`S1_TRANSPORT` 独占新建上传目录 `/var/tmp/__PKT_LABEL__-packet-upload/__PKT_DATE__-__PKT_LABEL__-change-packet-01`（父目录 root:root 0700），边写边核对每个文件的大小和 SHA，写完再整体读回；目录已存在就拒绝，不覆盖任何现存材料。上传目录只是运输副本；S1 再把它发布到 `/var/tmp/himawari-__PKT_LABEL__-__PKT_DATE_COMPACT__/packet`。

| 路径 | 属主、权限和作用 |
| --- | --- |
| `/var/tmp/himawari-__PKT_LABEL__-__PKT_DATE_COMPACT__` | root:__PKT_SERVICE_GID__ 0750，独占新建；放包、输入、验证源码和验收目录。 |
| `…/packet`、`/opt/himawari/operations/__PKT_LABEL__-__PKT_DATE_COMPACT__` | 目录 root:__PKT_SERVICE_GID__ 0750，冻结文件 root:__PKT_SERVICE_GID__ 0640。签署辅助文件不在 S1 发布，由 S6 的发布步骤按其规则发布。 |
| `…/acceptance` | 生产账号 0700，后续普通账号验收和 read 用的受控目录。 |
| `/var/lib/himawari/__PKT_LABEL__-__PKT_DATE_COMPACT__-evidence` | 生产账号 0700；结果和原件 0600，S7 的 root 启动报告另为 root:__PKT_SERVICE_GID__ 0640。 |
| `/opt/himawari/releases/__PKT_DATE__-__PKT_LABEL__` | 新的完整正式安装，root 所有；目录 0755、运行时普通文件 0644、命令包装 0755。旧版本 `__PKT_DATE__-__PKT_LABEL__` 保持不动。 |
| `…/validation` | root:__PKT_SERVICE_GID__ 0750；原始源码字节和权限作为已核验输入保留，S6 复制到普通账号自己的短临时目录后才使用。 |

脚本拒绝：错误主机或账号、Node 的 SHA 变化、旧 unit 或旧配置的 SHA 与绑定不符、任一目标已存在、符号链接、冻结文件增删或摘要变化。输入由 [p5-materials.json](p5-materials.json) 绑定：精确的源码 bundle、候选安装包、构建上下文、整份锁定依赖归档及其证明、`npm ls` 的 JSON 和 Python 归档。生产上不运行 `npm ci`、构建、检查、测试，也不下载工具。

安装助手核对冻结时记录的全部源码构建输入的 SHA 和权限，完整校验程序的锁文件、源码、清单、迁移和全部字节检查都保留。装好运行时和三个命令包装后再跑一次完整校验，再把同一候选的浏览器文件复制到 `share/control-center`。最后按真实安装路径重新计算全树摘要，与预期的完整文件集合比较，逐项保存界面、命令包装和安装证明。

S1 只安装，不改现有数据库、配置、unit、验收材料或运行中的服务。唯一的例外是源码缓存 `/opt/himawari/source-cache.git`（root 所有的 git 对象仓库，只增不减，ADR 0151）：源码 bundle 可能是只带新增部分的增量包，安装助手先把它取进这个缓存，再从缓存检出冻结的提交；缓存缺少增量包的基点时，上线前检查在上传之前就拒绝。任何失败都保留不完整的新目标和日志，不覆盖旧安装，不自动重试。

S9 的自动清理目标是 `/var/tmp/himawari-__PKT_LABEL__-__PKT_DATE_COMPACT__`，不是初始上传目录。初始上传的冻结整包保留供 Claude 复核；停止报告要写明它的实际大小和保留理由，不能算进已删除的路径。若随后决定删除这个 root 所有的运输副本，先准备只针对这个确切目录的脚本，并核对没有使用者、Mac 上的冻结包和结果证据都已保留。
