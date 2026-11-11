# PR 378 第 3 轮复核判断

复核 1c9f8477（`--previous 76533f80`，只用 deepseek-v4.1-flash）。本轮仍有中、高意见，没过。这是连续第三轮没过：按规则先改，改完不再复核，停下报告 Andy。

## 会出错：中、高（已改，未复核）

- r3-1 检索按 private 发：`MailEmbeddingContext` 新增可选 `dataClassification`，评测按题目所出自那条记忆的分级传入；向量模型不允许这一级时拒绝。邮件检查不传这个字段，行为不变。测试是 `production-mail-embedding.unit.test.ts` 里的 “[P4-5] uses the classification the caller names …” 和服务测试 “searches with the classification of the memory behind the question”。
- r3-2 费用缺失时记 0：费用缺失、是小数或是负数时，抛 `RealEvalModelError("COST_INVALID")`，服务层按预估记账。测试是 “refuses a completed call whose cost is missing or not a whole number”。
- r3-3 预估可能偏低：输入改按 UTF-8 字节数预估。字节级分词的 token 数不会超过字节数，所以只要服务方按标价收费，实际费用不超过预估，`reserve` 就挡得住。测试是 “estimates input by UTF-8 bytes …”。
- r3-4 样本写不出来就再也不重跑：写样本移进运行内部，在写运行记录之前写；写失败时这次运行记为 failed，隔一天重跑。测试是 “records the run as failed when the owner's sample cannot be written”。
- r3-5 配置只查 private：`realEval.modelRef` 必须同时允许 private 和 sensitive，否则启动时拒绝，并补了反向用例。

## 会出错：低

- r3-8（模型标中，判低）：理由见 verdicts.jsonl，ADR 已写明评测只在一个服务进程里跑。
- r3-10：未改，列给 Andy。判分输出非法的题每周重答一次，费用受周上限约束；要退役这类题，得给 `retired_reason` 加一个值，也就是改迁移的检查约束。
- r3-11：ADR 已改成准确的说法：`response_invalid` 例外、写入出错时记失败。
  - 复核材料里写的 52 次是旧说法，代码是 520 次。
  - `schema-catalog` 的 “with Owner or Agent deletion” 是全文件通用写法（共 28 处），不改。
  - 出题提示词写“最多 60 个字”，代码硬上限是 120，提示词是给模型的目标，硬上限是防越界，两者不冲突。
  - 报告脚本不显示决策计数，未改，列给 Andy。

## 不成立

- r3-6、r3-7、r3-9：理由见 verdicts.jsonl 的 `reason`。r3-6 和 r3-9 是前几轮已判、本轮没有新证据的意见。
