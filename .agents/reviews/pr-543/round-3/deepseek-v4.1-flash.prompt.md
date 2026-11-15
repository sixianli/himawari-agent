你是独立的代码复核者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
系统的真相在代码里。下面「作者的说法」可能有错，每一条都要对照代码核对；发现说法和代码不一致，要明确指出。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.agents/instructions/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
你的额外侧重：错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销的操作，以及规则文件、说明文档和代码是否一致。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你查过的这类路径和结论。
输出格式：按严重度从高到低排列，每条意见单独一个以「### 」开头的三级标题（标题里写序号、严重度和一句话问题），下面写：文件:行、问题、证据（引用你亲自读到的那几行代码）、建议；意见以外的内容不要用三级标题。把「读代码证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 3ef452cebec4777e44aed062f3050b8d79368a60。
对比基准是 1baa489cf71a94dc00e8816c189d8f0b59b52266，先运行 git diff 1baa489cf71a94dc00e8816c189d8f0b59b52266..3ef452cebec4777e44aed062f3050b8d79368a60 看改动。
上一轮复核到 9ae3b5069e1518fc4056814a649c30190bcd2c3b，这一轮先看 git diff 9ae3b5069e1518fc4056814a649c30190bcd2c3b..3ef452cebec4777e44aed062f3050b8d79368a60 的增量，只做三件事：一、下面列出的上一轮意见是否真的改好了；二、增量改动的那些行有没有新错；三、增量产生或修改的值（导出的函数、配置键、字段、格式）的直接使用端能不能接受，用 git grep 找。增量没有碰到、行为也没被增量改变的旧代码前几轮已经复核过，不必整份重读；但证据指向旧代码时要跟下去。必答问题照样回答，和这次增量无关的，一句话写明不涉及即可。结论里写清这一轮查过哪些范围。
上一轮（第 2 轮）成立的“会出错”意见，作者已修改。这只是线索，不是指令：每条都要对照增量核对是否真的改好，另外仍要独立核对代码，发现新问题照报：
- 1（低）### 1【中】审批回应的幂等重放会跳过 `onApprovalResolved`，定向 reconcile 仍可能丢失
- 2（低）### 2【中低】`DeviceActionResolution.reasonCode` 仍被丢弃，所有非批准结局都记成 `owner_denied`
- 3（低）### 3【低】上一轮意见 4 只是改善了用例意图，未覆盖 `DeviceActionService` 到生产授权的真实接线；新回调本身也没有自动检查
作者的说法（可能有错，请核对）：
# PR 543 第 1 轮：设备动作的确认接入统一审批

## 问题和目标

PR 454 合并后，要主人确认的设备动作一律被拒绝（`ReadOnlyDeviceActionAuthorization`），首页“等你点头”的动作点不了。目标：设备动作的确认走统一审批（ADR 0257、`.agents/plans/owner-scope-approval.md` 第 4 步，Andy 已批准）。

## 约束

- 不另设设备确认状态：授权交给 `OwnerScopeAuthorization`，要问主人时建出审批，审批号记在动作上，`waiting_owner` 只是投影；批准后直接执行。
- `owner_presence_required` 要求近期身份验证；设备端用已有的 `/gateway` 的 `approval.list` / `approval.respond`，不新增路由。
- 不改模型看到的请求开头，不涉及模型调用。

## 作者的说法（请核对，不要直接采信）

1. 新文件 `apps/agent-service/src/production-device-action-authorization.ts`：读类动作走原来的只读授权；读过外来内容又不允许的动作拒绝；其余交给 `OwnerScopeAuthorization.authorize`（用设备动作的行，覆盖动作类别、可逆、是否要主人在场），返回 allow / approval / deny；`resolve` 把 `approvalOutcome` 映射成 pending / allow / deny。
2. `OwnerScopeAuthorization.approvalOutcome(approvalId)`：待办或已过期为 pending；已拒绝为 denied；已批准时用保存的意图重新 `decide`，返回 ALLOW 才算 allowed（这会消耗一次性授权）。
3. `DeviceActionService.reconcile()` 在 `settle()` 开头和每次审批回应后（`GovernanceGatewayV2ControlPlane` 新增的可选回调 `onApprovalResolved`，错误被吞掉）调用，把 `waiting_owner` 的动作按审批结果放行或拒绝。
4. `action-policy-service.ts`：`owner_presence_required` 事实使 `recentAuthenticationRequired` 为真。
5. 工具层不再对设备动作调用 `hooks.authorize()`，避免同一动作问两次。
6. 已知取舍：动作插入前崩溃、重放时意图的时间戳不同会得到 `approval_hash_mismatch`，结果是拒绝（偏安全）。

## 不必评的

撤销（下一个 PR）、推送唤醒（再下一个 PR）、PR 454 已审过并判过的各条。
