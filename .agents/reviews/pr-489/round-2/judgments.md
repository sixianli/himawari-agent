# PR 489 第 2 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，会出错，中高：### 1 中高 `requestId` 可能以 `-` 或 `_` 开头，被后端 `MACHINE_STRING` 拒绝，设备动作会间歇性 400。已核对 device-api-routes.ts:152、Hashing.swift:27-30；已修：新增 HomeRequestId.make() 加 home- 前缀，iPhone 和 Mac 菜单栏都改用，并有 2000 次生成的字符集测试；触发：requestId 用 base64url，首字符约 3% 是 - 或 _；后果：后端 MACHINE_STRING 返回 400，动作间歇性没做成
- 2（deepseek-v4.1-flash）成立，会出错，中高：### 2 中 `binding == nil` 的动作仍被显示成按钮，但 `/home/act` 必定 400。已核对 production-home.ts:151,327；已修：非审批条目里没有 binding 的动作不进 choice，页面按无按钮的行显示；审批条目仍走审批接口；有反向测试；触发：服务器给 binding 为 null 的动作（如 connection 的 reconnect）；后果：按钮显示但点了必然 400，永远做不成
- 3（deepseek-v4.1-flash）成立，会出错，低：### 3 中 审批动作失败仍然没有任何用户提示，作者“动作失败有提示”不成立。条目不会被错误隐藏，只缺提示；已修：审批仍待处理且 approvals.problem 有值时显示“没做成，请再试一次”；触发：审批响应失败而条目仍待审批；后果：今天页没有任何提示（条目仍在，状态没错）；判低理由：失败时条目仍留在页面上、与服务器一致，只缺提示，是否发出由审批接口负责
- 4（deepseek-v4.1-flash）成立，会出错，中高：### 4 中 任意来源不完整都会显示设备动作卡并回退角标，会导致审批重复和角标少算。已核对 TodayPage 原 116 行、RootView 角标；已修：只在 incompleteSources 含 approvals 时显示设备动作卡并回退角标；触发：incompleteSources 只含 upcoming 等其他来源时；后果：设备动作卡与首页审批条目重复显示，角标退回设备审批数而少算
- 5（deepseek-v4.1-flash）成立，可以更好：### 5 低 `DeviceHomeSource` 丢弃服务端动作结果，真机上没有成功提示和撤销入口。撤销要等服务器的撤销接口（PR 548 已合），接到真机路径作为 489 合并后的单独 PR
- 6（deepseek-v4.1-flash）成立，会出错，低：### 6 低 新的反向用例在实现退回“信封解码”时不会失败。已修：反向用例改用字段完整的夹具，先断言裸 payload 能解、再断言包信封后必须报错；触发：实现退回成信封解码；后果：反向用例仍通过，锁不住只收裸 payload
- 7（deepseek-v4.1-flash）成立，可以更好：### 7 低 `failed` 仍只写不读，首页读取失败对用户不可见。读取失败时保留旧快照、页面回退到设备动作卡，是有意的；要不要加读取失败行是产品选择，列给 Andy
- 8（deepseek-v4.1-flash）成立，会出错，低：### 8 低 `forget`/重新配对时不清空首页快照，旧服务器内容会留在内存里。AppModel.emptyStore 只清 chat 和 actions；已修：新增 HomeFeedModel.reset() 并在 emptyStore 里调用；触发：换服务器或重新配对；后果：新一次读取成功前，页面可能仍显示旧服务器的首页条目
- 9（deepseek-v4.1-flash）成立，可以更好：### 9 低 `check-design` 仍匹配不到 `spacing:`/`padding` 字面量，不能证明“界面不写死数字”。与第 1 轮第 7 条重复：四个值已进设计变量；把 spacing 和 padding 纳入 check-design 规则是另一件事，列给 Andy
