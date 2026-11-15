# PR 556 第 1 轮：设备动作的推送唤醒

## 问题和目标

设备动作排上队而这台设备没连着时（`DeviceActionService.#dispatch` 里 `delivery.connected` 为假），要发一条苹果推送请主人点开，App 打开后领动作；过期没送到记 `expired`（原有逻辑）。详细设计第 12 节第 2 步：“连接不在时发一条苹果推送请主人点开”。

## 约束

- 推送层不按动作种类分支（送达轻重由条目自己带）；锁屏只放标题一级的通用内容，不放明细（ADR 0089 第 5 条）。
- 不新增表，不改迁移；不涉及模型调用和发给模型的内容。

## 作者的说法（请核对，不要直接采信）

1. `production-apple-push.ts` 新增 `ProductionApplePush.requestOpen({record})`：列出该设备的 `alert` 推送令牌，只保留 `status === "active"` 且主题和环境在配置里的；每个令牌发一条优先级 10 的 alert，过期时间取记录的 `expiresAt`，`collapseId` 为 `device-action-<动作号>`；发完按结果更新令牌状态（失效的停用）。整个方法吞错并交给 `onFailure`，不抛出。
2. 负载由新增的纯函数 `applePushOpenRequestPayload` 生成：标题和正文是三语固定文字，不含任何动作明细；`interruption-level` 由记录的 `ownerPresence` 决定（真为 time-sensitive，否则 active）；`himawari` 里带 `kind: "device_action"` 和动作编号，`navigate` 为 `/`，没有按钮。
3. `service-main.ts` 把 `requestOpen` 接到 `createProductionDeviceActions` 的 `openRequests`（用 `applePush?.`，苹果推送没配置时什么都不做）。
4. 不走网页推送的发件箱，不记投递记录；失败不重试（动作会过期）。

## 不必评的

设备端 App 收到推送后怎么处理（9B 的客户端）；PR 543、548 已审过并判过的各条。
