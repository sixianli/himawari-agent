# PR 316 第 1 轮判断

- ds-1、glm-1、glm-2（同一问题：新白名单缺少真实 gitleaks 层的样例和放宽反向用例）：成立，“会出错”但判低。触发方式：日后有人放宽这条白名单。当前行为已由 `npm run check:gitleaks` 实跑核对（blocking=0）。已在 `test/tooling/gitleaks-config.test.mjs` 加目标文件、同目录兄弟文件、不同值三个夹具和“路径放宽”“值放宽”两个反向用例，运行通过。
- ds-2：成立，可以更好；已改成 `join` 拼接。
- ds-3：不成立。重算并同步了摘要，`check:gitleaks` 实跑通过。
- ds-4：不成立。模型自己标“推测”；实跑 `check:gitleaks` 的历史范围 blocking=0，且私钥夹具已不是连续字面量。
- ds-5：不成立。`origin/ci/speed-land` 上 `docs/adr/0189-drop-node-floor-and-fold-test-into-coverage.md` 仅标题号不同，改名一致，已逐行 diff 核对。
