import { describe, expect, it } from "vitest";
import { ProductionServiceLifecycle } from "../src/production-service-lifecycle.js";

describe("production service lifecycle", () => {
  it("stops admission and drains all resources before closing dependencies in reverse order", async () => {
    const lifecycle = new ProductionServiceLifecycle();
    const events: string[] = [];
    for (const name of ["repository", "worker", "http"])
      lifecycle.register({
        name,
        stopAccepting: () => {
          events.push(`${name}:stop`);
        },
        drain: () => {
          events.push(`${name}:drain`);
        },
        close: () => {
          events.push(`${name}:close`);
        },
      });
    lifecycle.ready();
    expect(lifecycle.state).toBe("ready");
    const first = lifecycle.shutdown();
    expect(lifecycle.shutdown()).toBe(first);
    await first;
    expect(events).toEqual([
      "http:stop",
      "worker:stop",
      "repository:stop",
      "http:drain",
      "worker:drain",
      "repository:drain",
      "http:close",
      "worker:close",
      "repository:close",
    ]);
    expect(lifecycle.state).toBe("stopped");
  });

  it("cleans up partial startup and continues after shutdown failures", async () => {
    const lifecycle = new ProductionServiceLifecycle();
    const events: string[] = [];
    lifecycle.register({
      name: "repository",
      close: () => {
        events.push("repository");
      },
    });
    lifecycle.register({
      name: "worker",
      stopAccepting: () => {
        throw new Error("stop failure");
      },
      close: () => {
        events.push("worker");
        throw new Error("close failure");
      },
    });
    await expect(lifecycle.shutdown()).rejects.toMatchObject({
      message: "SERVICE_SHUTDOWN_FAILED",
      errors: expect.any(Array),
    });
    expect(events).toEqual(["worker", "repository"]);
    expect(lifecycle.state).toBe("stopped");
    expect(() => lifecycle.ready()).toThrow("SERVICE_LIFECYCLE_NOT_STARTING");
  });

  it("rejects duplicate ownership and registration after startup", () => {
    const lifecycle = new ProductionServiceLifecycle();
    lifecycle.register({ name: "repository", close() {} });
    expect(() => lifecycle.register({ name: "repository", close() {} })).toThrow(
      "SERVICE_LIFECYCLE_DUPLICATE_RESOURCE",
    );
    lifecycle.ready();
    expect(() => lifecycle.register({ name: "http", close() {} })).toThrow(
      "SERVICE_LIFECYCLE_REGISTRATION_CLOSED",
    );
  });
});
