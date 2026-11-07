# PR 278 第 1 轮逐条判断

- d1（deepseek-v4.1-flash）：成立，会出错，medium-high。处理：写明 ADR 0117 记的是安装时位置，两者关系未核实，以 readlink -f 为准
- d2（deepseek-v4.1-flash）：成立，会出错，medium-high。处理：读 Magpie 源码 internal/gui/web.go：?k= 只用一次换 cookie 并跳转去掉 k；改为书签存不带密码的地址
- d3（deepseek-v4.1-flash）：成立，会出错，medium-high。处理：改为 ssh -L 127.0.0.1:3430:127.0.0.1:3430
- d4（deepseek-v4.1-flash）：成立，会出错，medium-high。处理：?k= 和 MAGPIE_WEB_KEY 用 Magpie 源码佐证；web.env 改为“应该来自”，给只看变量名的命令
- d5（deepseek-v4.1-flash）：成立，会出错，low。处理：改为 -w http_code 形式，没通输出 000
- d6（deepseek-v4.1-flash）：成立，会出错，low。处理：标题改为登录后自动连接并说明 LaunchAgent 要登录后才运行；load 命令保留（已在 Andy 的 Mac 上实际跑通）
- d7（deepseek-v4.1-flash）：成立，会出错，low。处理：补写看状态的 launchctl list 命令和每 15 秒重试的说明
- d8（deepseek-v4.1-flash）：成立，可以更好。处理：不改：本节只把 ADR 0117 当历史出处，已改为“当前顺序以管理页为准”，不依赖 ADR 0117 的现行内容；Runbook 封存本来就过期，快速模式推迟到完整模式重封时一并考虑
- d9（deepseek-v4.1-flash）：成立，可以更好。处理：不改：本节不教人读 web.env 的内容，只给看变量名的命令；文件权限检查属于生产机加固，不是连接方法
- g1（glm-5.3-flash）：成立，会出错，medium-high。处理：同 d2
- g2（glm-5.3-flash）：成立，会出错，medium-high。处理：同 d1
- g3（glm-5.3-flash）：成立，会出错，medium-high。处理：用 Magpie 源码 web.go 证实 ?k= 换 cookie 的流程并写出来源；Andy 11-02 实际登录后地址栏是 ?view=settings&tab=general，与跳转去掉 k 一致
- g4（glm-5.3-flash）：成立，可以更好。处理：同 d8
- g5（glm-5.3-flash）：不成立，可以更好。处理：不成立：date 是本 Runbook 的创建日期，同目录其他 Runbook 增补章节时也不改它；现场证据已在本节第一段写明日期和命令
- g6（glm-5.3-flash）：成立，会出错，low。处理：一次性连接段补一句不要同时开

会出错的意见全部已改（低严重度的也改了）；有中、高严重度，所以对修改再复核一轮。
