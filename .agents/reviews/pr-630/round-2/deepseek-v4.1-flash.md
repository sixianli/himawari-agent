这一轮查过的范围：`scripts/run-all-checks.mjs`、`test/tooling/run-all-checks.test.mjs`、`scripts/delivery-mode/test_deploy.py` 的新用例、`scripts/delivery-mode/sandbox-command-links.py`、`scripts/delivery-mode/deploy-preflight.py`、`packet-template/signing/cloud-seal.mjs`、ADR 0265、`package.json` 的 `check:steps`；并用 grep 全仓查了这些导出值、输出标签、行号引用和 `runStep` 的所有调用端。没有重读增量没碰、行为也没被增量改变的旧代码。

### 1 中 多步骤同时失败时重印总量仍会超过 120 行窗口，排在前面的失败照样被挤出
文件: scripts/run-all-checks.mjs:36

问题：`share` 的下限是 5，且没有把每个失败块的 `CHECK_FAILED_OUTPUT` 标题行计入预算。失败步骤一多，总行数 = `n × (5 + 1)`，超过上一轮提到的 120 行窗口。例如 21 个步骤同时失败时是 `21 × (5 + 1) = 126` 行；`check:steps` 现在有约 60 步，共享错误（缺依赖、配置整体失效）时完全可能一起失败，最前面的失败会再次落到窗口之外。

证据（读代码证实）：
```
const share = Math.max(5, Math.floor(FAILED_OUTPUT_BUDGET / failures.length));
for (const { name, output } of failures) {
  const tail = lastLines(output, share);
  if (tail.length === 0) continue;
  log(`CHECK_FAILED_OUTPUT ${name} last ${tail.length} lines`);
```
反向用例只覆盖了 4 个失败（test/tooling/run-all-checks.test.mjs:65-84，断言 `repeated.length <= FAILED_OUTPUT_BUDGET + 4`），所以抓不到 21 个以上的情况。

建议：按“总预算 = 每步标题 + 每步输出行”统一分配，例如 `share = Math.max(1, Math.floor((FAILED_OUTPUT_BUDGET - failures.length) / failures.length))`，并对失败数超过预算的情况只打印失败清单或不重印；补一条 25 个失败步骤、断言总重印行数不超过窗口的测试。

### 2 低-中 去掉 `maxBuffer` 后，单行超长输出仍无界，`tail` 按行保留会导致内存放大和 O(n²) 拼接
文件: scripts/run-all-checks.mjs:56-57

问题：改成流式后不再有 256MB `maxBuffer` 兜底，但 `tail` 只按“行数”截断、不按字节截断。若某个步骤输出一条没有换行符的超长行（压缩 JSON、base64、进度条覆盖写等），`lastLines(tail + text, ...)` 每次 chunk 都会把不断变长的整行复制一遍，内存和 CPU 都随该行长度无界增长，最坏是 O(n²)。这正好落在本轮关注的“资源耗尽”上。

证据（读代码证实）：
```
let tail = "";
const keep = (chunk) => {
  const text = chunk.toString("utf8");
  write(text);
  tail =
    lastLines(tail + text, STEP_TAIL_LINES + 1).join("\n") + (text.endsWith("\n") ? "\n" : "");
};
```
推测：是否会真的触发取决于各检查脚本输出形态，未在生产/CI 日志里核实是否存在超长单行。

建议：再给 `tail` 一个字节上限（如 256KB），超出时截断并加标记；对单行也做长度上限；补一条“输出一条超长无换行内容”的测试，断言内存保留有界。

### 3 低 “streams ... as they arrive” 的测试无法证伪“收集到结束再一次性打印”
文件: test/tooling/run-all-checks.test.mjs:96-113

问题：测试只断言 `written.join("")` 最终包含首行和末行，这只能证明这些内容最终被写出，不能证明是边到边写。即使把 `runStep` 改成“在 close 时才 `write` 全部输出”，第 107、108 行依然通过，上一轮第 1 条（挂起/超时期间没有输出）的回归仍可能不被发现。

证据（读代码证实）：
```
expect(written.join("")).toContain("out 1\n");
expect(written.join("")).toContain("err last");
```
建议：让子进程先写一行后阻塞/延时，断言在 `runStep` 的 Promise resolve 之前 `write` 已经收到那一行（例如用可控制退出的子进程，或记录每块写入时刻与进程结束的先后）。

### 4 低 `main` 用 `process.exit` 立即退出，最后一次重印可能被截断
文件: scripts/run-all-checks.mjs:75-77

问题：`console.log` 在 stdout 是管道时是异步写，`process.exit` 会在缓冲排空前强制退出；末尾那段“重印失败步骤”正是本改动的目的，最可能在退出时丢掉。

证据（读代码证实）：
```
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
```
推测：重印通常不足 100 行，多半能塞进管道缓冲，实际触发概率低；而且这段在上一轮（dac5c99）已经是 `process.exit(main())`，不是本轮新引入，只是本轮改到了这一行。

建议：改成 `process.exitCode = await main();`，让事件循环自然把 stdout 排空，或显式等待写回调。

**侧重检查**
- 错误路径（读代码证实）：子进程无法启动时走 `child.on("error")` 并返回 `{ status: 1, output: 含 ENOENT }`，有真实子进程测试（test:115-121）；被信号杀死时 `code` 为 null → `status: 1`（run-all-checks.mjs:63）。spawn 参数非法（例如 cwd 不存在之外的同步 TypeError）会让 Promise reject、最终顶层 await 失败，没有友好报错，但 `main` 只传固定的 npm/cwd，风险低。
- 不合规/不可信输入（读代码证实）：步骤名只来自 `package.json` 的 `check:steps`，`stepNames` 用 `^npm run (\S+)$` 拒绝其他形态（run-all-checks.mjs:9-15），且 `spawn` 不经 shell，无新增命令注入面。新测试只操作 `tempfile.TemporaryDirectory()`，不碰系统 `/usr/bin`。
- 资源耗尽：见第 2 条；另 `write` 未处理 `process.stdout` 的背压，消费者很慢时缓冲在 Node 内部增长，属推测、未核实。
- 不可撤销操作（读代码证实）：本增量只跑检查脚本和临时目录测试，没有删除/覆盖/远端操作。
- 规则与文档一致（读代码证实）：ADR 0265 已从 `scripts/run-all-checks.mjs:31` 改成 `stepNames`（docs/adr/0265...:160），代码里 `stepNames` 仍在 line 9；全仓 grep 未再发现 `last 80`、`FAILED_OUTPUT_LINES` 或 `run-all-checks.mjs:` 这类残留引用；输出标签已改为实际行数（run-all-checks.mjs:40）。
- 交付测试覆盖（读代码证实 + 推测）：新用例 `test_deploy.py:147-171` 在临时目录按 Ubuntu alternatives 形状自建树，并用真实 `packet-template` 的 `readOnlyToolchainPaths` 核对，`unreachable_commands` 只返回 basename 且按排序输出，`['go','x-www-browser']` 与该树一致。它不再验证真实主机；真实主机仍由上线前 `SANDBOX_COMMAND_LINKS_REACHABLE`（deploy-preflight.py:201）在生产机上 fail-closed 检查。附带风险（推测，未核实）：这个测试是“按预期结果搭树”，不能提前发现目标生产机的链接集合与模板根不匹配，只能等部署预检拦下；这是作者声明的设计取舍，不算会出错，但 CI 侧对真实主机的覆盖确实变弱了。

**上一轮 5 条逐条核对**
1. 已改好：`runStep` 现在边收边 `write`（run-all-checks.mjs:53-57），主路径 line 72 确实调用它；但实时性测试偏弱，见第 3 条。
2. 只改好了一部分：4 个失败时能进窗口且有测试（test:65-84），失败步骤超过 20 时仍溢出（第 1 条），没有对应反向用例。
3. 已改好：`runStep` 已导出（line 46），并用 `process.execPath` 真实子进程测成功/失败/ENOENT（test:96-121）。
4. 基本改好：`maxBuffer` 与整段缓冲都去掉了（run-all-checks.mjs:59），内存不再随总输出增长；但单行超长仍无界（第 2 条）。
5. 已改好：标签用实际 `tail.length`，ADR 改成引用 `stepNames`，全仓无残留旧行号/旧标签。

**必答问题**
1. 不涉及：本增量只改 CI 检查脚本、交付测试和 ADR，不产生或修改任何发给模型的内容（系统提示、工具定义、历史消息、遮盖结果均未触碰）。
2. 不涉及：没有引入依赖前后文的遮盖、时间字段或无序集合；唯一会变化的输出是运行日志，不进模型请求。
3. 部分有。第 1、3、4 条有直接测试，反向用例大多成立：把第 2 轮均分改回“每步全印”会让 test:65-84 的长度断言失败；把 `runStep` 换掉会让 test:96-121 失败。但缺口有两个：>20 个失败时第 1 条没有反向用例；`streams as they arrive` 的反向用例（退化为结束后一次性写）不会失败（第 3 条）。另外，`main → runStep` 的接线没有直接测试，只测了 `runStep` 本身和 `manifest.scripts.check`。
4. 逐个核对（读代码证实）：`FAILED_OUTPUT_BUDGET`/`STEP_TAIL_LINES`/`lastLines`/`runStep` 只被本脚本和本测试使用，参数形状两端一致（main 传 `(npm, ["run", name], { cwd })`，测试同形状）；`CHECK_FAILED_OUTPUT ... last N lines` 只供人/CI 日志阅读，全仓没有解析它的地方，只要预算不超窗口即可；`unreachable_commands` 返回的是排序后的 basename，新测试传 `(roots, directory)`、远端脚本传默认 `/usr/bin`，两端都能接受；ADR 里引用的 `stepNames` 确实存在。唯一“使用端会不接受”的是日志窗口本身——第 1 条的超预算会让查看日志的人看不到最早的失败。
