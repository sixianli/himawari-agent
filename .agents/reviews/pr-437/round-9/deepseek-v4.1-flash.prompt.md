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
仓库就是当前目录，已检出 58b232e068d661275a7c95b501b694a4d6a0dc6f。
对比基准是 b3f3f06c17c45591c3499a718822cc82c2e084d6，先运行 git diff b3f3f06c17c45591c3499a718822cc82c2e084d6..58b232e068d661275a7c95b501b694a4d6a0dc6f 看改动。
上一轮复核到 a6761f463e6261b32e0c7783eb30d53187d5e300，这一轮先看 git diff a6761f463e6261b32e0c7783eb30d53187d5e300..58b232e068d661275a7c95b501b694a4d6a0dc6f 的增量，只做三件事：一、下面列出的上一轮意见是否真的改好了；二、增量改动的那些行有没有新错；三、增量产生或修改的值（导出的函数、配置键、字段、格式）的直接使用端能不能接受，用 git grep 找。增量没有碰到、行为也没被增量改变的旧代码前几轮已经复核过，不必整份重读；但证据指向旧代码时要跟下去。必答问题照样回答，和这次增量无关的，一句话写明不涉及即可。结论里写清这一轮查过哪些范围。
上一轮的判断记录没有提交或读不出来，没有带入。
作者的说法（可能有错，请核对）：
# PR 437：能力重新启用（capability.reactivate）

目标：让主人能把已停用的能力重新启用。命令 capability.reactivate：服务器端验最近认证 → 核对期望版本号 → 状态必须是已停用 → 三项核对全过才从已停用直接写成在用；任一步失败能力记录不变；不恢复执行句柄和定时任务；写审计。

三项核对（见 docs/adr/0254-capability-reactivation-is-one-atomic-command.md）：
(a) 部署快照文件的摘要等于配置里封存的摘要；
(b) 能力的编号、版本、安装包摘要与快照里的条目一致；
(c) 执行进程在现场检查通过后写出的记录（runtime/execution-worker.qualified.json）里，启动编号等于 agent-service 当前认定的对端启动编号，快照摘要等于配置封存的摘要。

约束：不改表和迁移号，不改发给模型的内容；现有“已停用直接激活”必须仍被拒；不走部署快照加载器的 5 分钟新鲜度规则，也不走 CapabilityLifecycleService 的 qualify；现有启动绑定文件的格式和写入时机不变；界面不得声称“已重新检查运行环境”。

比较范围：--base 是任务 2（PR 435）分支的最新提交，本 PR 只含重新启用的改动。

作者的说法（请核对）：
- 新文件读写和启动绑定共用同一对函数（packages/platform-node/src/state-root-layout.ts 的 commitWorkerRuntimeRecord、readWorkerRuntimeRecord），重构后启动绑定的行为不变。
- 执行进程只在 bindingThenQualification 成功后才写记录，启动时先删旧记录（apps/execution-worker/src/service-main.ts）。
- capability.reactivate 只在核验入口装配后才进已安装清单。
- 已知没有自动测试的一条：执行进程完整启动成功后写出记录（云端容器跑不了进程级测试）。

第 3 轮：按第 2 轮意见做的修改（--previous 到 --head 的增量，请重点核对）：
- 最近认证没过的 capability.reactivate 在写治理收据之前被拒（governance-gateway-adapter.ts 的 #authenticateBeforeFirstReceipt），测试断言查不到收据。
- 配置里没有 capabilityDeployment 时 createProductionCapabilityReactivationVerifier 返回 undefined，生产入口不装配，命令不进已安装清单；原因码 capability_deployment_not_configured 已删除。
- 执行进程写出记录之后启动失败，catch 里删掉记录。这一条和“完整启动成功后写出记录”都没有自动测试。
- readWorkerRuntimeRecord 加 16384 字节上限（启动绑定共用，同样生效）。
- 浏览器测试夹具重新启用时不改 healthStatus；架构文档和 ADR 0254 同步。

第 5 轮：第 4 轮之后只加了测试和 ADR 的一句局限说明，生产代码没有改。前面“没有自动测试”的说法以这里为准：
- 已有测试：检查通过前读不到记录、通过后装配前读得到、装配失败后被删；绑定成功而检查失败时没有记录；超过 16384 字节的记录被拒；记录里实例编号或部署编号不一致被拒。这些测试里现场检查和装配两步是替换掉的。
- 仍没有自动测试：用真实现场检查完整启动成功后写出记录、正常停止时删掉记录、崩溃后重放的分支。
- 作者不再主张“启动绑定行为不变”：格式和写入时机不变，读取多了 16384 字节上限。

第 6 轮（PR 435 已合进 main，本 PR 现在直接对 main；--base 是 origin/main）：第 5 轮之后的增量里请重点看这些没有人复核过的改动：
- 合并最新 main 时解决冲突的网关装配：apps/agent-service/src/production-approval-gateway.ts 现在在网关内部创建能力生命周期（main 的写法），重新启用改为网关选项 capabilityReactivation（有核验入口才装），先算 capabilityReactivationAvailable 再展开清单；production-http-composition.ts 只把核验入口传给网关，并把 capabilityReactivationAvailable 传给路由选项里的已安装清单。
- packages/gateway-contracts/src/client-capabilities.ts 把 capability.reactivate 登记为“改”类（要面容），Swift 生成文件同步。
- 网页：本 PR 不再动控制中心；ci/operations-pending.json 里 capability.reactivate 登记为暂时没有网页调用方（Andy 定有 App 版就不做网页版）。
- 上一轮之后还改过：执行进程一进状态目录就删旧记录（service-main.ts 的 clearWorkerQualifiedDeployment 位置前移）及对应测试；ADR 0254 的措辞。

## 第 7 轮增量
上一轮（第 6 轮）意见 1（中）已改：执行进程启动时先读 authority 并核对 id/ownerId/agentId，一致后才清合格记录，再检查是否 active；新增用例“authority 属于别的部署时保留记录”。意见 2（原因码到不了 HTTP 客户端）、4（HTTP 组合层正向测试）、5（lstat 后 readFile 窗口）暂不采纳，属可以更好；意见 3 的措辞以 ADR 为准（绑定和现场检查通过后写出）。

## 第 8 轮增量
第 7 轮三条低意见已改：测试用 createDeploymentId、加 AUTHORITY_MISMATCH 断言、ADR 第 80 行改成“先核对三项身份再删”。另合并了最新 main（只带进测试小改，无冲突）。

## 第 9 轮增量
第 8 轮意见（测试引入不允许的 domain 依赖）已改：去掉导入，用 authority 自带 id 的类型加后缀；check:boundaries 通过。
