你是独立的代码复核者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
系统的真相在代码里。下面「作者的说法」可能有错，每一条都要对照代码核对；发现说法和代码不一致，要明确指出。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
你的额外侧重：错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销的操作，以及规则文件、说明文档和代码是否一致。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你查过的这类路径和结论。
输出格式：按严重度从高到低排列，每条写：严重度、文件:行、问题、证据（引用你亲自读到的那几行代码）、建议。把「读代码证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 5f21139b9c5ff5d41235d7de8326f18a1c396e8b。
对比基准是 bc380a6e69d86dc2b5b233a5010b75b3f9f1ed1e，先运行 git diff bc380a6e69d86dc2b5b233a5010b75b3f9f1ed1e..5f21139b9c5ff5d41235d7de8326f18a1c396e8b 看改动。
作者的说法（可能有错，请核对）：
# PR 266 第 12 轮作者说明（完整复核）

这一轮看整个 PR：`--base`（bc380a6e，当前 main）到 `--head`（5f21139b）。之前 11 轮复核的账本在第 10 轮断开了（我把起点填晚了），复核脚本要求一轮两个模型都参加的完整复核才能重新接上，所以重看全部改动。

## 问题

上线包里的测量探针 `scripts/delivery-mode/packet-template/measurement/probe/bootstrap.mjs` 按 SHA-256 认三个构建产物（`runtime-sandbox/dist` 下的 `job-host-main.js`、`sandbox-sdk.js`、`sandbox-sdk-worker.js`）。PR 234 改了 `packages/runtime-sandbox/src/` 下的源码，但没人更新探针里的摘要，直到上线包生成后期 `check-packet-consistency.py` 报 `PROBE_DIGEST_STALE` 才发现（事故 I-79）。另外 Hermes 上的测试目录 r2-u1 被删过，原因没查出来（事故 I-80）。

## 做法

- `scripts/delivery-mode/probe-sources.json` 记下每个被探针认的构建产物的摘要，以及它对应源码文件的摘要。
- `scripts/check-probe-sources.mjs`：核对 bootstrap 里的摘要和记录一致、bootstrap 认的每个文件都有记录、源码文件的摘要没变；记录或 bootstrap 格式不对时明确失败。
- `test/tooling/probe-sources.test.mjs`：名字带 `[probe-digest-stale]` 的用例是 I-79 的复现。
- `package.json` 新增 `check:probe-sources`，加入 `check:steps`（40 步）；`run-all-checks.test.mjs` 断言它的完整命令。
- `run-release-walkthrough.sh` 和 `test_make_packet.py`：I-80 的门槛，测试目录不存在时预检失败。
- `docs/incidents-and-gates.md` 加 I-79、I-80 两行。

## 约束和已知取舍

- Mac 上不能构建，检查只比源码摘要：源码变了但构建产物没变时也要求刷新记录，有意偏严。
- 构建指纹不与源码绑定、不检查 `replace()` 锚点：由 Hermes 上的上线包检查拦，I-79 已写明未覆盖。
- 改动不涉及发给模型的内容。

## 已验证

Hermes 上 `npm run check` 40 步全过；`probe-sources.test.mjs` 和 `run-all-checks.test.mjs` 全过；`[probe-digest-stale]` 用例在恢复 PR 234 之前的源码时失败。

## 请重点看

- 正则能不能漏掉 bootstrap 里实际被认的文件，格式变化时会不会静默通过。
- 记录文件损坏或字段缺失时，脚本是否清楚失败而不是误判通过。
- I-80 的门槛是否真的能拦下目录被删的情况。
