import { PAYLOAD_UDS_ERROR_CODES, PayloadUdsError } from "@himawari-agent/platform-node";
import { describe, expect, it } from "vitest";
import { BROKER_POLL_GRACE_MS, BrokerPollTolerance } from "../src/broker-poll-tolerance.ts";

const transport = () => new PayloadUdsError(PAYLOAD_UDS_ERROR_CODES.TRANSPORT_UNAVAILABLE, 503);

describe("[POLL-1] a transient broker failure does not cancel a running command", () => {
  it("retries within the grace window and cancels once it has lasted too long", () => {
    let now = 1000;
    const tolerance = new BrokerPollTolerance(() => now);
    expect(tolerance.failed(transport())).toBe("retry_first");
    now += BROKER_POLL_GRACE_MS - 1;
    expect(tolerance.failed(transport())).toBe("retry");
    now += 1;
    expect(tolerance.failed(transport())).toBe("cancel");
  });

  it("starts a new window after a successful poll", () => {
    let now = 0;
    const tolerance = new BrokerPollTolerance(() => now);
    tolerance.failed(transport());
    now += BROKER_POLL_GRACE_MS - 1;
    tolerance.succeeded();
    now += 5;
    expect(tolerance.failed(transport())).toBe("retry_first");
  });

  it("accepts a request deadline as transient", () => {
    const tolerance = new BrokerPollTolerance(() => 0);
    expect(
      tolerance.failed(new PayloadUdsError(PAYLOAD_UDS_ERROR_CODES.DEADLINE_EXCEEDED, 504)),
    ).toBe("retry_first");
  });
});

describe("[POLL-2] a deliberate refusal still cancels at once", () => {
  it.each([
    new PayloadUdsError(PAYLOAD_UDS_ERROR_CODES.HANDLER_FAILED, 503),
    new PayloadUdsError(PAYLOAD_UDS_ERROR_CODES.INSTANCE_REJECTED, 403),
    new Error("SANDBOX_BINDING_LOST"),
    "not an error",
  ])("%s", (error) => {
    const tolerance = new BrokerPollTolerance(() => 0);
    expect(tolerance.failed(error)).toBe("cancel");
  });
});
