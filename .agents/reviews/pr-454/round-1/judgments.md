# PR 454 第 1 轮逐条判断（DeepSeek）

复核的提交：`b2a560461`。修改在其后的提交里。

## 成立，“会出错”

1. **指纹没有把列表参数排序（模型：高；线程：中、高）**。成立。`deviceActionFingerprint` 只排了键，`attendees` 换个顺序指纹就不同，结果未知时会新建第二条并再发 `perform`。修改：指纹里的列表先排序（`packages/application/src/services/device-action-registry.ts`）。测试：`[reverse] listing the same attendees in another order while the result is unknown does not send the action again`，去掉修改后失败。
2. **重放查询排在目标解析之后（模型：中；线程：中、高）**。成立。目标从镜像消失后，同一次工具调用重放得到“参数无效”而不是原记录。修改：`request` 先用新增的 `readInvocation` 查同一次调用，有就直接返回（`device-action-service.ts`、`sqlite-device-action-operations.ts`）。测试：`replaying the same tool call returns the original record even after its target left the mirror`，去掉修改后失败。
3. **写库失败留下无主载荷（模型：中低；线程：按中、高处理）**。成立。修改：`insert`、`report` 抛错时删掉刚存的载荷。测试：`[reverse] an action that could not be recorded leaves no stored arguments behind`（设备已取消配对时直接调服务，断言库里没有 `device-action:` 开头的载荷），去掉修改后失败。
4. **`DEVICE_ACTION_TRANSITIONS` 没人用（模型：低；线程：低）**。成立：表和 SQL 各写各的，会让后来的人以为改表就能改转换。触发后不会给出错误结果。修改：删掉这张表和函数，转换只由 SQL 的 `WHERE state` 条件决定；每种转换已有集成测试覆盖。材料里的说法 3 相应作废。
6. **`availableActions` 不看设备策略（模型：低；线程：低）**。成立：会把策略关掉的动作列给模型，再试只会被拒，不会执行。修改：改用和 `describe` 相同的“允许清单”（`production-perception-tools.ts`）。测试：策略用例里加了断言，去掉修改后失败。同一条里“设备列表按 id 排序而不是名字”不成立：说法 9 说的是动作按名字排序，设备按 id 排序同样是确定的顺序，两次请求字节相同。

## 不成立

5. **终态动作没有清理、结果未知不过期、被拒不去重**。不按本 PR 的错误处理，依据：
   - 每条记录都对应模型的一次工具调用，没有放大：一次调用最多一行加一份参数载荷，和每次工具调用已经写的过程记录、决策记录同一个量级。
   - 被拒的动作不去重是有意的：每次被拒都要如实留一条记录和决策记录，主人能看到她试过几次。
   - 结果未知不自动结束是设计第 12 节的要求：不确定就一直标不确定，直到设备读回；自动改成成功或失败都是编造结果。
   - 保留期确实没有定。感知记录的保留期在第 3 批的设置里，设备动作该不该跟着走是产品决定，列给 Andy，不在本 PR 里自己定。
7. **策略变更不撤销已送达的动作**。不成立为本 PR 的错误：动作已经到了设备，服务器没有办法收回；设备执行前自己再查一遍策略是第 9B 批的任务，PR 描述“没做”一节已写明。服务器这边把排队中的作废（已有测试）。

## 模型标为“未核实”的几项，线程核对结果

- 提示词清单的摘要：`apps/agent-service/test/prompt-catalog.unit.test.ts` 通过。
- `blockedActions` 超过 500 个：到不了存储层，`changePolicy` 先要求每个名字都在登记表里且不重复，登记表现在 9 个；不合格返回 400（策略用例里有断言）。
- `report` 不先结算过期：有意如此。已送达的动作刚过期时设备的回报仍然接受，这样迟到的真实结果不会被“结果未知”抢掉。
- 导出里不带 `runId`、`toolCallId`、`fingerprint`：这些是内部编号，和其他导出文件的做法一致。
- `untrustedOriginAllowed`、`resultOrigin` 生产里没人读：前者已放进交给授权端口的 `DeviceActionIntent`，后者是统一登记表要的列，等统一出口接上后使用；现在非读取动作在生产里一律被拒，外来内容引出的动作另有第 5 批的入口检查拦着。
- 设计第 12 节里的 `mac.open`、`mac.app`：是第 10 批的动作，不在本批。
