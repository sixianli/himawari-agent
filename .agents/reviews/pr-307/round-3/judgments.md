# PR 307 第 3 轮 逐条判断（只跑 DeepSeek，head 5f562ba，增量 e1ec166..5f562ba）

## 合并结果核对
`git diff origin/main..5f562ba` 共 19 个文件，只有本 PR 的 heartbeat 脚本、手册、package.json、复核记录，以及 docs/incidents-and-gates.md 的一行（I-83）。main 的 I-84、I-86、I-89 行都保留，没有丢行，也没有改动别的行。

## 会出错，中、高：无
## 会出错，低（1 项）
- r3-1 PR 描述过期：写的是发 /fail、“确认收到失败通知”、“复核未跑”，代码和手册已是 /log 加 5 分钟宽限。模型标“中”，我判低：仓库里的手册与代码一致，只有 PR 描述过期，最多让人对告警时刻预期偏差。修法是改 PR 描述，不涉及提交。

## 可以更好（不改）
- r3-2 安装非原子：与第 1 轮 ds-7、第 2 轮 r2-4 同，手册已写重跑。
- r3-3 /etc/himawari 目录对 himawari-prod 可写，可替换网址文件：目录权限未在现场核实；该账号本来就能伪造 /health/ready，没有新增能力。建议后续把网址放 root 独占子目录。
- r3-4 status 恒返回 0；r3-5 端口硬编码；r3-6 测试未锁加固项；r3-7 手册占位写法；r3-9 “没覆盖”可补模型供应商/Magpie 故障发现不了。
## 不成立
- r3-8 /health/ready 缺 health 时默认 200：这是本 PR 没改的既有代码，生产组装已传 health。
## 未核实
`/log` 不重置计时（第 2 轮已查官方文档）、RestrictAddressFamilies 与 DNS、/etc/himawari 现场属主：留给手册里的装后验收。
