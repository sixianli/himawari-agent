import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Browser, BrowserType } from "@playwright/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  launchChromium,
  MISSING_BROWSER_MESSAGE,
  PREINSTALLED_CHROMIUM,
} from "../fixtures/chromium-launch.ts";

type LaunchOptions = { executablePath?: string };

function fakeChromium(failures: readonly (Error | null)[]) {
  const calls: LaunchOptions[] = [];
  const browser = { fake: true } as unknown as Browser;
  const type = {
    launch: async (options: LaunchOptions) => {
      calls.push(options);
      const failure = failures[calls.length - 1];
      if (failure) throw failure;
      return browser;
    },
  } as unknown as BrowserType;
  return { type, calls, browser };
}

describe("launchChromium", () => {
  it("pins the Playwright error text and the preinstalled path it relies on", () => {
    expect(MISSING_BROWSER_MESSAGE).toBe("Executable doesn't exist");
    expect(PREINSTALLED_CHROMIUM).toBe("/opt/pw-browsers/chromium");
  });

  let directory = "";
  let preinstalled = "";
  const saved = process.env["HIMAWARI_CHROMIUM_PATH"];
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "himawari-chromium-launch-"));
    preinstalled = path.join(directory, "chromium");
    await writeFile(preinstalled, "");
    delete process.env["HIMAWARI_CHROMIUM_PATH"];
  });
  afterEach(async () => {
    if (saved === undefined) delete process.env["HIMAWARI_CHROMIUM_PATH"];
    else process.env["HIMAWARI_CHROMIUM_PATH"] = saved;
    await rm(directory, { recursive: true });
  });

  it("uses the default browser first and does not touch the preinstalled one", async () => {
    const fake = fakeChromium([null]);
    expect(await launchChromium(fake.type, preinstalled)).toBe(fake.browser);
    expect(fake.calls).toEqual([{}]);
  });

  it("falls back to the preinstalled browser when the default one is missing", async () => {
    const fake = fakeChromium([
      new Error(`browserType.launch: Executable doesn't exist at x`),
      null,
    ]);
    expect(await launchChromium(fake.type, preinstalled)).toBe(fake.browser);
    expect(fake.calls).toEqual([{}, { executablePath: preinstalled }]);
  });

  it("[reverse] does not fall back when a path was configured explicitly", async () => {
    process.env["HIMAWARI_CHROMIUM_PATH"] = "/configured/chrome";
    const fake = fakeChromium([new Error("Executable doesn't exist"), null]);
    await expect(launchChromium(fake.type, preinstalled)).rejects.toThrow(
      "Executable doesn't exist",
    );
    expect(fake.calls).toEqual([{ executablePath: "/configured/chrome" }]);
  });

  it("[reverse] treats an empty configured path as not configured", async () => {
    process.env["HIMAWARI_CHROMIUM_PATH"] = "";
    const fake = fakeChromium([new Error("Executable doesn't exist"), null]);
    await launchChromium(fake.type, preinstalled);
    expect(fake.calls).toEqual([{}, { executablePath: preinstalled }]);
  });

  it("[reverse] rethrows other launch errors without falling back", async () => {
    const fake = fakeChromium([new Error("missing shared library"), null]);
    await expect(launchChromium(fake.type, preinstalled)).rejects.toThrow("missing shared library");
    expect(fake.calls).toEqual([{}]);
  });

  it("[reverse] rethrows the original error when the preinstalled browser does not exist", async () => {
    const fake = fakeChromium([new Error("Executable doesn't exist"), null]);
    await expect(launchChromium(fake.type, path.join(directory, "absent"))).rejects.toThrow(
      MISSING_BROWSER_MESSAGE,
    );
    expect(fake.calls).toEqual([{}]);
  });
});
