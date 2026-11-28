import type { DeviceConnectionsPort } from "@himawari-agent/platform-node";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Harness,
  harness,
  type PairedClient,
  pairAndConfirm,
  removeDeviceHarnessDirectories,
  send,
  signedRequest,
} from "../fixtures/device-api-harness.ts";

afterEach(async () => {
  await removeDeviceHarnessDirectories();
});

function recordingGmail() {
  const begun: { deviceId: string; connection: string; callbackScheme: string }[] = [];
  const completed: { deviceId: string; state: string }[] = [];
  const disconnected: string[] = [];
  const added: Record<string, unknown>[] = [];
  const removed: string[] = [];
  const port: DeviceConnectionsPort = {
    list: async () => [
      {
        name: "gmail",
        title: "Gmail",
        status: "connected",
        account: "andy@example.com",
        connectedAt: "2026-11-26T08:00:00.000Z",
        added: false,
      },
    ],
    begin: async (input) => {
      begun.push({ ...input });
      if (input.connection !== "gmail") return undefined;
      return { kind: "browser", authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth" };
    },
    complete: async (input) => {
      completed.push({ ...input });
      return "connected";
    },
    disconnect: async ({ connection }) => {
      if (connection !== "github") return undefined;
      disconnected.push(connection);
      return true;
    },
    add: async (input) => {
      added.push({ ...input });
      return {
        outcome: "added",
        connection: {
          name: "app_0a1b2c3d4e5f",
          title: input.title ?? "Linear",
          status: "disconnected",
          account: null,
          connectedAt: null,
          added: true,
        },
      };
    },
    remove: async ({ connection }) => {
      if (!connection.startsWith("app_")) return undefined;
      removed.push(connection);
      return true;
    },
  };
  return { port, begun, completed, disconnected, added, removed };
}

async function confirmedPost(h: Harness, client: PairedClient, path: string, body: unknown) {
  const challenge = (
    await send(
      h,
      signedRequest(h, client, {
        method: "POST",
        path: "/api/device/v1/approvals/challenge",
        body: "{}",
      }),
    )
  ).json() as { challenge: string };
  const response = await send(
    h,
    signedRequest(h, client, {
      method: "POST",
      path: `/api/device/v1/${path}`,
      body: JSON.stringify(body),
      confirmKey: client.confirmKeys.privateKey,
      nonce: challenge.challenge,
    }),
  );
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

async function post(h: Harness, client: PairedClient, path: string, body: unknown) {
  const response = await send(
    h,
    signedRequest(h, client, {
      method: "POST",
      path: `/api/device/v1/${path}`,
      body: JSON.stringify(body),
    }),
  );
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

describe("[PG-12] the iPhone asks the server for the Gmail sign-in page", () => {
  it("hands the signed device and its callback scheme to Gmail, and returns the outcome of finishing", async () => {
    const gmail = recordingGmail();
    const h = await harness({ connections: gmail.port });
    const client = await pairAndConfirm(h);

    expect(await post(h, client, "connections/list", {})).toEqual({
      status: 200,
      body: {
        connections: [
          {
            name: "gmail",
            title: "Gmail",
            status: "connected",
            account: "andy@example.com",
            connectedAt: "2026-11-26T08:00:00.000Z",
            added: false,
          },
        ],
      },
    });
    const started = await post(h, client, "connections/authorization", {
      connection: "gmail",
      callbackScheme: "win.siyi.himawari.app",
    });
    expect(started).toEqual({
      status: 200,
      body: { kind: "browser", authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth" },
    });
    const finished = await post(h, client, "connections/authorization/complete", {
      state: "AbCdEfGhIjKlMnOpQrStUvWx",
    });
    expect(finished).toEqual({ status: 200, body: { outcome: "connected" } });
    expect(gmail.begun).toEqual([
      { deviceId: client.deviceId, connection: "gmail", callbackScheme: "win.siyi.himawari.app" },
    ]);
    expect(gmail.completed).toEqual([
      { deviceId: client.deviceId, state: "AbCdEfGhIjKlMnOpQrStUvWx" },
    ]);
    expect(await post(h, client, "connections/disconnect", { connection: "github" })).toEqual({
      status: 200,
      body: { disconnected: true },
    });
    expect(gmail.disconnected).toEqual(["github"]);
  });

  it("[reverse] refuses web schemes, malformed states, extra fields and unsigned requests, and never reaches Gmail", async () => {
    const gmail = recordingGmail();
    const h = await harness({ connections: gmail.port });
    const client = await pairAndConfirm(h);

    for (const callbackScheme of [
      "https",
      "http",
      "javascript",
      "himawari",
      "Win.Siyi.Himawari",
      "win.siyi.himawari:",
      "win..himawari",
      `a.${"b".repeat(200)}`,
      42,
    ])
      expect(
        (
          await post(h, client, "connections/authorization", {
            connection: "gmail",
            callbackScheme,
          })
        ).status,
      ).toBe(400);
    expect(
      (
        await post(h, client, "connections/authorization", {
          connection: "gmail",
          callbackScheme: "win.siyi.himawari.app",
          redirect: "https://evil.example",
        })
      ).status,
    ).toBe(400);
    for (const state of ["short", "has space in it 000000", "", 7])
      expect((await post(h, client, "connections/authorization/complete", { state })).status).toBe(
        400,
      );

    const unsigned = await h.app.inject({
      method: "POST",
      url: "/api/device/v1/connections/authorization",
      headers: { host: new URL(h.origin).host, "content-type": "application/json" },
      payload: JSON.stringify({ connection: "gmail", callbackScheme: "win.siyi.himawari.app" }),
    });
    expect(unsigned.statusCode).toBe(401);
    for (const connection of ["Gmail", "gmail/x", "", 1])
      expect(
        (
          await post(h, client, "connections/authorization", {
            connection,
            callbackScheme: "win.siyi.himawari.app",
          })
        ).status,
      ).toBe(400);
    for (const connection of ["GitHub", "", 3])
      expect((await post(h, client, "connections/disconnect", { connection })).status).toBe(400);
    expect(
      (await post(h, client, "connections/disconnect", { connection: "github", force: true }))
        .status,
    ).toBe(400);
    expect(
      (await post(h, client, "connections/disconnect", { connection: "dropbox" })).status,
    ).toBe(404);
    expect(gmail.begun).toEqual([]);
    expect(gmail.completed).toEqual([]);
    expect(gmail.disconnected).toEqual([]);
    const unknown = await post(h, client, "connections/authorization", {
      connection: "dropbox",
      callbackScheme: "win.siyi.himawari.app",
    });
    expect(unknown.status).toBe(404);
  });

  it("[reverse] a server without Gmail set up does not offer the sign-in page", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const started = await post(h, client, "connections/authorization", {
      connection: "gmail",
      callbackScheme: "win.siyi.himawari.app",
    });
    expect(started.status).toBe(404);
    expect((await post(h, client, "connections/list", {})).status).toBe(404);
  });
});

describe("[CONN-ADD-1] the iPhone adds any remote MCP app by its address", () => {
  it("adds an app only with Face ID, passes the address and the optional client to the server, and removes it without Face ID", async () => {
    const gmail = recordingGmail();
    const h = await harness({ connections: gmail.port });
    const client = await pairAndConfirm(h);

    const added = await confirmedPost(h, client, "connections/add", {
      serverUrl: " https://mcp.linear.app/mcp ",
      title: "Linear",
      clientId: "client-1",
      clientSecret: "secret-1",
    });
    expect(added).toEqual({
      status: 200,
      body: {
        outcome: "added",
        connection: {
          name: "app_0a1b2c3d4e5f",
          title: "Linear",
          status: "disconnected",
          account: null,
          connectedAt: null,
          added: true,
        },
      },
    });
    expect(gmail.added).toEqual([
      {
        serverUrl: "https://mcp.linear.app/mcp",
        title: "Linear",
        clientId: "client-1",
        clientSecret: "secret-1",
      },
    ]);
    expect(await post(h, client, "connections/remove", { connection: "app_0a1b2c3d4e5f" })).toEqual(
      { status: 200, body: { removed: true } },
    );
    expect(gmail.removed).toEqual(["app_0a1b2c3d4e5f"]);
  });

  it("[reverse] without Face ID, without an address, with a secret but no client ID or with extra fields nothing is added", async () => {
    const gmail = recordingGmail();
    const h = await harness({ connections: gmail.port });
    const client = await pairAndConfirm(h);

    expect(
      await post(h, client, "connections/add", { serverUrl: "https://mcp.linear.app/mcp" }),
    ).toEqual({ status: 403, body: { code: "DEVICE_OWNER_PRESENCE_REQUIRED" } });
    for (const body of [
      {},
      { serverUrl: "   " },
      { serverUrl: 7 },
      { serverUrl: "https://mcp.linear.app/mcp", clientSecret: "secret-1" },
      { serverUrl: "https://mcp.linear.app/mcp", headers: { authorization: "x" } },
      { serverUrl: `https://mcp.linear.app/${"a".repeat(2050)}` },
    ])
      expect((await confirmedPost(h, client, "connections/add", body)).status).toBe(400);
    expect(gmail.added).toEqual([]);
    expect((await post(h, client, "connections/remove", { connection: "github" })).status).toBe(
      404,
    );
    expect((await post(h, client, "connections/remove", { connection: "App 1" })).status).toBe(400);
    expect(gmail.removed).toEqual([]);
  });
});
