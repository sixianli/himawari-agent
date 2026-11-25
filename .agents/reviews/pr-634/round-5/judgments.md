# PR 634 第 5 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，可以更好：### 1. 低 · `setMainLookupSettled(false)` 放在 `useEffect` 里，依赖变化后的第一次渲染仍会先显示输入框，可能丢焦点。thread-control-center.tsx:352-385（e70f4c5f0）：依赖变化的那一次渲染里 mainLookupSettled 仍为真且 mainThreadId 为 null，只有上一次查询已落定为“没有主对话”才会这样，这时输入框本来就显示着，不是新出现；effect 随即置 false 把它藏起，是第 4 轮意见 2 有意的行为。重新激活时最多多显示一帧，用户在一帧内无法输入，没有错误结果或丢字。改成同步派生的 lookup key 只消掉这一帧，算可以更好
