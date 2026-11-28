import { describe, expect, it } from "vitest";
import {
  mainSubthreadDescriptors,
  subthreadSideDescriptors,
} from "../src/production-subthreads.ts";
import { threadTaskDescriptors } from "../src/production-thread-tasks.ts";

const kept = (descriptors: readonly { readonly name: string }[]) =>
  descriptors
    .filter(
      (descriptor) => "contextRetention" in descriptor && descriptor.contextRetention === "keep",
    )
    .map(({ name }) => name)
    .sort();

describe("results that old-tool-result clearing never removes", () => {
  it("keeps every plan tool's result", () => {
    const descriptors = threadTaskDescriptors();
    expect(descriptors.length).toBeGreaterThan(0);
    expect(kept(descriptors)).toEqual(descriptors.map(({ name }) => name).sort());
  });

  it("keeps what a subthread handed back and what the main thread read of it", () => {
    expect(kept(subthreadSideDescriptors())).toEqual(["return_result"]);
    expect(kept(mainSubthreadDescriptors())).toEqual(["view_subthread"]);
  });

  it("REVERSE: does not keep the results of tools that only act", () => {
    const names = [...mainSubthreadDescriptors(), ...subthreadSideDescriptors()].map(
      ({ name }) => name,
    );
    expect(names).toEqual(expect.arrayContaining(["open_subthread", "tell_main"]));
    expect(kept(mainSubthreadDescriptors())).not.toContain("open_subthread");
    expect(kept(subthreadSideDescriptors())).not.toContain("tell_main");
  });
});
