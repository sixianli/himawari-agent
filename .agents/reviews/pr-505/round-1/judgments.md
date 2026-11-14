# PR 505 第 1 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，可以更好：### 1、低、内置规则表达式改了语义，`revision` 仍是 1，同一修订号对应两段不同规则。规则表达式收窄只剔除了本就不存在的输入（managed-task 的 CREATE_OR_UPDATE 目前只有 cancel，production-tool-actions.ts:126-130 reversible 恒为 false），真实停任务仍命中（tool-action-registry.test.ts:614-631）；revision 不变不会让任何现有授权出错，只是修订号约定可以更严
- 2（deepseek-v4.1-flash）成立，可以更好：### 2、低、新增反向用例用的是网关枚举外的动作并绕过了网关校验，证明不了线上路径。防御性死分支的用例，测试写法可以更好（换成真实 owner: 规则目标）；去掉新分支用例同样会失败，不影响正确性；网关枚举外的动作在入口已被 schema 拒绝
- 3（deepseek-v4.1-flash）成立，可以更好：### 3、低、`reversible == 0` 把“停任务”绑定到工具登记表的“不可撤销”标签，语义耦合并非“动作=取消”。当前 cancel 恒为 reversible=false，规则与登记表一致，tool-action-registry.test.ts:614-631 已锁住；只是未来改动的耦合提醒，不是现在的错误
