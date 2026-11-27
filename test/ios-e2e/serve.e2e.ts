import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { it } from "vitest";
import { startE2eBackend } from "./backend.ts";

it("serves the iPhone end-to-end tests until told to stop", async () => {
  const ready = process.env["HIMAWARI_IOS_E2E_READY"];
  const stop = process.env["HIMAWARI_IOS_E2E_STOP"];
  if (!ready || !stop) throw new Error("IOS_E2E_READY_AND_STOP_REQUIRED");
  const backend = await startE2eBackend();
  await writeFile(
    ready,
    `${JSON.stringify({ origin: backend.origin, control: backend.controlOrigin, ca: backend.caPath })}\n`,
  );
  while (!existsSync(stop)) await delay(500);
  await backend.close();
});
