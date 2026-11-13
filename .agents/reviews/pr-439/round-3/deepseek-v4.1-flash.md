## 结论

本次改动（6e33…→7945b38，重点增量 a9aa…→7945b38）没有发现高、中严重度缺陷。确认的问题只有一处：把 `srt:0.0.0-other` 改成 `other-runtime` 后，反向用例仍会被拒，但不再验证“格式像 SRT、版本不同”的运行时身份，检查被削弱。

## 发现

### 1. 低：运行时身份反向用例被削弱，可能放过“只校验前缀/格式”的错误实现

- 文件: `test/integration/sandbox-capability-qualification-lifecycle.test.ts:312`
- 文件: `packages/platform-node/test/capability-deployment.unit.test.ts:525`

问题：两处把 `srt:0.0.0-other` 改成 `other-runtime`。这样确实不会再被 `check:srt-version` 判为 `SRT_VERSION_STALE`，两条用例也仍会因为“身份不等”被拒；但 `other-runtime` 根本不是 SRT 身份，无法再区分“拒绝了一个格式正确但版本/后缀不同的 SRT 身份”和“只要有 `srt:` 前缀/只要格式像版本就接受”。如果以后有人把比较错误地写成 `startsWith("srt:")` 或只校验 `srt:<任意版本>`，这两条用例仍会通过。

证据：

- 消费端只做严格相等：`packages/execution-contracts/src/sandbox-qualification-v1.ts:119`
  ```ts
  claims.runtimeIdentity === `srt:${sandbox.srtVersion}`
  ```
- 检查脚本只对 `srt:<数字版本>` 报 stale：`scripts/check-srt-version.mjs:56`
  ```js
  new RegExp(String.raw`\bsrt:${VERSION}`, "g"),
  ```
  因此 `other-runtime` 避开了检查，但也失去了“像 SRT 身份”的语义。

建议：改成仍以当前版本开头、但整体不相等，且源码里不出现数字版本字面量，例如：

```ts
runtimeIdentity: `srt:${SANDBOX_RUNTIME_VERSION}-other`
```

这样 `SRT_VERSION_STALE` 不会触发（源码中 `srt:` 后没有 `\d+\.\d+\.\d+`），同时能抓住“前缀校验”“版本校验但忽略后缀”等弱实现。两处都已经导入了 `SANDBOX_RUNTIME_VERSION`，改动很小。

## 读代码证实的

- 新增的两个函数通过 `packages/execution-contracts/src/index.ts` 的 `export *` 对外导出；`packages/platform-node/src/capabilities/capability-deployment.ts:18-19` 和 `packages/application/src/services/capability-lifecycle-service.ts:1-4` 都能按名导入，签名与传参结构匹配。
- 加载器和 lifecycle 使用的规则一致：两边都要求 `platform` 匹配、`runtimeIdentity === srt:<sandbox.srtVersion>`、`resourceCeilings === false`、`termination === (platform === "linux")`，并重新按 `sandboxRuntimeQualificationSchema` 解析证据；lifecycle 额外要求 `manifest.runtime.kind === "program"`。
- lifecycle 对 `sandbox === undefined` 和 `sandbox === null` 已区分：`capability-lifecycle-service.ts:771` 使用严格 `=== undefined`；`null` 会进入 `sandboxEnforcementClaimsMatchEvidence`，因 schema 解析失败返回 `false`。
- `other-runtime` 只出现在测试中，没有生产代码把它当作运行时身份产生；它不会与任何实际生成值意外相等。
- 新用例“只清空 `guarantees`”确实能单独证明 helper 重新解析证据：仅靠平台、身份、`resourceCeilings`、`termination` 和四项管控检查都无法拒绝 `guarantees: []`。
- `sandbox` 为 null 的用例把六项 enforcement 都设成 `true`，因此如果实现把 null 当作“无沙箱证据”，激活会成功，用例会失败；该用例能真正区分 `=== undefined` 和 `!sandbox`。
- MCP 用例把 manifest 改成合法的 MCP runtime（`source.type = "mcp"`、`serverIdentity`、`transport`、非空唯一 `mappedResources`），不会被 `validateCapabilityManifest` 提前拒绝；若去掉 `manifest.runtime.kind === "program"`，证据本身会通过，因此该用例能真正覆盖 program 条件。
- 文档 `docs/execution/plans/2026-09-28-tool-execution-audit-plan.md:504` 明确 Linux 要求 `enforcement.termination=true`、Mac 用 `best_effort` 且 `termination=false`，与 helper 一致；没有找到文档说 lifecycle 对沙箱证据必须“六项全真”。`packages/application/src/ports/capabilities.ts:152` 的“legacy enforcement booleans must remain truthful”也与改动一致。

## 推测/未核实

- 未运行测试：工具限制只允许 git 命令，无法执行 vitest，也无法亲自验证作者所说的红绿结果。上面的“用例会失败/通过”是从断言、夹具和分支条件推出来的。
- `.agents/reviews/...` 的记账文件在当前稀疏检出中不可读，git 也拒绝读取 records-path；因此“已用 `--accept-low` 记账”未核实。
- lifecycle 仍无法像加载器那样核对沙箱证据与宿主绑定。加载器在 `capability-deployment.ts:1158-1169` 校验 `hostId`、`profileRef`、`runtimeDigest`、`runnerDigest` 必须与 binding 一致；lifecycle 只拿 manifest 和 qualification，没有 binding 参数。如果将来把返回沙箱证据的 qualifier 接进 lifecycle，而该 qualifier 可能来自不可信来源，这层校验收不到。目前没有找到生产路径让 lifecycle 收到沙箱证据（现有 `NodeCapabilityRuntimeQualifier` 不返回 `sandbox`），所以未列为确认缺陷。
- `sandboxEnforcementClaimsMatchEvidence` 只把 `ContractValidationError` 转成 `false`，其他异常会继续抛出。对 JSON 快照输入不可达；对进程内 qualifier 属于“快速失败”而非绕过。未发现实际触发路径。

## 侧重检查

查过的路径与结论：

- **错误路径**：helper 对不合契约证据返回 `false`，lifecycle 得到 `NOT_AUTHORITATIVE / runtime qualification failed`；加载器在 helper 之前已经 schema 解析证据，非法证据仍抛原有 `ContractValidationError`。`null` 证据在 lifecycle 走 reparse 失败，不会落到 legacy 全真分支。
- **不合规范输入/不可信输入**：部署快照仍由既有加载器做 UTF-8、大小上限、所有者/权限、digest、未知字段和 schema 校验；新 helper 不增加新的文件 I/O 或外部入口。
- **安全**：沙箱证据路径要求 filesystem/network/processes/secrets 四项为真，`resourceCeilings` 必须为假（与 `observe_and_stop` 一致），并要求 termination 与平台一致；没有放宽到“任意 boolean 都真”。
- **资源耗尽**：新逻辑只对已经解析过的快照对象再解析一次；快照总大小由加载器上限约束，没有新增无界循环或外部请求。
- **不可逆操作**：改动使“诚实的沙箱资格”可以完成 activate/update/rollback，但仍需原有审批和 artifact 校验；测试覆盖了正激活、更新激活、回滚和更新被拒。
- **文档/规则一致性**：未触及 `.claude/rules/prompt-prefix.md` 相关代码路径；计划文档、端口注释与 helper 的平台/终止语义一致；`srt-version` 检查确实只认 `srt:<数字版本>`，新字面量绕过检查的原因与作者说明一致。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。改动的文件是能力部署/资格校验和测试（`sandbox-qualification-v1.ts`、`capability-deployment.ts`、`capability-lifecycle-service.ts`、两个测试文件），没有触碰系统提示、工具定义、历史消息、遮盖或任何模型请求序列化路径；也没有把 capability 资格数据写入请求。发给模型的内容没有变化。
2. **会不会让同一段文字在不同请求里变成不同字节？** 不会。helper 只返回 boolean，不产生或序列化发给模型的文本；测试快照使用固定的 `NOW` 和固定字面量，没有依赖当前时间、无序集合或前后文遮盖。`Object.values(enforcement)` 仅做 `every/some` 布尔判断，结果与遍历顺序无关。
3. **有没有对应的自动检查，反向用例是否真的会失败？** 有：加载器 4 条反向用例、lifecycle 13 条用例覆盖正激活、更新/回滚、四项管控缺失、虚假资源上限、终止矛盾、平台/身份不符、证据不合契约、null 证据、非 program manifest、无沙箱证据仍要求六项全真。按代码路径分析，这些用例分别隔离了对应条件，去掉对应检查会失败；唯一被削弱的是运行时身份用例——`other-runtime` 仍会被严格相等拒绝，但不再覆盖“前缀像 SRT、版本/后缀不同”的情况。未实际执行测试，故红绿结果未独立核实。
4. **每个产生/修改的值，其使用端都能接受吗？** 已核对：
   - 新导出函数由 contracts 包 index 导出，加载器和 application 都能导入并使用。
   - 两个调用端传入的 `platform`、`runtimeIdentity`、`enforcement` 结构与接口一致；loader 的 `runtimeIdentity` 在 helper 之后仍走原有 `text()` 校验，行为未变。
   - 沙箱证据的生产者（如 `scripts/delivery-mode/packet-template/signing/cloud-protected-prepare.mjs` 的 `srt:0.0.81`、测试夹具中的 `srt:${SANDBOX_RUNTIME_VERSION}`）与消费端的 `srt:${SANDBOX_RUNTIME_VERSION}` 一致，`check:srt-version` 守着版本漂移。
   - 错误码/错误文本沿用原有 `QUALIFICATION_INVALID`、`runtime qualification failed`，现有测试和调用方仍能接受。
   - `other-runtime` 只是测试输入，消费端按任意字符串比较并拒绝，不涉及生产兼容。
   - 遗留不对称：lifecycle 无法核对证据与宿主 binding，只有加载器有这层校验；当前生产路径未发现 lifecycle 收到沙箱证据，故未列为缺陷，但未来接线时需要补上或明确由 qualifier 保证。
