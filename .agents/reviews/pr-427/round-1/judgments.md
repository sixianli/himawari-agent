# PR 427 第 1 轮逐条判断

- g1（glm-5.3-flash）：新增的三条目录文字没有进 `TRUSTED_PROMPT_TEXTS`（遮盖白名单） —— 成立，会出错（low）。现在的文字不会被遮，实际输出不变；已把 activity 加进清单，并补测试锁每个目录模块都在清单里
- g2（glm-5.3-flash）：36 个图标的数组 `PROCESS_ACTIVITY_ICONS` 和系统提示“过程图标”一节的文字是两份手写维护的清单，没有测试锁一致 —— 成立，会出错（low）。现在两份逐名一致，只缺测试；已补 [ICON-1] 测试
- g3（glm-5.3-flash）：回退模板句按**读取时**的 `thread.answerLocale` 计算 —— 成立，可以更好。设计如此，已在 ADR 0250 后果里写明
- g4（glm-5.3-flash）：新合并逻辑无测试 —— 成立，会出错（low）。空值覆盖已有句子时没有测试报警
- g5（glm-5.3-flash）：参数说明告诉模型“不超过 30 个字”，`PROCESS_ACTIVITY_MAX_LENGTH` 却是 80 —— 成立，可以更好。30 是给模型的建议，80 是服务器硬上限，已在 ADR 写明
- g6（glm-5.3-flash）：参数结构不是 type:"object" 的工具不会加这两个参数，而系统提示说“任何工具”都可以给 —— 不成立。生产里的工具参数结构都是对象，不会走到
- g7（glm-5.3-flash）：若某对话没有任何冻结的 object 参数工具、某轮只出现执行句柄工具 —— 成立，会出错（low）。模型拿到参数却看不到图标表，图标退回 tools
- d1（deepseek-v4.1-flash）：只有 handle 工具的会话里，模型会拿到 activity 参数却看不到图标表 —— 成立，会出错（medium-high）。参数说明指向不存在的一节，模型乱写图标名
- d2（deepseek-v4.1-flash）：`event.input` 变更是否只作用于校验副本、历史与循环守卫是否真的看到去掉后的参数，没有测试锁定 —— 成立，会出错（low）。现行为正确（Pi 文档和实测），缺的是测试；已在 [ICON-1] 断言下一次请求历史保留原参数
- d3（deepseek-v4.1-flash）：新契约字段是必填，旧客户端会整体解析失败 —— 不成立。手机端还没上线，按新形状解析（已和 iOS 第 2 批约定）；网页和服务器一起上线；ADR 已写
- d4（deepseek-v4.1-flash）：投影对所有工具都按“过程字段”处理，工具自己原有的 activity/activityIcon 会被误当成展示句子 —— 成立，会出错（low）。只影响过程行显示，工具执行不受影响；生产里没有这样的工具
- d5（deepseek-v4.1-flash）：图标名有两份“事实来源”，但没有一致性检查 —— 成立，会出错（low）。同 g2
- d6（deepseek-v4.1-flash）：参数说明写“不超过 30 个字”，服务器上限是 80 —— 成立，可以更好。同 g5
- d7（deepseek-v4.1-flash）：模型可控的 activity 文本没有清洗换行/控制字符/双向控制符 —— 成立，会出错（low）。手机过程行多行或文字方向错乱
- d8（deepseek-v4.1-flash）：结束记录把 activity/activityIcon 置空，依赖客户端按 itemId 合并 —— 不成立。设计如此（ADR 决定 4），已和 iOS 第 2 批约定按 itemId 取最新的非空值；网页合并已补测试
- d9（deepseek-v4.1-flash）：退回句子在每次读取时按当前 `answerLocale` 重新生成，历史显示可能随语言切换变化 —— 成立，可以更好。同 g3

修改见提交 ea60cbf53。d1 判中、高，所以第 2 轮只用 DeepSeek 复核这些修改。
