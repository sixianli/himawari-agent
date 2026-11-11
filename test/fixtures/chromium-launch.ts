import { existsSync } from "node:fs";
import type { Browser, BrowserType } from "@playwright/test";

export const PREINSTALLED_CHROMIUM = "/opt/pw-browsers/chromium";

export async function launchChromium(chromium: BrowserType): Promise<Browser> {
  const configuredPath = process.env["HIMAWARI_CHROMIUM_PATH"] || undefined;
  try {
    return await chromium.launch(configuredPath ? { executablePath: configuredPath } : {});
  } catch (error) {
    const missing = error instanceof Error && error.message.includes("Executable doesn't exist");
    if (configuredPath || !missing || !existsSync(PREINSTALLED_CHROMIUM)) throw error;
    return chromium.launch({ executablePath: PREINSTALLED_CHROMIUM });
  }
}
