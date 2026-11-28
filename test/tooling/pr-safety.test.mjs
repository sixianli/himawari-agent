import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAreas, safetySection } from "../../scripts/check-pr-safety.mjs";

const roots = [];
const servers = [];
afterEach(async () => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const server of servers.splice(0)) await new Promise((done) => server.close(done));
});

const SCRIPTS = [
  "scripts/check-pr-safety.mjs",
  "scripts/check-incident-gates.mjs",
  "scripts/check-incident-runs.mjs",
];
const identity = ["-c", "user.name=test", "-c", "user.email=test@example.invalid"];
const git = (cwd, args) => execFileSync("git", [...identity, ...args], { cwd, encoding: "utf8" });

function write(root, file, text) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
}

function repository() {
  const root = mkdtempSync(join(tmpdir(), "pr-safety-"));
  roots.push(root);
  for (const script of SCRIPTS) {
    mkdirSync(dirname(join(root, script)), { recursive: true });
    copyFileSync(script, join(root, script));
  }
  write(
    root,
    "ci/core-areas.json",
    JSON.stringify({ areas: [{ name: "记忆系统", paths: ["packages/memory/"] }] }),
  );
  write(root, "packages/memory/src/store.ts", "export const a = 1;\n");
  write(root, "packages/memory/test/store.test.ts", "");
  write(root, "docs/notes.md", "笔记\n");
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "base"]);
  return { root, base: git(root, ["rev-parse", "HEAD"]).trim() };
}

function change(root, file) {
  write(root, file, `${Math.random()}\n`);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "change"]);
  return git(root, ["rev-parse", "HEAD"]).trim();
}

async function github(body) {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/repos/owner/name/pulls/7") response.end(JSON.stringify({ body }));
    else {
      response.statusCode = 404;
      response.end("{}");
    }
  });
  servers.push(server);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${server.address().port}`;
}

function check(root, api, base, head) {
  const event = join(root, "event.json");
  writeFileSync(
    event,
    JSON.stringify({ pull_request: { number: 7, base: { sha: base }, head: { sha: head } } }),
  );
  return new Promise((done) => {
    const child = spawn("node", [join(root, "scripts/check-pr-safety.mjs")], {
      cwd: root,
      env: {
        ...process.env,
        GITHUB_API_URL: api,
        GITHUB_REPOSITORY: "owner/name",
        GITHUB_EVENT_PATH: event,
        GH_TOKEN: "",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
}

describe("a PR that changes a core area says why it is safe and names a test CI runs", () => {
  it("refuses a core change whose description has no safety section", async () => {
    const { root, base } = repository();
    const head = change(root, "packages/memory/src/store.ts");
    const result = await check(root, await github("## 为什么\n\n改记忆"), base, head);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("PR_SAFETY_MISSING areas=记忆系统");
    expect(result.stderr).toContain("PR_SAFETY_HELP");
  });

  it("refuses a safety section that names no test file, or one that does not exist", async () => {
    const { root, base } = repository();
    const head = change(root, "packages/memory/src/store.ts");
    const vague = await check(root, await github("## 安全依据\n\n跑过了，没问题"), base, head);
    expect(vague.status).toBe(1);
    expect(vague.stderr).toContain("PR_SAFETY_TEST_MISSING areas=记忆系统 named=none");
    const missing = await check(
      root,
      await github("## 安全依据\n\n`packages/memory/test/gone.test.ts` 覆盖了"),
      base,
      head,
    );
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("named=packages/memory/test/gone.test.ts");
    const notTest = await check(
      root,
      await github("## 安全依据\n\n见 `docs/notes.md`"),
      base,
      head,
    );
    expect(notTest.status).toBe(1);
  });

  it("passes a core change that names an existing test file", async () => {
    const { root, base } = repository();
    const head = change(root, "packages/memory/src/store.ts");
    const body =
      "## 安全依据\n\n只改了读路径，`packages/memory/test/store.test.ts` 覆盖了。\n\n## 验证\n";
    const result = await check(root, await github(body), base, head);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PR_SAFETY_CORE pr=7 areas=记忆系统");
  });

  it("does not ask a PR outside the core areas for anything", async () => {
    const { root, base } = repository();
    const head = change(root, "docs/notes.md");
    const result = await check(root, "http://127.0.0.1:9", base, head);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PR_SAFETY_NOT_CORE pr=7");
  });

  it("fails closed when GitHub cannot be read for a core change", async () => {
    const { root, base } = repository();
    const head = change(root, "packages/memory/src/store.ts");
    const result = await check(root, "http://127.0.0.1:9", base, head);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("PR_SAFETY failed");
  });

  it("refuses a core-area path that matches no file, so the list cannot go stale", () => {
    const { root } = repository();
    write(
      root,
      "ci/core-areas.json",
      JSON.stringify({ areas: [{ name: "记忆系统", paths: ["packages/old-memory/"] }] }),
    );
    expect(readAreas(root).errors).toEqual([
      'PR_SAFETY_AREA_PATH_MATCHES_NOTHING area="记忆系统" path=packages/old-memory/',
    ]);
  });

  it("the repository's own core-area list matches real files", () => {
    expect(readAreas(".").errors).toEqual([]);
  });

  it("reads only the safety section", () => {
    expect(safetySection("## 为什么\n`a.test.ts`\n## 安全依据\n`b.test.ts`\n## 验证\n")).toBe(
      "`b.test.ts`",
    );
    expect(safetySection("安全依据 `b.test.ts`")).toBeUndefined();
  });

  it("CI runs it in ci/required on pull requests", () => {
    expect(readFileSync(".github/workflows/ci.yml", "utf8")).toContain(
      'run: if [ "$GITHUB_EVENT_NAME" = pull_request ]; then node scripts/check-pr-safety.mjs; fi',
    );
  });
});
