# PR 570 第 1 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，会出错，低：### 1（低）apparmor_parser 失败没有 CI_ARM_PREPARE_FAILED 标记和约定退出码。读代码证实：prepare-arm.sh:54 没有 || fail；fail() 在 :12。改为 || fail ... 76。；触发：ARM 机器上 apparmor_parser 加载 /etc/apparmor.d/bwrap 被拒；后果：脚本以 parser 自己的退出码中止，没有 install-arm-runners.sh 第 3 步提示要看的 CI_ARM_PREPARE_FAILED 行
- 2（deepseek-v4.1-flash）成立，会出错，低：### 2（低）runbook 说 ARM 装这些是给 integration 沙箱用例用，但当前没有 ARM integration 作业。读代码证实：ci.yml 两个 integration 分片都是 ci-vps。文字改为在 ARM 上跑 integration（试跑和计划中的分片）时要用，并补 apparmor-utils。；触发：读 runbook 第 186 行；后果：读者以为 ARM 现在跑 integration，且文字漏了 apparmor-utils
- 3（deepseek-v4.1-flash）成立，会出错，低：### 3（低）新增测试只做静态文本比对，没覆盖 profile 路径、退出码和实际加载。读测试证实只比了包名、规则文字和两行字符串。补断言 APPARMOR_PROFILE 与 VPS 相同、内容不同时 fail 75、加载失败 fail 76；真机加载留给试跑记录。；触发：把 ARM 的规则写到别的路径或删掉内容比较分支；后果：新测试仍通过，漏掉回退
