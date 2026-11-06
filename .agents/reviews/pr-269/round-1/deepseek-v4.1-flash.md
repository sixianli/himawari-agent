## 结论概览

两处修法都针对根因：走查预检用例原来依赖“本机主机名恰好与 `builder.json` 不同”这个环境事实，现在显式制造不匹配；第十二版对比用例失败是因为 PR 265 有意改了模板 `measurement/probe/bootstrap.mjs`，测试的“有意改动”清单没有跟上，按 ADR 0086 的既有做法补清单是对的。改动不会触及发给模型的内容。

但接入本身有两个缺口：`run-all-checks.test.mjs` 的接线断言只在 CI 的 policy 任务里执行，不在本地 `npm run check` 里；另外还有 4 个 delivery-mode 的 Python 测试文件同样没有接入任何自动检查。

---

## 问题清单（按严重度）

### 1. 中：其余 delivery-mode Python 测试仍未接入任何自动检查

**文件:行**：`package.json:40`、`scripts/delivery-mode/test_deploy.py`、`test_rollback.py`、`test_release_cleanup.py`、`test_untested_claims.py`

**问题**：这次只把 `test_make_packet.py` 接进了 `npm run check`。同样位于 `scripts/delivery-mode/` 的 4 个 Python 测试文件仍然只能手工运行。它们覆盖的是部署、回滚、清理和“未测试声明”门槛，其中回滚和清理涉及不可撤销的生产操作，正是本次复核侧重关注的部分。

**证据**：

- `package.json:40` 只新增了这一条 Python 检查：
  ```json
  "check:delivery-packet": "python3 -I scripts/delivery-mode/test_make_packet.py",
  ```
- 工作区实际存在：
  ```
  scripts/delivery-mode/test_make_packet.py
  scripts/delivery-mode/test_deploy.py
  scripts/delivery-mode/test_release_cleanup.py
  scripts/delivery-mode/test_rollback.py
  scripts/delivery-mode/test_untested_claims.py
  ```
- 在 `package.json` 的 scripts、`ci/policy.json`、`scripts/ci/run.mjs` 和 `.github/workflows/ci.yml` 中，只有 `test_make_packet.py` 有入口；其余 4 个没有任何自动入口。
- 例如 `test_deploy.py:146-149` 还有一个依赖本机 `/usr/bin` 链接的用例，直接接入前需要确认它在 Hermes 和 CI 上稳定：
  ```python
  def test_real_seal_template_roots_let_every_command_link_resolve_on_this_host(self):
      roots = preflight.sandbox_read_roots(HERE / 'packet-template')
      ...
      self.assertEqual(sandbox_links.unreachable_commands(roots), [])
  ```

**建议**：把这 4 个文件逐一评估后接入（可以合并成一个显式列表的检查步骤），至少先登记为待办并说明为什么暂不能接入。不要只接一个文件就认为“这一类的门槛已经自动运行”。

---

### 2. 低-中：接线断言只由 CI 执行，不在本地 `npm run check` 门槛内

**文件:行**：`test/tooling/run-all-checks.test.mjs:54`、`package.json:27`、`package.json:77`

**问题**：新增的 `expect(names).toContain("check:delivery-packet")` 用来防止有人把这一步从 `check:steps` 里删掉。但这个测试文件属于 vitest 的 `tooling` 项目，本地 `npm run check` 并不执行 `tooling` 项目；它由 CI 的 `policy` 任务执行。快速模式明确规定 CI 结果只供参考，所以“删掉这一步”在本地必过门槛上不会被发现。

**证据**：

- 接线断言在 `test/tooling/run-all-checks.test.mjs:52-54`：
  ```js
  const names = stepNames(manifest.scripts["check:steps"]);
  expect(names).toContain("check:boundaries");
  expect(names).toContain("check:delivery-packet");
  ```
- `package.json:27` 的 `check:steps` 里没有任何 `vitest ... test/tooling/run-all-checks.test.mjs`；`package.json:77` 的 `check:ci-policy` 只是：
  ```json
  "check:ci-policy": "node scripts/ci/check-policy.mjs",
  ```
  我读过 `scripts/ci/check-policy.mjs` 的 `main()`，它做策略、工具链、测试清单校验，不执行 vitest 测试。
- CI 的 `policy` 任务确实会跑 `tooling` 项目：`ci/policy.json:19` 是 `"projects": ["tooling"]`，`scripts/ci/run.mjs:235-242` 在该分支里执行 `await vitest(check.projects)`。
- 但 `.agents/instructions/delivery-mode.md:27` 写明快速模式下“合并进 `main` 不等待 `ci/required`……结果只供参考”。

**建议**：把接线断言放进本地 `npm run check` 会执行的一步，例如让 `check:ci-policy` 或专门的检查脚本读取 `package.json` 并断言 `check:delivery-packet` 在 `check:steps` 中；或者把 `test/tooling/run-all-checks.test.mjs` 加入某个本地检查步骤。需要说明的是，“弄坏一个用例时这一步会失败”本身已经由 `unittest.main()` 的非零退出码保证，见问题 3 的回答。

---

### 3. 低：把 `bootstrap.mjs` 加进 `INTENDED_CHANGES` 后，该文件从此不再被这项回归测试比对

**文件:行**：`scripts/delivery-mode/test_make_packet.py:326-327`

**问题**：这次修法符合既有设计（ADR 0086 明确说改模板时要同步改 `INTENDED_CHANGES`），但它意味着 `measurement/probe/bootstrap.mjs` 以后无论怎么改，都不会再让这个“与第十二版冻结包逐字节对比”的测试失败。某个文件一旦进入这个清单，就是永久豁免。

**证据**：

```python
self.assertEqual(set(rendered), set(TWELFTH_FROZEN) | ADDED_FILES)
self.assertEqual({name for name in rendered if name not in ADDED_FILES and rendered[name] != TWELFTH_FROZEN[name]}, INTENDED_CHANGES)
```

`bootstrap.mjs` 出现在 `INTENDED_CHANGES`（第 32 行），因此不会再参与第二行的差异检查。

缓解因素：`packet-template/inputs/check-packet-consistency.py:97-116` 会单独读取 `bootstrap.mjs` 里的三个沙箱文件摘要，并与构建产物比对，报 `PROBE_DIGEST_STALE`。所以这次改动最关键的内容仍有另一道门槛；失去的是对 `bootstrap.mjs` 其他改动的回归比对。

**建议**：后续可把 `INTENDED_CHANGES` 从“文件名集合”改成“文件名 → 当时预期摘要”的映射，这样只接受已知的那次变化，之后再有改动仍会失败；或者另建一份固定摘要。至少应把这个盲区记录下来。

---

### 4. 低：新用例仍不必要地依赖外部 `hostname` 命令

**文件:行**：`scripts/delivery-mode/test_make_packet.py:583`

**问题**：测试只需要制造一个必然不同的主机名，却调用了外部 `hostname` 命令。该命令不存在时会抛异常（不是干净的断言失败），也增加了一个与测试目标无关的环境依赖。

**证据**：

```python
settings['hostname'] = subprocess.run(['hostname'], capture_output=True, text=True, check=True).stdout.strip() + '-elsewhere'
```

**建议**：直接基于现有值制造不匹配即可，例如 `settings['hostname'] = settings['hostname'] + '-elsewhere'`。被测脚本本来就用 `$(hostname)` 与配置值比较（`scripts/delivery-mode/hermes/run-release-walkthrough.sh:11`），只要两者基准值相同，追加后缀就一定能触发 `HOST_UNEXPECTED`。

---

### 5. 低：已有 Backlog 记录了这个根因，但本次修改没有更新它

**文件:行**：`docs/backlog/BL-20261027-007-make-packet-template-test-follows-image-config.md:13,22`

**问题**：该 Backlog 的 `result` 写着走查预检用例“在 Hermes 本机必然失败，因为它靠主机名不对来触发”，正是本次修掉的问题；本次改动没有更新这条记录的 `result`/`Notes`。这不会影响构建，但文档与代码的一致性会停留在旧状态。

**证据**：

- 第 13 行：
  ```text
  result: "加进 INTENDED_CHANGES：……1 项（走查预检）在 Hermes 本机必然失败，因为它靠主机名不对来触发"
  ```
- 第 22 行也重复描述了这个根因。

**建议**：如果项目要求 Backlog 跟随修复更新，补一行说明“已在 60dbe0cc 用显式主机名不匹配修好，并接入 `npm run check`”。快速模式下文档校验较轻，这属于可选改进。

---

## 读代码证实的部分

- 两处修法的位置和内容与 diff 一致（`git diff` 已核对）。
- `a3ebc700` 只改了 `scripts/delivery-mode/packet-template/measurement/probe/bootstrap.mjs` 的三行摘要；`git show a3ebc700 --stat` 显示只改了这一个文件。
- `run-release-walkthrough.sh:9-11` 先读 `builder.json` 的 `hostname`，与 `$(hostname)` 比较，不等则以 `HOST_UNEXPECTED` 退出 66。
- `Hermes.preflight()` 在子进程非零退出时抛出 `PACKET_HERMES_PREFLIGHT_FAILED`（`make-packet.py:574-577`），新断言的正则能匹配到脚本输出的 `HOST_UNEXPECTED`。
- `IntentendedChanges` 只在该测试的第 326-327 行使用，没有其他代码消费。
- `run-all-checks.mjs:14-27` 会继续运行后续步骤并汇总失败；`test_make_packet.py:1137-1138` 使用 `unittest.main()`，测试失败时进程退出码非零，因此 `npm run check:delivery-packet` 会失败。
- CI 的 `static` 任务确实执行 `npm run check`（`scripts/ci/run.mjs:243-244`），并且 CI 的隔离 PATH 里包含锁定的 `python3`（`install-tools.mjs:312-320, 505-517`），所以 `python3 -I` 在 CI 上会使用 `.ci-output/tools/bin/python3`。
- 加载模块的方式是 `importlib.util.spec_from_file_location`（`test_make_packet.py:39-47`），且 `make-packet.py`、`run-packet-checks.py` 顶层只导入标准库，所以 `-I` 不会破坏同目录模块加载。

## 推测 / 未核实

- 作者给出的“76 个用例全过”“`npm run check` 34 步 `CHECK_ALL_PASSED`”“把第十二版用例改坏后退出码 1”没有亲自运行验证（工具限制：不能运行除指定 git 命令外的命令）。从代码结构看退出码传播成立。
- 没有独立计算 `bootstrap.mjs` 的 SHA-256，因此没有亲自核对新摘要值本身；但 diff 和 `git show` 足以确认“文件确实改了，所以第十二版对比会报差异”。
- CI 上实际耗时是否仍能落在 60 分钟静态任务预算内未测量；从代码看新增步骤大概率只是数十秒到数分钟级别。
- `python3 -I` 在 Hermes 本地用的是 PATH 里的系统 `python3`，不是 CI 锁定的 `.ci-output/tools/bin/python3`；不过仓库的 commit hook 本来就依赖 `python3`（`scripts/git-hooks/commit-msg:4`），且该测试文件没有使用 3.10 以上的语法，风险较低。

---

## 侧重检查

- **错误路径**：检查了 `preflight` 失败路径、`PacketError` 包装、`HOST_UNEXPECTED` 匹配、`unittest.main()` 的退出码和 `runAllChecks` 的失败汇总。新用例现在能稳定进入失败分支，且失败原因限定为 `HOST_UNEXPECTED`。
- **不合规范 / 不可信输入**：`builder.json` 被重新 `json.dumps` 后写回，内容来自受控测试夹具；`hostname` 只用于相等比较，不进入 shell 拼接。未发现注入路径。
- **安全**：新测试没有新增网络访问、生产凭据或敏感日志；文件顶层无 socket/urllib/http 导入。`Hermes` 相关测试都通过 `HIMAWARI_HERMES_SSH`/`HIMAWARI_HERMES_UPLOAD` 假包装器运行，不会连真实 Hermes 或生产机。
- **资源耗尽**：审计了全量运行这个文件的副作用：临时目录由 `TemporaryDirectory`/`tempfile` 管理，`run-packet-checks.py` 的 `/tmp/h*` 暂存目录在 `finally` 中清理（`run-packet-checks.py:111-113, 146-153`），`hermes_cleanup_command` 只作用于测试临时 work 路径（`make-packet.py:662-664`）。未发现会写入仓库或生产路径的测试。运行时间未实测。
- **不可撤销操作**：`HermesCleanupTest` 的 `rm -rf` 只针对 `tempfile.TemporaryDirectory()` 下的路径；`git init`/`git commit` 都在临时仓库中。未发现会在真实仓库或生产机上执行破坏性操作的用例。
- **规则 / 文档一致性**：
  - `scripts/ci/run.mjs:243-244` 说明 CI 的 static 任务会跑 `npm run check`，所以新步骤在 CI 上会执行；但 `.agents/instructions/delivery-mode.md:27` 说明快速模式下 CI 只是参考，这与“接线断言只在 CI 生效”的缺口一致。
  - ADR 0086 明确要求改模板时同步改 `INTENDED_CHANGES`，本次补 `bootstrap.mjs` 与这条规则一致。
  - `.claude/rules/prompt-prefix.md` 不适用于本次改动：diff 没有触及提示词、工具定义、历史或遮盖逻辑。
  - `docs/backlog/BL-20261027-007` 已记录相同根因但未更新，属于低优先级文档同步问题。

---

## 必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**不会。** 改动只涉及 `package.json`、`scripts/delivery-mode/test_make_packet.py` 和 `test/tooling/run-all-checks.test.mjs`，没有修改系统提示、工具定义、历史消息、资料块或遮盖逻辑。发给模型的内容仍然只在末尾追加、每轮变化值仍在最后一条消息这一性质不受影响。新加入 `INTENDED_CHANGES` 的 `measurement/probe/bootstrap.mjs` 是上线包模板文件，不是模型请求内容；该集合只在测试内做集合比较，不会序列化给模型。

### 2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？

**不会。** 没有请求序列化代码被修改。唯一看起来“无序”的是 `INTENDED_CHANGES` 这个 Python `set`，但它只在 `test_make_packet.py:326-327` 做集合比较，顺序不影响结果，也不会进入模型请求。`builder.json` 的改写只发生在测试临时目录，不涉及请求内容。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

**有。** `check:delivery-packet` 已加入 `check:steps`，`run-all-checks.test.mjs` 也断言它存在。

- 反向传播成立：`test_make_packet.py:1137-1138` 调用 `unittest.main()`，用例失败时 Python 退出码非零；`run-all-checks.mjs:14-27` 会把该步骤记为失败并最终返回 1。作者手工改坏用例后 `check:delivery-packet` 退出 1，与代码行为一致（我未能亲自运行）。
- 走查预检用例的反向是有效的：如果 `run-release-walkthrough.sh:11` 的主机名检查被删掉，测试不会再收到 `HOST_UNEXPECTED`，断言会失败。
- 第十二版对比用例的反向有削弱：`bootstrap.mjs` 进入 `INTENDED_CHANGES` 后，未来对它的改动不会再让这个测试失败；不过 `check-packet-consistency.py` 仍单独校验它嵌入的三个沙箱摘要。
- 没有一条常驻的自动化“元测试”会主动破坏某个用例并断言整个步骤失败；目前只依赖 `unittest` 的退出码和作者的手工验证。接线断言本身只在 CI 的 `policy` 任务执行，不在本地必过门槛里（见问题清单第 2 条）。

### 4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？

逐个核对结果如下：

- **`check:delivery-packet`**：
  - 产生处：`package.json:40`。
  - 使用处：`package.json:27` 的 `check:steps`；`scripts/run-all-checks.mjs:6-11` 的 `stepNames` 正则 `^npm run (\S+)$`（冒号可接受）；`test/tooling/run-all-checks.test.mjs:54` 的断言；CI `static` 任务通过 `scripts/ci/run.mjs:243-244` 执行 `npm run check`。
  - 两端校验一致，没有发现拒绝该名字的地方。

- **`measurement/probe/bootstrap.mjs`**：
  - 产生处：`test_make_packet.py:32` 的 `INTENDED_CHANGES`。
  - 使用处：同文件第 326-327 行；渲染结果的 key 由 `path.relative_to(packet).as_posix()` 生成（第 325 行），与清单里的 POSIX 路径格式一致。
  - 两端匹配；但如问题 3 所述，它成为永久豁免项。

- **测试改写的 `builder.json` 的 `hostname`**：
  - 产生处：`test_make_packet.py:583`，值为“本机 `hostname` + `-elsewhere`”。
  - 使用处：`scripts/delivery-mode/hermes/run-release-walkthrough.sh:9-11` 通过 `/usr/bin/python3 -I -c 'import json, sys; print(json.load(...)[...])'` 读取并与 `$(hostname)` 比较；该脚本接受任意 JSON 字符串，不匹配时按预期报 `HOST_UNEXPECTED`。
  - 同一份 `builder.json` 也被 `build-candidate.sh:12,17` 读取，但本测试不调用该脚本，所以没有额外影响。
  - 没有发现两端格式或校验不一致。
