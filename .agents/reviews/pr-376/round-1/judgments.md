# PR 376 第 1 轮复核判断

| 编号 | 模型 | 意见 | 判断 | 处理 |
| --- | --- | --- | --- | --- |
| ds-1 | deepseek-v4.1-flash | 网关契约 fixture 没跟上新 schema，`test:contracts` 会失败 | 会出错·中高 | 契约测试以 unknown field document 失败（已实际运行复现） |
| ds-2 | deepseek-v4.1-flash | “出处”没有从规则手册读，仍来自当前代码里写死的字符串 | 会出错·中高 | ADR 写“出处直接从规则手册读”，与代码（取生成规则代码里的 source）不符，会误导后来的人；改为修正 ADR 措辞并写明 rule_book_rules.source 只是内部标记 |
| ds-3 | deepseek-v4.1-flash | `thisMail` 不会标出新增的“小额不推送”规则 | 会出错·中高 | 抽屉里这条规则不显示“这封邮件用到”，命中规则数也少算；已改为合并该邮件的 ruleHits 并补测试，回退修改后测试失败 |
| ds-4 | deepseek-v4.1-flash | 说明文档与代码不一致 | 会出错·低 | 旧 ADR 不改写；在 ADR 0215 后果里写明取代这两处说法 |
| ds-5 | deepseek-v4.1-flash | `revision === 0` 默认值读取路径没有自动检查 | 会出错·低 | 默认值路径缺测试；已补 decision-chain 集成用例（quiet_hours@0、floor_important_sender@0、无行的裸 id） |
| glm-1 | glm-5.3-flash | `floorHitRefs` 的回退分支没有直接测试 | 会出错·低 | 缺测试；已补单元用例 |
| glm-2 | glm-5.3-flash | 「这封邮件用到」标签不覆盖 suppress/quiet 命中 | 会出错·中高 | 同 ds-3，已修 |
| glm-3 | glm-5.3-flash | `slice(0, 256)` 可能截断修订号 | 会出错·低 | 修订号被截掉、显示为当前版本；已改为只截 id，补单元用例 |
| glm-4 | glm-5.3-flash | 静默判定每次推送压后时跑两遍 CEL | 可以更好 | 同输入同输出，只多算一次静默规则，行为和结果都不变；改动只会动函数结构，不改事实和行为，收益可忽略，不改 |

ds-2 的处理：出处继续取生成规则的代码里写的依据（ADR 和设置名），这是给主人看的出处；规则手册表的 source 列现在只有写设置时的内部英文标记，不展示。改的是 ADR 0215 的错误措辞。
