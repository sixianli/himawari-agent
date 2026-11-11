import { existsSync } from "node:fs";
import type { Browser, BrowserType } from "@playwright/test";

export const PREINSTALLED_CHROMIUM = "/opt/pw-browsers/chromium";
export const MISSING_BROWSER_MESSAGE = "Executable doesn't exist";

export async function launchChromium(
  chromium: BrowserType,
  preinstalledPath: string = PREINSTALLED_CHROMIUM,
): Promise<Browser> {
  const configuredPath = process.env["HIMAWARI_CHROMIUM_PATH"] || undefined;
  try {
    return await chromium.launch(configuredPath ? { executablePath: configuredPath } : {});
  } catch (error) {
    const missing = error instanceof Error && error.message.includes(MISSING_BROWSER_MESSAGE);
    if (configuredPath || !missing || !existsSync(preinstalledPath)) throw error;
    return chromium.launch({ executablePath: preinstalledPath });
  }
}
