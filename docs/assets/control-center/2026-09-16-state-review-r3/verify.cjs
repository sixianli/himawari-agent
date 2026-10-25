// 静态审核原型验证；不证明产品服务、模型、沙箱或持久化行为。
const { chromium, expect } = require("@playwright/test");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const titles = {
  review: "正在检查这次操作",
  allowed: "检查通过，正在准备保存",
  alternative: "需要调整保存方式",
  alternative_review: "正在检查新的保存请求",
  manual: "等待你的确认",
  review_failed: "需要你确认这次保存",
  denied: "未执行",
  queued: "等待保存秋雨东京.md",
  preparing: "正在准备保存",
  regenerate: "正在根据最新版调整修改",
  conflict_help: "修改已保留，等待你决定",
  rename_wait: "等待整理目录中的操作结束",
  target_changed: "保存位置已变化",
  target_review: "正在核对新位置",
  current_shell: "正在检查当前项目",
  stopping: "正在停止",
  stopped: "已停止，已保留修改",
  unresolved: "文件结果待确认",
  verifying: "正在核对文件结果",
  delivery: "文件已保存",
  cancelled: "已取消，未执行",
};
(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(8000);
  const errors = [],
    externalRequests = [],
    checks = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (/^https?:/.test(r.url())) externalRequests.push(r.url());
  });
  try {
    await page.goto(pathToFileURL(path.join(__dirname, "index.html")).href);
    const frame = page.frameLocator("iframe");
    const select = async (key) => {
      await frame.getByRole("combobox", { name: "查看场景" }).selectOption(`lifecycle:${key}`);
      await expect(frame.locator("#life-status")).toHaveText(titles[key]);
    };
    await expect(frame.locator("#life-status")).toHaveText(titles.review);
    await expect(frame.locator("#hw-scene optgroup option")).toHaveCount(21);
    await expect(frame.locator(".hw-send svg")).toHaveCount(1);
    expect(await frame.locator("svg").count()).toBeGreaterThan(8);
    for (const width of [320, 390, 1024, 1440]) {
      await page.setViewportSize({ width, height: width < 700 ? 900 : 1000 });
      for (const theme of ["dark", "light"]) {
        const scheme = await frame
          .locator("#hw-review")
          .evaluate((el) => getComputedStyle(el).colorScheme);
        if (scheme !== theme) await frame.getByRole("button", { name: "切换审核主题" }).click();
        for (const key of Object.keys(titles)) {
          await select(key);
          await expect(frame.locator(".life-details")).not.toHaveAttribute("open", "");
          await frame.getByText("查看过程", { exact: false }).click();
          const geometry = await frame.locator("body").evaluate((el) => ({
            viewport: innerWidth,
            body: el.scrollWidth,
            transcript: document.querySelector(".hw-transcript").clientWidth,
            content: document.querySelector(".hw-transcript").scrollWidth,
          }));
          expect(geometry.body).toBeLessThanOrEqual(geometry.viewport);
          expect(geometry.content).toBeLessThanOrEqual(geometry.transcript);
          const attention = [
            "alternative",
            "manual",
            "review_failed",
            "conflict_help",
            "target_changed",
            "unresolved",
          ].includes(key);
          await expect(frame.locator('[data-thread="lifecycle-demo"] .hw-dot')).toHaveCount(
            attention ? 1 : 0,
          );
          checks.push({ width, theme, key, overflow: false });
        }
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await frame.getByRole("button", { name: "切换审核主题" }).click();
    for (const key of ["review", "regenerate", "target_changed", "stopped", "unresolved"]) {
      await select(key);
      await page.screenshot({ path: path.join(__dirname, `desktop-${key}.png`), fullPage: true });
    }
    await select("manual");
    await frame.getByRole("textbox", { name: "输入消息", exact: true }).fill("保留我的修改要求");
    await frame.getByRole("button", { name: "模拟断线", exact: true }).click();
    await expect(frame.getByRole("button", { name: "允许本次", exact: true })).toBeDisabled();
    await frame.getByRole("button", { name: "模拟恢复", exact: true }).click();
    await expect(frame.getByRole("textbox", { name: "输入消息", exact: true })).toHaveValue(
      "保留我的修改要求",
    );
    await frame.getByRole("button", { name: "允许本次", exact: true }).click();
    await expect(frame.locator("#life-status")).toHaveText(titles.preparing);
    await select("manual");
    await frame.getByRole("button", { name: "拒绝", exact: true }).click();
    await expect(frame.locator("#life-status")).toHaveText(titles.denied);
    await select("alternative");
    await frame.getByRole("button", { name: "按替代方案继续" }).click();
    await expect(frame.locator("#life-status")).toHaveText(titles.alternative_review);
    await expect(frame.locator(".life-description")).toContainText("秋雨东京-草稿.md");
    await select("target_changed");
    await frame.getByRole("button", { name: "确认新位置" }).click();
    await expect(frame.locator("#life-status")).toHaveText(titles.target_review);
    await expect(frame.locator(".life-description")).toContainText("archive/秋雨东京.md");
    await select("queued");
    await frame.getByRole("button", { name: "停止等待", exact: true }).click();
    await expect(frame.locator("#life-status")).toHaveText(titles.cancelled);
    await select("current_shell");
    await frame.getByRole("button", { name: "停止本轮", exact: true }).click();
    await expect(frame.locator("#life-status")).toHaveText(titles.stopping);
    await expect(frame.getByRole("button", { name: "正在停止", exact: true })).toBeDisabled();
    await expect(frame.locator(".life-tool code")).toHaveText("bash");
    await select("unresolved");
    await frame.getByRole("button", { name: "检查状态", exact: true }).click();
    await expect(frame.locator("#life-status")).toHaveText(titles.verifying);
    await select("regenerate");
    await frame.getByRole("button", { name: "查看差异", exact: true }).click();
    await expect(frame.getByRole("dialog", { name: "查看候选差异" })).toContainText(
      "重新检查权限与目标",
    );
    await page.keyboard.press("Escape");
    await expect(frame.getByRole("dialog")).toHaveCount(0);
    await select("stopped");
    await frame.getByRole("button", { name: "秋雨东京.md 查看已保存内容" }).click();
    await expect(frame.getByRole("dialog", { name: "查看已保存文件" })).toBeVisible();
    await page.keyboard.press("Escape");
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await select("manual");
      await frame.getByRole("button", { name: "允许本次", exact: true }).scrollIntoViewIfNeeded();
      await expect(frame.getByRole("button", { name: "允许本次", exact: true })).toBeInViewport();
      await page.screenshot({
        path: path.join(__dirname, `mobile-${width}-manual.png`),
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await frame.locator("#hw-review").evaluate((el) => {
      el.style.zoom = "2";
    });
    await select("target_changed");
    await frame.getByRole("button", { name: "确认新位置", exact: true }).scrollIntoViewIfNeeded();
    await expect(frame.getByRole("button", { name: "确认新位置", exact: true })).toBeInViewport();
    await frame.getByRole("button", { name: "确认新位置", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(frame.locator("#life-status")).toHaveText(titles.target_review);
    await page.screenshot({ path: path.join(__dirname, "zoom-200-css.png"), fullPage: true });
    expect(errors).toEqual([]);
    expect(externalRequests).toEqual([]);
    await expect(page.locator("iframe")).toHaveAttribute("sandbox", "allow-scripts");
    await fs.writeFile(
      path.join(__dirname, "verification.json"),
      `${JSON.stringify(
        {
          checkedAt: new Date().toISOString(),
          scope: "静态审核原型；非产品 E2E，不访问模型、数据库或真实文件",
          browser: browser.version(),
          checks,
          interactions: [
            "确认与拒绝",
            "替代方案形成新请求",
            "确认新位置",
            "取消等待",
            "停止确认",
            "核验不重做",
            "差异与已保存文件预览",
            "Escape 关闭",
            "断线禁用与草稿保留",
            "窄屏确认可达",
            "200% CSS zoom 与键盘确认",
          ],
          zoomScope: "CSS zoom 200%，不是浏览器全页缩放资格",
          errors,
          externalRequests,
        },
        null,
        2,
      )}\n`,
    );
    console.log(
      `PASS ${checks.length} layout checks; 11 interaction groups; no errors or external requests`,
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
