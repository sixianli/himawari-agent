import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = path.resolve(
  import.meta.dirname,
  "../../scripts/delivery-mode/sync-cloudflare-public-paths.mjs",
);
const realConfig = path.resolve(
  import.meta.dirname,
  "../../scripts/delivery-mode/cloudflare-public-paths.json",
);
const account = "0123456789abcdef0123456789abcdef";
const host = "himawari.example.test";
const cleanups = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()();
});

function listen(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      cleanups.push(() => new Promise((done) => server.close(done)));
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function readBody(request) {
  return new Promise((resolve) => {
    let text = "";
    request.on("data", (chunk) => {
      text += chunk;
    });
    request.on("end", () => resolve(text ? JSON.parse(text) : undefined));
  });
}

function cloudflare(initialApps = [], options = {}) {
  const state = {
    apps: initialApps.map((app) => ({ ...app })),
    policies: [],
    writes: [],
    nextId: 1,
  };
  const prefix = `/client/v4/accounts/${account}/access`;
  const reply = (response, status, result) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        success: status < 400,
        errors: [],
        result,
        result_info: { page: 1, total_pages: 1 },
      }),
    );
  };
  const handler = async (request, response) => {
    if (request.headers.authorization !== "Bearer test-token") return reply(response, 403, null);
    const url = new URL(request.url, "http://x");
    const route = url.pathname.slice(prefix.length);
    const body = await readBody(request);
    if (request.method !== "GET") state.writes.push(`${request.method} ${route}`);
    if (route === "/apps" && request.method === "GET") return reply(response, 200, state.apps);
    if (route === "/policies" && request.method === "GET")
      return reply(response, 200, state.policies);
    if (route === "/policies" && request.method === "POST") {
      const policy = { ...body, id: `policy-${state.nextId++}` };
      state.policies.push(policy);
      return reply(response, 200, policy);
    }
    if (route === "/apps" && request.method === "POST") {
      const app = { ...body, id: `app-${state.nextId++}` };
      if (options.dropDestinations) app.destinations = app.destinations.slice(1);
      state.apps.push(app);
      return reply(response, 200, app);
    }
    const match = /^\/apps\/([^/]+)$/.exec(route);
    if (match) {
      const index = state.apps.findIndex((app) => app.id === match[1]);
      if (index === -1) return reply(response, 404, null);
      if (request.method === "GET") return reply(response, 200, state.apps[index]);
      if (request.method === "PUT") {
        state.apps[index] = { ...body, id: match[1] };
        return reply(response, 200, state.apps[index]);
      }
      if (request.method === "DELETE") {
        state.apps.splice(index, 1);
        return reply(response, 200, { id: match[1] });
      }
    }
    return reply(response, 404, null);
  };
  return { state, handler };
}

function site(state, options = {}) {
  return (request, response) => {
    const requestPath = new URL(request.url, "http://x").pathname.toLowerCase();
    const bypassed = state.apps.some(
      (app) =>
        (app.policies ?? []).some((link) =>
          state.policies.some((policy) => policy.id === link.id && policy.decision === "bypass"),
        ) &&
        (app.destinations ?? []).some((destination) => {
          const appPath = destination.uri.slice(host.length).toLowerCase();
          return (
            appPath !== "" && (requestPath === appPath || requestPath.startsWith(`${appPath}/`))
          );
        }),
    );
    const openRoot = options.rootOpen && requestPath === "/";
    if ((bypassed && !options.neverOpens) || openRoot) {
      response.writeHead(404);
      return response.end();
    }
    response.writeHead(302, {
      location: `https://team.cloudflareaccess.com/cdn-cgi/access/login/${host}`,
    });
    response.end();
  };
}

async function setup({ apps = [], config = {}, apiOptions, siteOptions } = {}) {
  const api = cloudflare(apps, apiOptions);
  const apiOrigin = await listen(api.handler);
  const siteOrigin = await listen(site(api.state, siteOptions));
  const directory = mkdtempSync(path.join(os.tmpdir(), "public-paths-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const configFile = path.join(directory, "config.json");
  writeFileSync(
    configFile,
    JSON.stringify({
      accountId: account,
      hostname: host,
      applicationName: "Himawari app entry (bypass)",
      policyName: "Himawari app entry: everyone",
      paths: ["/.well-known/apple-app-site-association", "/api/device/v1"],
      retireApplications: [],
      ...config,
    }),
  );
  const run = (args = [], token = "test-token") =>
    new Promise((resolve) => {
      execFile(
        process.execPath,
        [script, configFile, ...args],
        {
          env: {
            PATH: process.env.PATH,
            ...(token ? { CLOUDFLARE_ACCESS_TOKEN: token } : {}),
            CLOUDFLARE_API_BASE: `${apiOrigin}/client/v4`,
            HIMAWARI_PUBLIC_PATHS_PROBE_BASE: siteOrigin,
            HIMAWARI_PUBLIC_PATHS_PROBE_ATTEMPTS: "2",
            HIMAWARI_PUBLIC_PATHS_PROBE_DELAY_MS: "10",
          },
        },
        (error, stdout) => resolve({ status: error ? error.code : 0, stdout }),
      );
    });
  return { state: api.state, run };
}

const deviceApp = {
  id: "old-device",
  name: "Himawari device API",
  type: "self_hosted",
  domain: `${host}/api/device/v1`,
  destinations: [{ type: "public", uri: `${host}/api/device/v1` }],
  policies: [],
};
const wholeSite = {
  id: "web",
  name: "Himawari",
  type: "self_hosted",
  domain: host,
  destinations: [{ type: "public", uri: host }],
  policies: [],
};

describe("Cloudflare Access public paths", () => {
  it("creates one bypass policy and one application, then opens the paths and keeps the site gated", async () => {
    const { state, run } = await setup({ apps: [wholeSite] });
    const result = await run();
    expect(result.stdout).toContain("PUBLIC_PATHS_OK");
    expect(result.status).toBe(0);
    expect(state.policies).toEqual([
      expect.objectContaining({ decision: "bypass", include: [{ everyone: {} }] }),
    ]);
    const created = state.apps.find((app) => app.name === "Himawari app entry (bypass)");
    expect(created.destinations.map((item) => item.uri)).toEqual([
      `${host}/.well-known/apple-app-site-association`,
      `${host}/api/device/v1`,
    ]);
    expect(state.apps.find((app) => app.id === "web")).toEqual(wholeSite);
  });

  it("updates the same application on the next run instead of adding another", async () => {
    const { state, run } = await setup();
    await run();
    const writesAfterFirst = state.writes.length;
    const second = await run();
    expect(second.status).toBe(0);
    expect(state.apps.filter((app) => app.name === "Himawari app entry (bypass)")).toHaveLength(1);
    expect(state.policies).toHaveLength(1);
    expect(state.writes.slice(writesAfterFirst)).toEqual([expect.stringMatching(/^PUT \/apps\//)]);
  });

  it("refuses to touch anything while another application guards one of the paths", async () => {
    const { state, run } = await setup({ apps: [wholeSite, deviceApp] });
    const result = await run();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "PUBLIC_PATHS_FAILED CONFLICTING_APPLICATION Himawari device API",
    );
    expect(state.writes).toEqual([]);
  });

  it("deletes an application listed for retirement before opening its path", async () => {
    const { state, run } = await setup({
      apps: [wholeSite, deviceApp],
      config: { retireApplications: ["Himawari device API"] },
    });
    const result = await run();
    expect(result.status).toBe(0);
    expect(state.writes[0]).toBe("DELETE /apps/old-device");
    expect(state.apps.map((app) => app.name)).toEqual(["Himawari", "Himawari app entry (bypass)"]);
  });

  it("only reports the plan with --plan", async () => {
    const { state, run } = await setup();
    const result = await run(["--plan"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PUBLIC_PATHS_PLAN {"managed":"create"');
    expect(state.writes).toEqual([]);
  });

  it("rejects a path that would open the whole site", async () => {
    const { state, run } = await setup({ config: { paths: ["/"] } });
    const result = await run();
    expect(result.stdout).toContain("PUBLIC_PATHS_FAILED CONFIG_PATH_OPENS_WHOLE_SITE");
    expect(state.writes).toEqual([]);
  });

  it("fails without a token", async () => {
    const { run } = await setup();
    const result = await run([], "");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("PUBLIC_PATHS_FAILED TOKEN_MISSING");
  });

  it("fails when the saved application does not read back with every path", async () => {
    const { run } = await setup({ apiOptions: { dropDestinations: true } });
    const result = await run();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("PUBLIC_PATHS_FAILED READBACK_MISMATCH");
  });

  it("fails when a path is still sent to the Access login after saving", async () => {
    const { run } = await setup({ siteOptions: { neverOpens: true } });
    const result = await run();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "PUBLIC_PATHS_FAILED PATH_STILL_GATED /.well-known/apple-app-site-association",
    );
  });

  it("fails when the rest of the site is no longer behind the Access login", async () => {
    const { run } = await setup({ siteOptions: { rootOpen: true } });
    const result = await run();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("PUBLIC_PATHS_FAILED GATE_OPEN /");
  });

  it("keeps the checked-in configuration valid and limited to app paths", () => {
    const config = JSON.parse(readFileSync(realConfig, "utf8"));
    expect(config.paths.length).toBeGreaterThan(0);
    for (const entry of config.paths) {
      expect(entry).toMatch(/^\/[^?#*\s]+$/);
    }
  });
});
