// 仅验证静态审核原型，不是产品 E2E 或后台验收。
const { chromium, expect } = require("@playwright/test");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  const errors = [],
    requests = [],
    checks = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (/^https?:/.test(r.url())) requests.push(r.url());
  });
  try {
    await page.goto(pathToFileURL(path.join(__dirname, "index.html")).href);
    const frame = page.frameLocator("iframe");
    const titles = {
      approval: "等待你的确认",
      queued: "等待保存秋雨东京.md",
      preparing: "正在准备执行",
      dispatched: "等待工具开始",
      running: "正在写入文件",
      verifying: "正在确认文件结果",
      cleaning: "文件已写入，正在结束操作",
      success: "已完成",
      not_executed: "未执行 · 文件未创建",
      denied: "未执行 · 你已拒绝",
      expired: "未执行 · 确认已过期",
      stopping: "正在停止",
      stopped: "已停止",
      cancelled: "已取消 · 未执行",
      reconciling: "正在核对文件结果",
      unresolved: "文件结果待确认",
      partial: "未完成 · 已产生部分修改",
      revoked: "文件已生成，后续处理已暂停",
      staging: "正在准备保存",
      conflict: "文件已被其他操作修改",
      isolated: "正在独立环境中检查",
      candidate: "修改已准备好",
      search: "正在搜索公开资料",
      not_published: "未保存 · 原文件保持不变",
    };
    const select = async (scenario) => {
      await frame.locator("#scenario").selectOption(scenario);
      await expect(frame.locator("#status strong")).toHaveText(titles[scenario]);
      await frame
        .locator("body")
        .evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
    };
    await expect(frame.locator("#scenario option")).toHaveCount(24);
    const scenarios = await frame
      .locator("#scenario option")
      .evaluateAll((es) => es.map((e) => e.value));
    for (const width of [320, 390, 1024, 1440]) {
      await page.setViewportSize({ width, height: width < 700 ? 844 : 1000 });
      for (const theme of ["dark", "light"]) {
        const current = await frame.locator("html").getAttribute("class");
        if ((current === "light") !== (theme === "light")) await frame.locator("#theme").click();
        for (const scenario of scenarios) {
          await select(scenario);
          await expect(frame.locator("#status strong")).not.toBeEmpty();
          const geometry = await frame.locator("body").evaluate((el) => ({
            viewport: innerWidth,
            scroll: el.scrollWidth,
            transcript: document.querySelector(".transcript").clientWidth,
            transcriptScroll: document.querySelector(".transcript").scrollWidth,
          }));
          expect(geometry.scroll).toBeLessThanOrEqual(geometry.viewport);
          expect(geometry.transcriptScroll).toBeLessThanOrEqual(geometry.transcript);
          checks.push({ width, theme, scenario, horizontalOverflow: false });
        }
        console.log(`布局通过: ${width}px / ${theme}`);
      }
    }
    await frame.locator("#scenario").selectOption("approval");
    await frame.getByRole("button", { name: "允许本次", exact: true }).click();
    await expect(frame.locator("#scenario")).toHaveValue("preparing");
    await select("queued");
    await frame.getByRole("button", { name: "停止等待", exact: true }).click();
    await expect(frame.locator("#scenario")).toHaveValue("cancelled");
    await frame.locator("#scenario").selectOption("approval");
    await frame.getByRole("button", { name: "拒绝", exact: true }).click();
    await expect(frame.locator("#scenario")).toHaveValue("denied");
    await frame.locator("#scenario").selectOption("expired");
    await frame.getByRole("button", { name: "重新确认", exact: true }).click();
    await expect(frame.locator("#scenario")).toHaveValue("approval");
    await frame.locator("#scenario").selectOption("not_executed");
    await frame.getByRole("button", { name: "重试此操作", exact: true }).click();
    await expect(frame.locator("#scenario")).toHaveValue("preparing");
    await frame.locator("#scenario").selectOption("running");
    await frame.getByRole("button", { name: "停止本轮", exact: true }).click();
    await expect(frame.locator("#scenario")).toHaveValue("stopping");
    await expect(frame.locator("#stop")).toBeDisabled();
    await frame.locator("#scenario").selectOption("unresolved");
    await frame.getByRole("button", { name: "检查状态", exact: true }).click();
    await expect(frame.locator("#scenario")).toHaveValue("reconciling");
    await frame.locator("#scenario").selectOption("approval");
    await frame.getByRole("textbox", { name: "消息草稿" }).fill("断线后仍保留的草稿");
    await frame.locator("#offline").check();
    await expect(frame.locator("#connection")).toBeVisible();
    await expect(frame.getByRole("button", { name: "允许本次", exact: true })).toBeDisabled();
    await expect(frame.locator("#stop")).toBeDisabled();
    await frame.getByRole("button", { name: "重新连接", exact: true }).click();
    await expect(frame.getByRole("textbox", { name: "消息草稿" })).toHaveValue(
      "断线后仍保留的草稿",
    );
    await expect(frame.getByRole("button", { name: "允许本次", exact: true })).toBeEnabled();
    await frame.locator("#scenario").selectOption("success");
    await frame.locator(".file").click();
    await expect(frame.locator("#dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(frame.locator("#dialog")).not.toBeVisible();
    await frame.locator("#scenario").selectOption("revoked");
    await expect(frame.locator(".file")).toHaveCount(0);
    await select("conflict");
    await frame.getByRole("button", { name: "查看差异", exact: true }).click();
    await expect(frame.locator("#dialog")).toContainText("应用前重新检查授权与目标版本");
    await page.keyboard.press("Escape");
    await expect(frame.locator("#scenario")).toHaveValue("conflict");
    await select("search");
    await expect(frame.locator(".tool")).toHaveText("web_search");
    await expect(frame.locator(".tool-path")).toHaveText("东京今日天气");
    for (const [scenario, toolName, target] of [
      ["search", "web_search", "东京今日天气"],
      ["isolated", "bash", "运行项目检查"],
    ]) {
      await select(scenario);
      await frame.getByRole("button", { name: "停止本轮", exact: true }).click();
      await expect(frame.locator("#scenario")).toHaveValue("stopping");
      await expect(frame.locator(".tool")).toHaveText(toolName);
      await expect(frame.locator(".tool-path")).toHaveText(target);
      await expect(frame.locator("#timing")).toBeEmpty();
      await expect(frame.locator("#stop")).toBeDisabled();
    }
    await select("not_published");
    await frame.getByRole("button", { name: "重试此操作", exact: true }).click();
    await expect(frame.locator("#scenario")).toHaveValue("staging");
    await select("unresolved");
    await expect(frame.locator("#timing")).not.toContainText("2m");
    await frame.getByRole("textbox", { name: "消息草稿" }).fill("");
    await frame.locator("#theme").click(); // 上面循环最后是浅色，截图改回深色。
    await select("unresolved");
    await page.screenshot({ path: path.join(__dirname, "desktop-unresolved.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await select("approval");
    const allowBox = await frame
      .getByRole("button", { name: "允许本次", exact: true })
      .boundingBox();
    const composerBox = await frame.locator(".composer").boundingBox();
    expect(allowBox.y + allowBox.height).toBeLessThan(composerBox.y);
    await page.screenshot({ path: path.join(__dirname, "mobile-approval.png"), fullPage: true });
    await frame.locator("#open-nav").click();
    await expect(frame.locator("#sidebar")).toBeVisible();
    await frame.locator("#close-nav").click();
    await expect(frame.locator("#sidebar")).not.toBeVisible();
    await select("unresolved");
    await page.screenshot({ path: path.join(__dirname, "mobile-unresolved.png"), fullPage: true });
    await select("queued");
    await page.screenshot({ path: path.join(__dirname, "mobile-file-wait.png"), fullPage: true });
    await select("conflict");
    await page.screenshot({ path: path.join(__dirname, "mobile-conflict.png"), fullPage: true });
    await frame.locator("#theme").click();
    await select("success");
    await page.screenshot({
      path: path.join(__dirname, "mobile-success-light.png"),
      fullPage: true,
    });
    expect(errors).toEqual([]);
    expect(requests).toEqual([]);
    await expect(page.locator("iframe")).toHaveAttribute("sandbox", "allow-scripts");
    await fs.writeFile(
      path.join(__dirname, "verification.json"),
      `${JSON.stringify(
        {
          checkedAt: new Date().toISOString(),
          scope: "静态审核原型；无产品服务、数据库、模型或工具执行",
          browserVersion: browser.version(),
          layoutChecks: checks.length,
          checks,
          interactions: [
            "批准",
            "拒绝",
            "取消排队",
            "重新确认",
            "安全重试样例",
            "停止请求",
            "重新核验",
            "断线禁用操作",
            "草稿保留",
            "文件预览与 Escape",
            "失效权限不显示预览",
            "移动侧栏",
            "版本冲突差异预览",
            "网络工具独立展示",
            "暂存错误重试",
            "核验无固定两分钟",
            "搜索停止保留工具身份",
            "命令停止保留工具身份",
          ],
          pageErrors: errors,
          externalRequests: requests,
          sandbox: "allow-scripts",
        },
        null,
        2,
      )}\n`,
    );
    console.log(`PASS: ${checks.length} 状态/尺寸/主题检查，18 类交互检查，无页面异常或外部请求`);
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
