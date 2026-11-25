---
status: "active"
document_type: "backlog"
record_id: "BL-20261028-003"
record_state: "open"
date: "2026-10-28"
updated: "2026-10-28"
priority: "high"
item_type: "enhancement"
source_idea: ""
review_after: ""
promoted_to: ""
result: ""
reason: ""
supersedes: ""
superseded_by: ""
---
# 把 Jarvis Test 现在能测的三条做成自动评测集

## Summary

按产品愿景第 3.7 节，先把 Jarvis Test 里现在就能测的 #1 跨时间记忆纠正、#6 状态判断纪律、#8 失败透明做成仓库里能自动跑的评测：每条用例含预置记忆、固定测试时钟、假数据和判分规则；先作能力评测，通过后转为每次提交前的回归评测。其余七条等对应能力具备后再加。

## Origin

- 来自[产品愿景 Jarvis Test](../product-vision.md#jarvis-test)的评审（[ADR 0101](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0101-adopt-product-vision-v2-1.md)，评审网页 <https://claude.ai/artifact/G7qKTu3gw38PFGpWVzohZF>）。Andy 2026-10-28 14:12（日本时间）原话：“了解，那就做我们现在能做的”。

## Notes

- 由另一个线程负责。
- 2026-10-28：第一层（只用代码判分、不调模型）已随 PR #69 合并。第二层（真模型跑用例、两层模型裁判、每轮分数写进 `evals/jarvis-test/history.jsonl`）的决定见 [ADR 0103](../adr/0103-jarvis-test-live-evaluation-and-two-tier-judge.md)。其余七条见 [BL-20261028-005](BL-20261028-005-jarvis-test-remaining-seven.md)，#1 的反例见 [BL-20261028-006](BL-20261028-006-jarvis-test-memory-correction-negative-cases.md)。
