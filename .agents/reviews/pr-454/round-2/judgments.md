# PR 454 第 2 轮逐条判断（DeepSeek）

复核的提交：`f0563fd15`（增量从 `b2a560461` 起）。修改在其后的提交里。

## 成立，“会出错”

1. **重放不再通知设备（模型：中；线程：中、高）**。成立，是第 1 轮修改带来的退步：提前返回绕过了原来的 `announce`。修改：重放命中排队或结果未知的记录时照样通知设备（`device-action-service.ts`）。测试：`replaying the same tool call while the result is unknown asks the device to read back again...`，去掉修改后失败。
2. **重放不核对设备和动作名（模型：中低；线程：低）**。成立但只在编号被复用时触发，运行时每次工具调用一个新编号；触发后只返回旧记录，不执行新动作。修改：设备或动作名对不上时按参数无效拒绝。测试：同一条用例的后半段。
3. **失败清理可能撞上“已提交但响应丢失”（模型：低，推测；线程：低）**。部分成立：载荷不会被误删，`device_actions.arguments_ref`、`result_ref` 都是 `REFERENCES payloads(ref) ON DELETE RESTRICT`（迁移 0097），记录在就删不掉；但删除的报错会盖掉原错误。修改：清理失败不再抛出，原错误照常上抛。
4. **`report` 失败清理没有测试（模型：低；线程：低）**。成立。补了 `[reverse] a report that could not be recorded leaves no stored result behind`：对同一个数据库再开一个把磁盘余量要求调到最大的存储，真实触发 `disk_headroom` 拒绝，断言没有留下结果载荷；临时去掉清理后这条失败。
5. **`actions/open` 没有上限（模型：低；线程：低）**。成立。修改：一次最多把一批（`actionClaimBatch`）已送达的动作转成结果未知并返回一批；剩下的到期后按“没收到回报”转成结果未知，之后的 `claim` 照常分批发读回。测试：`[reverse] a reinstalled device gets back at most one batch of delivered actions per call`，去掉修改后失败。

## 不成立

6. **旧记录不会重算指纹**。不成立：`device_actions` 表是本 PR 新建的，功能没有上线过，没有旧记录（迁移 `0097_device_actions.sql` 里是 `CREATE TABLE device_actions`，`origin/main` 上没有这张表）。

## 模型标为“需要确认”的两项

- `approvalId` 长度：由授权端口产生，现在的生产实现不产生；统一出口接入时由适配器保证，超长会被表的 CHECK 拒绝而不是写坏数据。
- `toolCallId` 超过 256：会被 CHECK 拒绝并上抛，不会建记录，参数载荷按第 1 轮的修改清掉。
