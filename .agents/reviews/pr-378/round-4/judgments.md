# PR 378 第 4 轮复核判断

这一轮是 Andy 在第 3 轮后选“再跑一轮 DeepSeek”跑的，复核提交 34dd5826（`--previous 1c9f8477`）。本轮仍有中级意见，没过；连续计数从这一轮重新算起，这是第 1 轮。

## 会出错：中、高（已改）

- r4-1：启动校验要求 `realEval.modelRef` 的 `api` 为 `openai-completions`，补了“用专用模型配置被拒”的反向用例。变异验证：去掉这个条件，测试失败。
- r4-2：样本含正文这一点维持第 3 轮的判断（主人要看样本判分对不对）。关着评测时只在启动时检查一次，这部分成立：改为不论开没开评测，服务每小时检查一次（`RealEvalSampleExpiry`）。
- r4-3：评测开着（mode 不是 off）时，启动校验要求向量模型允许 sensitive，补了反向用例；mode 是 off 时不要求。
- r4-4：运行开始前在状态目录写“进行中”标记 `in-progress.json`，运行记录写完后删掉。标记留下时，按“花光了本次可用额度”计入 7 天累计和 24 小时规则。测试是 “counts a run that never got recorded as having spent its whole allowance”。

## 会出错：低（已改）

- r4-5：“一点”后面跟“点”字时不当时刻，测试用“一点也不喜欢”。“7:30”和“七点半”算同一小时是有意的，不改。
- r4-6：`discardQuestion` 失败时计入 `rejected.discard_failed`，运行继续，仍记 declined。补了测试。
- r4-7：写样本失败时删掉临时文件；过期检查顺带删掉留下的 `latest-sample.json.*.tmp`。补了测试。
- r4-8：过期检查失败只报错，不挡评测。补了测试（样本路径是删不掉的目录时，评测照常跑）。

## 作者说法不一致

复核材料里的“52 次”和“所有被拒的都记 declined”是旧说法。ADR 第 59 行改为“没有跑完或花到上限的运行”。
