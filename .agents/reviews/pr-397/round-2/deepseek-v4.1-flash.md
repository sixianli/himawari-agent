## 结论摘要

第 2 轮改动确实修好了第 1 轮指出的几处具体问题：`get` 失败清理、`collect` 缺失日志、拒绝接管、真实 SHA 反向用例。
但我发现 1 个中等的**文档与代码矛盾**（事故现场会被 `if: always()` 的删除步骤毁掉）、1 个**策略门缺口**（只禁下载不禁上传报告），以及几个低项。
ds-1、ds-4 在第 1 轮被判“不成立”的结论基本站得住，但有前提；退出码 71 在本安装脚本内不冲突，回滚路径正确，但运维手册排错表没有 71 这一行。
第 1 轮的 `judgments.md` 受工具限制读不到（`git show` 拒绝 records-path，工作区也没有该文件），因此 ds-1/ds-4 的判断是我独立看代码得出的，不是复述第 1 轮档案。

---

## 发现（按严重度）

### 1. 中：摘要被改时，文档要求“保留现场”，代码却总是删掉共享目录

- 文件:行：`docs/runbooks/ci-vps-runner-runbook.md:260`、`.github/workflows/ci.yml:396-398`、`scripts/ci/run-share.mjs:124-140`
- 问题：运维手册说摘要不符时“保留现场、先报告”，但 `ci/required` 的最后一步是 `if: always()` 删除整个本次运行目录；`collect` 把摘要不符当作缺失继续，随后 `required.mjs` 失败，删除步骤仍然执行。真正被篡改的源文件在共享目录里，不在本地诊断工件里，因此会被删掉。
- 读代码证实：
  - 手册原文：`摘要不符说明文件在存和取之间被改了，保留现场、先报告。`（`docs/runbooks/ci-vps-runner-runbook.md:260`）
  - 工作流：
    ```yaml
          - name: 删除 CI 服务器上本次运行的目录
            if: always()
            run: .ci-output/tools/bin/node scripts/ci/run-share.mjs remove
    ```
    （`.github/workflows/ci.yml:396-398`）
  - `collect` 捕获所有 `get` 错误并继续：
    ```js
    } catch (error) {
      missing.push(error.message);
    }
    ```
    （`scripts/ci/run-share.mjs:130-132`）
  - `remove` 删除整个运行目录：
    ```js
    export function remove({ root, run }) {
      rmSync(path.join(root, run), { recursive: true, force: true });
    }
    ```
    （`scripts/ci/run-share.mjs:138-140`）
- 建议：二选一，并在 ADR 0238 和手册里统一：
  - 检测到 `CI_SHARE_DIGEST_MISMATCH` 时不要执行 `remove`，或先把可疑目录复制到诊断工件再删；
  - 若坚持“总是删”，把手册改成“只保留日志和本地副本，不保留被篡改的共享文件”，不要让运维按“保留现场”去操作已经不存在的文件。

### 2. 中：策略只禁止下载 GitHub 产物，没有禁止重新上传完整报告

- 文件:行：`scripts/ci/check-policy.mjs:495-498`、`docs/adr/0238-ci-job-files-stay-on-the-ci-vps.md:63-64`
- 问题：本次事故的直接原因是报告占用 GitHub 产物额度。新策略只检查 `actions/download-artifact`，没有检查 `actions/upload-artifact` 的上传路径或名称。将来有人保留 `put` 步骤、额外加一个把 `.ci-output/public/reports` 上传到 GitHub 的步骤，`check-policy` 仍会通过，额度事故可能悄悄回来。
- 读代码证实：
  ```js
      assert(
        !job.steps.some((step) => /^actions\/download-artifact@/u.test(step.uses ?? "")),
        `Jobs must take reports and builds from the runner share, not GitHub artifacts: ${check.id}`,
      );
  ```
  （`scripts/ci/check-policy.mjs:495-498`）
  我用 grep 在 `check-policy.mjs` 中没有找到任何 `upload-artifact` 路径/名称限制。ADR 决定第 3 条明确说 GitHub 上只留 `gate-` 和 `diagnostic-`（`docs/adr/0238-ci-job-files-stay-on-the-ci-vps.md:63`）。
- 推测（风险）：当前 ci.yml 没有上传完整报告，所以现在不会触发；风险来自下一次修改没有被门拦住。
- 建议：在 `check-policy` 中限制 `actions/upload-artifact` 的 `name`/`path` 只能匹配 `diagnostic-*` 的 `.ci-output/public/diagnostics/` 和 `gate-*` 的 `.ci-output/gate/`；同时加反向用例：给某 job 加一个上传 `.ci-output/public/reports` 的步骤必须失败。

### 3. 低：拒绝接管的检查只覆盖“组不存在”，组存在时仍会接管别人建的目录

- 文件:行：`scripts/operations/ci-runner/install-runner.sh:90-99`、`scripts/operations/ci-runner/uninstall-runner.sh:38`
- 问题：新检查只在 `gh-ci-share` 组不存在时拒绝已存在的共享目录；如果组已经存在（例如管理员手工建过同名组），而 `/srv/gh-runner-share` 也已经被别人建好，脚本仍会 `install -d -m 2770 -o root -g gh-ci-share` 改掉该目录的属主/组/权限，之后 `uninstall-runner.sh all` 会 `rm -rf` 它。这与“不接管别人建的目录”的意图不完全一致。
- 读代码证实：
  ```bash
  if ! getent group "$RUNNER_SHARE_GROUP" > /dev/null; then
    if [ -e "$RUNNER_SHARE_ROOT" ] || [ -L "$RUNNER_SHARE_ROOT" ]; then
      echo "... refusing to take over a directory this script did not create" >&2
      return 71
    fi
    record_created_group "$BACKUP" "$RUNNER_SHARE_GROUP"
    groupadd --system "$RUNNER_SHARE_GROUP"
  fi
  record_created_paths "$BACKUP" "$RUNNER_SHARE_ROOT"
  install -d -m 2770 -o root -g "$RUNNER_SHARE_GROUP" "$RUNNER_SHARE_ROOT"
  ```
  （`scripts/operations/ci-runner/install-runner.sh:90-99`）
  卸载脚本无条件删除：
  ```bash
  rm -rf /etc/gh-runner "$RUNNER_SHARE_ROOT"
  ```
  （`scripts/operations/ci-runner/uninstall-runner.sh:38`）
- 建议：目录已存在时也核对属主/组/权限，或要求目录里有安装脚本写入的标记文件；不合预期同样以 71 拒绝，并补充“组存在但目录是别人的”反向测试。

### 4. 低：新增的 `collect` 标准错误输出没有任何自动测试；复制中途失败的 cpSync 分支也没被测到

- 文件:行：`scripts/ci/run-share.mjs:163-164`、`test/tooling/run-share.test.mjs:103-116`
- 问题：
  - `collect` 新增的 `CI_SHARE_COLLECT_MISSING` 只存在于 CLI `dispatch`，现有测试只测 `collect()` 返回值和磁盘结果；删掉这两行，测试仍全绿。
  - 新测试名为“复制中途出错”，实际是复制完成后在 `treeDigest(to)` 阶段因符号链接失败（`RUNNER_SHARE_ROLE`），没有覆盖 `cpSync` 自身中途抛错的路径。catch 是同一条，但测试名与实际覆盖不符。
- 读代码证实：
  ```js
      for (const reason of result.missing)
        process.stderr.write(`CI_SHARE_COLLECT_MISSING ${reason}\n`);
  ```
  （`scripts/ci/run-share.mjs:163-164`）
  测试：
  ```js
  it("复制中途出错时也不留下半份文件", async () => {
    ...
    symlinkSync("/etc/passwd", path.join(root, run, "build-linux-x64/leak"));
    ...
    await expect(get(...)).rejects.toThrow("ARTIFACT_LINK_FORBIDDEN");
    expect(existsSync(to)).toBe(false);
  ```
  （`test/tooling/run-share.test.mjs:103-116`）
- 建议：加一个 CLI 级用例捕获 `process.stderr`，验证缺失时会写 `CI_SHARE_COLLECT_MISSING ...`；若想真正覆盖“中途复制失败”，可注入一个在 cpSync 阶段抛错的场景，或把测试名改为“复制后校验出错”。

### 5. 低：退出码 71 未进入排错表，且同一 Runbook 里 prepare-vps.sh 也用 71 表示另一件事

- 文件:行：`scripts/operations/ci-runner/install-runner.sh:91-93`、`docs/runbooks/ci-vps-runner-runbook.md:127,134,262`
- 问题：`install-runner.sh` 内部退出码不冲突（已有 65、66、68、69、70、67，71 未占用），回滚也正确。但手册同一页里 `prepare-vps.sh` 的 71 表示“全局用户命名空间开关不是 1”，而排错表只写了安装脚本 70，没有 71；操作员看到安装脚本 71 时无法从排错表直接定位到“组不存在但目录已存在，拒绝接管”。
- 读代码证实：
  - 安装脚本：`return 71`（`install-runner.sh:91-93`）
  - 手册安装步骤确实写了 71（`docs/runbooks/ci-vps-runner-runbook.md:134`）
  - 同一手册 prepare-vps 段落：`确认全局开关仍是 1（否则 71）`（`docs/runbooks/ci-vps-runner-runbook.md:127`）
  - 排错表只有：`| 安装脚本以退出码 70 拒绝 | ...`（`docs/runbooks/ci-vps-runner-runbook.md:262`）
- 建议：在排错表加一行“安装脚本以 71 拒绝”，说明是共享目录已存在但组不存在，给出核对与恢复步骤（例如先确认目录来源，必要时手工移走或建组，不要直接 `uninstall all`，因为那会删除该目录）。

### 6. 低：ADR 0238 对 `collect` 失败的描述不精确

- 文件:行：`docs/adr/0238-ci-job-files-stay-on-the-ci-vps.md:92`、`scripts/ci/run-share.mjs:124-136`
- 问题：ADR 说“取构建或收报告时以 `CI_SHARE_MISSING` 失败”。实际上 `collect` 不会因缺失失败，它把缺失带在返回值里继续，`required.mjs` 之后才判失败；只有 `get`（browser/coverage 取构建）才会直接以 `CI_SHARE_MISSING` 失败。
- 读代码证实：`collect` 捕获后 `missing.push`，最后 `return { collected, missing }`（`run-share.mjs:124-136`）；ADR 第 60 行其实写对了“缺失由 required.mjs 判为失败”，第 92 行又写成 collect 失败，前后不一致。
- 建议：把第 92 行改成“取构建时以 `CI_SHARE_MISSING` 失败；收报告时 `collect` 列出缺失，由 `required.mjs` 判为失败”。

---

## 第 1 轮意见与 ds-1 / ds-4 核对

### 第 1 轮具体意见是否修好

- `get` 复制或重算摘要出错时删掉目标：已修好。`run-share.mjs:100-107` 的 try/catch 覆盖 `cpSync` 和 `treeDigest`，失败时 `rmSync(to)` 再抛出。读代码证实。
- `collect` 对缺失写标准错误：已实现（`run-share.mjs:163-164`），但没有自动测试（见发现 4）。
- 安装脚本拒绝接管已存在目录：已实现（`install-runner.sh:90-94`），但只覆盖“组不存在”（见发现 3）。
- policy 真实 SHA 反向用例：已实现。`test/tooling/policy.test.mjs:594-602` 用 `ci/toolchain-lock.json` 里 `actions/download-artifact` 的真实 SHA，给 `browser`、`required` 各加一个下载步骤，要求报出新的禁令消息；旧代码没有这条通用禁令，所以反向用例确实会失败。
- 文档：ADR 0238、排错表、I-93 都已改动；I-93 的描述与 `main-workflow.mjs` 的实现一致。但发现 1、5、6 仍显示文档与代码有出入。

### ds-1：矩阵输出合并——判断基本站得住

- 读代码证实：`browser` 的每个矩阵成员的 `share` 步骤只写自己的键：`--output-key "$CI_MATRIX"`（`.github/workflows/ci.yml:242`），作业输出映射是固定键 `chromium/firefox/webkit`（`ci.yml:182-185`）。`check-policy` 还要求 `job.outputs` 的键集合正好等于 activeMembers（`check-policy.mjs:524-533`）。
- 未核实：ADR 引用的 GitHub 原话“空值不会覆盖另一个矩阵成员写的值”（`docs/adr/0238-ci-job-files-stay-on-the-ci-vps.md:40`）无法离线复核。若该语义为真，ds-1 不成立的理由成立；若为假，表现会是 `required` 缺少报告而失败，不会误放行。

### ds-4：运行目录权限非原子——判断基本站得住

- 读代码证实：生产路径在 `main()` 里把 umask 设为 `007`（`run-share.mjs:175`），共享根目录由安装脚本建成 `2770` 且带 setgid（`install-runner.sh:99`）。Linux 下父目录 setgid 会被子目录继承，`mkdirSync` 创建本轮目录时就会直接得到 `2770`，之后 `lstat` 看到 `mode === SHARED_MODE` 直接返回（`run-share.mjs:40-47`），所以正常配置下没有“先 0770 再 chmod”的竞态窗口。
- 仍有一个前提：如果根目录的 setgid 位丢了，`mkdir` 出来的子目录会先没有 setgid/正确组，另一 runner 可能在这个窗口或之后拿到 `CI_SHARE_DIRECTORY_MODE`/`EACCES`。第 2 轮新增的 EACCES 排错行正是处理这种配置损坏。可选的加固是把 `mkdirSync(directory, { recursive: true, mode: 0o2770 })` 显式传给内核，但这不是第 1 轮成立的问题。
- 因此 ds-4 判“不成立”作为阻塞项可以接受，但应把“根目录 setgid 丢失时仍有窗口”写进排错或注释。

---

## 侧重检查（错误路径、不可信输入、安全、资源、不可撤销操作、文档一致性）

- 输入校验：`run-share.mjs` 对 `name`、`digest`、`GITHUB_RUN_ID`、`GITHUB_RUN_ATTEMPT` 都有正则限制（`run-share.mjs:17-18,35-37,67-70,94`），路径穿越和非法进制名会被拒绝；`artifact-files.mjs:44-57` 拒绝不安全相对路径、符号链接、特殊文件。读代码证实。
- 符号链接：`put` 在复制前先 `treeDigest(from)`，源里有链接会拒绝；`get` 复制后 `treeDigest(to)` 再拒绝链接并删除目标。读代码证实。
- 缺失/篡改：`collect` 把摘要不符与缺失都归入 `missing`，不会区分；新增 stderr 让原因可见，但 `remove` 会删掉源现场（发现 1）。读代码证实。
- 安装拒绝接管：组不存在且目录存在时返回 71，`ERR` trap 进入 `restore_backup`，测试验证 rc=71、目录仍在、没有 `groupadd/groupdel`；回滚路径正确。读代码证实。组存在时仍会接管，见发现 3。
- 资源耗尽：共享目录没有单次大小上限，靠 16 GiB 启动前下限、`clean-old.sh` 每小时删 6 小时前目录、`required` 结束删除兜底；ADR 已接受。没有发现新的无界循环或内存放大；`collectArtifactFiles` 最多并发 16 个文件读取（`artifact-files.mjs:56`）。读代码证实。
- 不可撤销操作：`remove` 删整轮目录、`uninstall all` 删共享目录和组、`get` 失败删目标。前两者是有意设计，但发现 1、3 显示现场保留和接管安全仍有缺口。
- 文档与代码一致性：发现 1、5、6 是三处不一致；ADR 0201 标为 superseded，I-93 与 `main-workflow.mjs` 一致。`ci-vps-runner-runbook.md` 的 `contract_sha256` 已改为 `sha256:e5704...`，但离线无法重算，标为未核实。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

不会。改动只涉及 `.github/workflows`、`scripts/ci`、`scripts/operations`、`test/tooling`、`docs` 和复核记录，没有碰 `packages/`、`apps/`、提示词目录、工具定义、历史存储或出口遮盖。没有把任何每轮会变的值加到系统提示/工具定义，也没有改历史消息。发给模型的内容仍然只在末尾追加，每轮会变的值仍然在最后一条消息。依据 `[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)`：本次没有新增/修改任何组装模型请求的代码路径。读代码证实；复核记录文件本身不是产品模型请求的一部分。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

不会。没有修改遮盖、JSON 序列化、时间字段或集合顺序相关代码。`run-share.mjs` 的摘要是确定性的（文件列表排序后计算 SHA-256，`run-share.mjs:59-65`），但它只在 CI 作业之间传文件，不进入模型请求。读代码证实。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

有，且反向用例在旧代码上确实会失败：
- `get` 失败清理：`test/tooling/run-share.test.mjs:103-116`。旧代码没有 try/catch，符号链接导致 `treeDigest` 抛错后 `to` 仍在，`expect(existsSync(to)).toBe(false)` 会失败。读代码证实。
- 安装拒绝接管：`test/tooling/ci-runner-scripts.test.mjs:1263-1272`。旧代码会走 `groupadd`/`install -d` 并返回 0，`expect(state.rc).toBe("71")` 和“不能 groupadd”都会失败。读代码证实。
- policy 下载禁令：`test/tooling/policy.test.mjs:594-602`。旧 `validateWorkflow` 只对 `coverage` 检查下载，给 `browser`/`required` 加真实 SHA 的下载步骤会通过，所以新用例会失败。读代码证实。

缺口：
- `collect` 写 stderr 没有自动测试（全仓库没有 `CI_SHARE_COLLECT_MISSING` 的测试引用）；删掉 `run-share.mjs:163-164` 测试仍会通过。
- 矩阵输出合并和 GitHub 的“空值不覆盖”语义无法在本地自动验证，只能依赖 GitHub 行为；ADR 引用的原话离线未核实。
- ds-4 的并发窗口没有测试；正常配置下靠 setgid 继承，测试环境根目录不是 2770 setgid，所以测试也没有覆盖生产根目录的行为。

### 4. 每个产生或修改的值，使用它的地方都能接受吗？

逐个核对结果：
- `71`：产生于 `install-runner.sh:91-93`；使用它的只有新测试和 Runbook 安装步骤。安装脚本内部不冲突（已有 65/66/67/68/69/70）。但同一 Runbook 的 `prepare-vps.sh` 也用 71 表示另一件事（`runbook:127`），排错表没有 71（发现 5）。回滚正确：`trap 'status=$?; restore_backup ...; exit "$status"' ERR`（`install-runner.sh:54`），`return 71` 触发后测试确认目录仍在、没有创建组。
- `CI_SHARE_COLLECT_MISSING`：产生于 `run-share.mjs:163-164`；没有其他代码解析它，也没有测试。作为日志前缀可接受，但属于未验证的新值。
- 作业输出键 `linux-x64`、`default`、`chromium/firefox/webkit`：产生于 `ci.yml:35-36,80-81,173-185,259-260,310-311` 和 `run-share.mjs` 的 `--output-key`；使用于 `run-share.mjs:114-121` 的 `publishedMembers`、`check-policy.mjs:524-545`、`aggregate.mjs:201` 的 `linux-x64`。名称、大小写、jobb名拼接规则一致，读代码证实。
- `RUNNER_SHARE_ROOT=/srv/gh-runner-share`、`RUNNER_SHARE_GROUP=gh-ci-share`、`RUNNER_SHARE_KEEP_MINUTES=360`：产生于 `runners.sh:5-7`；使用于 `install-runner.sh`、`uninstall-runner.sh`、`clean-old.sh`、`gh-runner.service.in`、测试和 Runbook，值一致。读代码证实。
- `contract_sha256: sha256:e5704...`：产生于本次 Runbook 封存；使用它的文档治理校验不在仓库内可运行，未核实。
- ADR 0238 第 92 行的 `CI_SHARE_MISSING` 措辞：与 `collect` 的实际行为不完全一致（发现 6），属于文档值使用不当的低项。

---

## 对作者三个核对问题的直接回答

1. **是否真的修好第 1 轮意见，有没有引入新问题？**
   四处具体修改都成立。没有引入模型请求前缀问题。新问题主要是：事故现场删除与“保留现场”矛盾（中）、策略只禁下载不禁上传（中）、接管检查只覆盖组不存在（低）、`collect` stderr 无测试（低）、71 未进排错表（低）。

2. **ds-1、ds-4 判“不成立”的理由是否站得住？**
   ds-1 基本站得住，前提是 GitHub 的“空值不覆盖”语义如 ADR 引用所述；每个成员使用唯一输出键，若语义成立则合并正确，若语义不成立只会缺报告失败，不会误放行。ds-4 在正常的 2770 setgid 根目录 + umask 007 下站得住，子目录创建时已继承 2770，不存在实际竞态窗口；但 setgid 丢失时仍有窗口，应通过 EACCES 排错和可选的 `mkdir mode` 加固处理。

3. **71 是否冲突，回滚是否仍正确？**
   在本安装脚本内不冲突，71 未被占用；回滚路径正确，`return 71` 会被 `ERR` trap 捕获，`restore_backup` 把已备份文件放回、删掉本次创建的路径/组，然后以 71 退出，测试已验证目录不被删除且没有建组。唯一的问题是文档层面：`prepare-vps.sh` 的 71 有另一含义，且安装脚本 71 没有排错表行。
