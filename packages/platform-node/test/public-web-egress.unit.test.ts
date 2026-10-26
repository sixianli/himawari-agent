import { once } from "node:events";
import { createServer, type Server } from "node:net";
import { fetch } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { createPublicWebDispatcher } from "../src/index.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function listener() {
  const server = createServer((socket) => socket.destroy());
  const accepted: number[] = [];
  server.on("connection", () => accepted.push(Date.now()));
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { port: address.port, accepted };
}

async function failureCode(request: Promise<unknown>) {
  const error = await request.then(
    () => undefined,
    (caught: unknown) => caught as { cause?: { code?: string } },
  );
  return error?.cause?.code;
}

describe("[NL-2] service-process web egress guard", () => {
  it("refuses a target outside the provider allowlist before connecting", async () => {
    const { port, accepted } = await listener();
    const dispatcher = createPublicWebDispatcher({
      allowedTargets: ["mcp.exa.ai:443"],
      isPublicAddress: () => true,
    });
    expect(await failureCode(fetch(`https://localhost:${port}/`, { dispatcher }))).toBe(
      "WEB_EGRESS_TARGET_DENIED",
    );
    expect(accepted).toHaveLength(0);
  });

  it("refuses plain http even for an allowed host and port", async () => {
    const { port, accepted } = await listener();
    const dispatcher = createPublicWebDispatcher({
      allowedTargets: [`localhost:${port}`],
      isPublicAddress: () => true,
    });
    expect(await failureCode(fetch(`http://localhost:${port}/`, { dispatcher }))).toBe(
      "WEB_EGRESS_TARGET_DENIED",
    );
    expect(accepted).toHaveLength(0);
  });

  it("refuses an allowed host whose address is not public before connecting", async () => {
    const { port, accepted } = await listener();
    const dispatcher = createPublicWebDispatcher({
      allowedTargets: [`localhost:${port}`],
      isPublicAddress: () => false,
    });
    expect(await failureCode(fetch(`https://localhost:${port}/`, { dispatcher }))).toBe(
      "WEB_EGRESS_ADDRESS_DENIED",
    );
    expect(accepted).toHaveLength(0);
  });

  it("connects to an allowed https target whose addresses are all public", async () => {
    const { port, accepted } = await listener();
    const seen: string[] = [];
    const dispatcher = createPublicWebDispatcher({
      allowedTargets: [`localhost:${port}`],
      isPublicAddress: (address) => {
        seen.push(address);
        return true;
      },
    });
    await fetch(`https://localhost:${port}/`, { dispatcher }).catch(() => undefined);
    expect(seen.length).toBeGreaterThan(0);
    expect(accepted.length).toBeGreaterThan(0);
  });
});
