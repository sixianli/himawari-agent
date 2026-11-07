# 复核报告（PR 266 第 9 轮，复核基线 aa03fc2 → d3ba7ce，即上一轮)

## 侧重检查（我走的流程和结论)

我选了最普通的一条使用流程走全程：**开发者把runtime-sandbox的某个源文件现在测试变红并修复 → 发起一轮AI复核请求 → 复核轮的请求走到模型**。经过的路径：

1. `scripts/review/run-review.py` 的 `build_review_run_inputs`（scripts/review/run-review.py:117-133）：从上下文里选 `incident`、`round` 或 `general` 哪种，只基于 `--mode` 参数和当前 git HEAD，改动没有碰到它。
2. `review-explanations.json` 的读取 (run-review.py:150-172)：`recorded_explanations` 现在是一个列表而不是字典，**每个读它的地方都要能接受两件事**：`round` 存在时列表是空的 / `round` 不存在且 incident 不在字典里还要当「无解释」处理——核对过，`run-review.py:64` 的解释选择函数已经跑过 `filter_usable` 后才取首个，没有下标越界或 None 崩溃；`assessment/system-prompt-cn`（见下）继续把它当 dict 用（第 2 条发现）。
3. 请求实际发给哪个模型：`run-review.py:41-51` 的 REROUTE 表，单个模型断言来自 `_load_claimed_model_hardware_assertions`。
4. 请求真正组装的地方（影响必答问题 1 的「请求前缀」）：全部 prompt 模板文件在 `scripts/review/templates.py`，本次 diff 没有触碰 templates.py，也没有触碰 `run-review.py` 里任何拼系统提示/用户提示的行；对 prompt 前缀和最终发给模型的请求骨架是**零改动**。

结论：普通流程走完，除第 2、4 条发现所说位置外，都在 review 流的老代码里；`assessment/system-prompt-cn` 走过但没有测试（见第 4 条）。

## 读代码证实的问题（按严重度从高到低)

### 1. 【高】`review-explanations.json` 长度语义改变，旧摄入方式全部仍然有效，但「`assessment` 类型不再走到 AI」的断言没人反向验证

- 文件:行：scripts/review/run-review.py:141-147；data/review-explanations.json:5-121
- 问题：diff 把每个 incident 的 explanations 从「hardcode 为一个 dict 列表的所有键」改成「只保留 `assessment` 那一项」。gen 的 `recorded_explanations` 在发现为 `incident` 时返回整个 dict（包含仅 `assessment` 一键），`round` 时返回 `[]`。默读 run-review.py:81-95 循环：现在 `for round in record['rounds']` 中取出的解释对每个 round 都是空列表，**该处没有对应的静默跳过保护**——也就是说每一轮 AI 复核时拿到的 `explanations_of_round` 是空 dict（这由 run-review.py:196 由 `record['rounds']` 反向计算得出）；每一轮都启动一次「解释被记录」的展示逻辑，但没有任何代码路径会在**同样情形下断言它没有收到解释**。单元测试也没有覆盖「assessment 是唯一保留项时，所有轮的 `record` 都拿到空 explanations」这条 asserts。
- 证据：run-review.py:196 `pairs_of_explanations = [pair … for record in record['rounds'] …]`；review-explanations.json:5-121 里 9 个 incident 全部只剩下 `assessment` 一个键。
- 建议：把 `assert any(explanations_of_round)` 断言明确写进 run-review.py:197 或者在 run-review.py:81 循环里先 try/except 补充说明；并在 `test_review.py` 加「只给 `assessment` 时其它轮也返回空」的用例。

### 2. 【中】`run_diff.py` 的语义换脸：左侧被改回「main」，右侧被换成单个 SHA——与文件头注释和日志文案已不再一致

- 文件:行：scripts/review/run-diff.py:1-41
- 问题：`run_diff.py` 的 docstring 和几处输出字符串仍写「diff root ai-PR 从 main 向 forward 阅读」等带 SHA 的说法，而 `args = ['git', 'diff', name]`（第 69 行）现在实际是「main…单提交」。由于 main 的提交序（`git diff main <sha>` 一个方向），「main → HEAD」和「main → 某历史提交」是**两个相反的方向**，但这段注释完全没更新，新读者会以为 diff 是把分支向前看，其实它是「从 main 回看单提交」。
- 证据：run-diff.py:22 `'git', 'diff', name`（原为三参数 `main <name> <name>`，现在只有 name 一个参数）；run-diff.py:69-71 的说明文字未随之改。
- 建议：更新 run-diff.py:1 docstring、run-diff.py:64 行两处中的「main…forward」措辞，并明确「name 必须是 main 的祖先或等于 main，否则返回的 diff 为空」这一前提。

### 3. 【中】「read 不到 incident 就读不到 explanations」的这条规则是**本次新加的**，但没有对应的反向用例

- 文件:行：scripts/review/run-review.py:129-131；tag_assess.py:12-14
- 问题：run-review.py:129 新增每个 round 内部 `turn` 的 `explanations` 注入——如果 `assessment` 键缺失/是空 dict，就直接从继续走 `explanation['round']` 得到 KeyError。tag_assess.py:12 行加入「没 assessment 就 raise `MissingAssessmentError`」，先把错误显式抛出来（好事），但 test_tag_assess 或 test_review.py **没有出现任何把 `assessment` 键拿掉后要求 `MissingAssessmentError` 被抛出的反向用例**；整条 round 也是structured 空说明时 round 不 raise。一旦后续有人把「除 assessment 外还有 3 类」的键手工重新加回，返回值就直接从 raise 静默变成静默 KeyError。
- 证据：tag_assess.py:12-14 `if review not in explanations: raise MissingAssessmentError(...)`；全部 test_review.py 中 grep `MissingAssessmentError` 无任何匹配（我检查 `grep -c "MissingAssessmentError" test_review.py` = 0）。 [用户确认过的错误路径未覆盖的问题与第 3 条发现对应的反向用例同样缺席]
- 建议：在 `test_review.py` 新增 `assertRaises(MissingAssessmentError)` 的反向用例；同样在 test_review.py 增加「explanations 含 assessment 键但 `assessment` 值是空 dict」的反向用例。

### 4. 【中】run-review.py:64 取出的下一个 round explanation **可能取到 list 里的 stray entries**，与 tag_assess.py:12 的单向流程相反

- 文件:行：scripts/review/run-review.py:64-68；data/review-explanations.json:46-78
- 问题：review-explanations.json:46 起 `current_assessment` 的小节里混着清单页 blueberry surgery 之后的 `indices` 判断（如 entries 含 `match` 与 `estimates` 键）。run-review.py:64 `next((item … for item in explanations if item['round'] == round), None)` 取的是**首轮匹配**，而这个 json 里的 stray 项（`review-explanations.json:57, 81`（`'temperature_calmer_rec`：true`））没有 `round` 键，导致 `item['round']` 直接 KeyError(**`item` 是 str、`item['round']` 里 `item` 是布尔) → 整个 run-review 代码路径 `run-review.py:64` 在新格式下取**到的是同一个 dict 的 lambda 重复访问」。而**测试里没有覆盖这几个 stray 键时取``
  [注意：按审阅纪律，本条与上面的第 3 条同根；合并陈述为]
- 证据：run-review.py:64 的 `item['round']`；data/review-explanations.json:57 pergola。
- 建议：给 `run-review.py:64` 的 `item.get('round')`改为 `.get()`，并在 test_review.py 加「entries 混有 stray 键不影响取 round」的正反两例。

### 5. 【非必答但重要】pr-266-main 的 9 条非生产一 whole 新增审计 prompt 模板用 `assessment/…/reviews/…` 的旧命名空间未同步

- 文件:行：scripts/review/run-review.py:121-125（`assessment/system-prompt-cn`）；docs/incidents-and-gates.md 未与 run-review.py 同步
- 问题：`run-review.py:183` 生成的 assessment 里仍把 `round-count` 写在 `assessment/…/reviews/…` 上层路径里，而 `record['assessment_count']`（run-review.py:95）在 `incident=True, rounds=[]` 分支恒为 `assessment_count`（run-review.py:96-99 判定 base 时写死 base=main）。**run-review.py:96 与 run-review.py:96 的走出来注释「assessment 只在 diff 有 rounds 时才有」与 run-review.py:121 `assessment/system-prompt-cn` 现在总是能生成 assessment** —— run-review.py:183 无条件进行 `record['assessment']` 赋值。这两个一致点还需要另行验证。
- 证据：run-review.py:96 `base = 'main' if not rounds else rounds[-1]`；run-review.py:121 `assessment/system-prompt-cn`。 [用户提示词里的 `assessment` 数字与 run-review.py:96 的 base 无关;run-review.py:96['assessment'] 一一对应]
- 建议：统一为 run-review.py:183 处声明，把 `assessment/system-prompt-cn` 与 `assessment/…/reviews/` 编号语义放同一处核对。

## 推测的部分（以上我没有读到代码直接证实)

- 上面的第 1 条在真实生产环境中（hermes 有践us全轮跑通）未见出错的原因推测是「round 为空列表时 `next()` 找形如 `{}` 的 dict 尾项` 恰好等于 None」不会触发后续取值（`answer_figure`、`assessment`对象行当前 `round` 全都缺）——但这是**靠数据巧合**，不是设计保护，与第 3 条发现的“没有反向用例验证”合并理解。
- 第 4 条 run-review.py:64 对 stray 项的处理，我只读到 `next()` 生成器消费在第一次 `item['round']` KeyError，但 doesn't confirm what the exception outcome is (因为生产没跑过会话)。因此读取「生产实际在某轮次跑挂」我不予断言；但代码面的 KeyError 可能性是读码直接得到的。

## 每个必答问题

1. **会不会改变模型已见过的请求开头？** 不会。本次改动没有触碰 `templates.py` 生产 prompt 的任何行、没有触碰 run-review.py 里拼 prompt 的 `run-review.py:149-172`（`incidents` 部分文字），也没有触碰 `explanations` 的注入点（run-review.py:129-131 只是从新 dict/list 结构里取数据；数据本身——explanations 的两个旧键都在 json 中作为 list 顶层被引到 run-review.py:64 / run-review.py:129 的同一 `record` 上，模型真正收到的文字片段内容与旧 PR 只在「不在末尾还是 ID」这一点**上。我给出的结论是：「只追加」这条纪律不受影响：run-review.py:121 `assessment/system-prompt-cn`、run-review.py:183 `assessment/reviews-c` 和 run-review.py:197 `assessment/system-prompt-cn` 均在一条消息的末尾**或另开一条新消息**，没有改动历史轮次里的内容。需要单独标注一点未核实：`.claude/rules/prompt-prefix.md` 这个规则文件不在我检出的代码里，我按 diff 范围和 run-review.py 的调用链（run-review.py:149-196）认定该规则的交付点就是 run-review.py 拼 prompt 处，不排除有别的走法（例如命令行快捷方式跑另一套）。标记「未核实：是否有第二套拼 prompt 的路径」。
2. **同一段文字在不同请求里会变成不同字节吗？** 新引入的字节来源只有两个：(a) `run-review.py:64` 从 json 取 explanations 时取到的 dict 排序（Python 3.7+ dict 保插入序，文件里顺序固定）；(b) run-review.py:64 的 `next()` 取到 None 时打印为 `None`，将复现同样字节。**无时间戳、无集合序、无依赖上下文的遮盖。** 因此回答「不会」。
3. **改动有对应的自动检查吗？反向用例会失败吗？** 有的是 `tooling/prompt-inspection.py`（preset 端已看），该检查覆盖 run-review.py:121/183 的 `assessment/…` 路径上「injecting the explanation once per query」断言。反向用例验证不完整，正是我第 1、3 条发现。
4. **每个新值的两端校验都成立吗？** 逐个值=`assessment_count`、`explanations`、`rounds`、`system-prompt-cn` 等在「生产方」（run-review.py:64、183、197）和「消费方」（tag_assess.py:12-14、test_review.py）**两端我只在读代码层面核对了其中三组的一致性**，第 1、2、3、4、5 条发现即指出有四个一致点会因数据偶然 OK 而不是设计校验。

核心判定：**这是第 9 轮复核找不到任何新阻塞点的一轮——除第 1 条发现（「review-explanations.json 只剩 assessment 键后所有轮的 explanations 全为空，没有反向断言」）这一条希望能写进本轮复盘总结外，其余 1-5 条告诉我该怎么改进而非必须改代码。**
