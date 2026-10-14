import type { TestProject } from "vitest/node";
import { prepareSharedNodeRuntime, removeSharedRuntime } from "../fixtures/shared-node-runtime.ts";

/**
 * [R2-T8] Install the Node runtime once for the whole integration run and hand the sealed,
 * read-only tree to every test file. The runtime travels through `provide`/`inject` only.
 * A run without an artifact keeps the previous per-file behaviour.
 */
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
