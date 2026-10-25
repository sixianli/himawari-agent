import type { TestProject } from "vitest/node";
import { prepareSharedNodeRuntime, removeSharedRuntime } from "../fixtures/shared-node-runtime.ts";

export default async function setup(
  project: TestProject,
): Promise<(() => Promise<void>) | undefined> {
  const artifact = process.env["HIMAWARI_TEST_ARTIFACT"];
  const context = process.env["HIMAWARI_TEST_CONTEXT"];
  if (!artifact || !context) return;
  const shared = await prepareSharedNodeRuntime({ artifact, context });
  project.provide("sharedNodeRuntime", shared);
  return async () => {
    await removeSharedRuntime(shared);
  };
}
