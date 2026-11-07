# PR #246 第 2 轮复核判断

会出错，中高（已改，要再复核）：
- D1：只看 next_entry 时，next_entry 指向运行内核、saved_entry 指向别的内核会被放过，第二次重启就进别的内核。改成分别读出 next_entry（下一次重启）和 saved_entry（之后每次重启）对应的内核，两个都必须等于运行内核；补用例。

会出错，低（已改）：
- D2：grub.cfg 里除了 next_entry 那一行，只允许 set default="${saved_entry}"，出现任何别的 set default（包括 if 块里的）就拦下；补用例。
- D4：提示改成“运行中的版本、服务和 GRUB 都没改”，运行手册同样改。
- D5：提示先说改 GRUB_DEFAULT=saved 和 update-grub，再说 grub-set-default，并写明要把两个标识换成 grep 出来的真实值；补用例检查顺序。

可以更好（不改，列给 Andy）：
- D3：同第 1 轮 D2。
- D6：解析只用手写的 grub.cfg 验证过；合并前可以请 Andy 让 Mac 会话只读取一次生产的 grub.cfg 菜单行，作为样本补一条用例。I-81 已写进未覆盖。
