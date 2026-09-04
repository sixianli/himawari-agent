import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("tooling host environment boundary", () => {
  it("starts synthetic repository tests without inherited GitHub execution identity", () => {
    expect(process.env.GITHUB_ACTIONS).toBe("false");
    expect(
      Object.entries(process.env).filter(
        ([name, value]) => name.startsWith("GITHUB_") && name !== "GITHUB_ACTIONS" && value,
      ),
    ).toEqual([]);
    expect(process.env.PATH).toBeTruthy();
  });

  it("isolates only tooling workers and preserves the invoking hosted process", () => {
    const script = `
      import config from './vitest.workspace.ts';
      const projects = config.test.projects.map(({ test }) => ({ name: test.name, env: test.env }));
      console.log(JSON.stringify({ projects, host: {
        actions: process.env.GITHUB_ACTIONS,
        sha: process.env.GITHUB_SHA,
        marker: process.env.GITHUB_FUTURE_CONTEXT,
        tools: process.env.HIMAWARI_CI_PYTHON,
      } }));
    `;
    const result = JSON.parse(
      execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_ACTIONS: "true",
          GITHUB_SHA: "a".repeat(40),
          GITHUB_FUTURE_CONTEXT: "synthetic-host-marker",
          HIMAWARI_CI_PYTHON: "/synthetic/locked-python",
        },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    const tooling = result.projects.find(({ name }) => name === "tooling");
    expect(tooling.env).toMatchObject({
      GITHUB_ACTIONS: "false",
      GITHUB_SHA: "",
      GITHUB_FUTURE_CONTEXT: "",
    });
    expect(Object.keys(tooling.env).every((name) => name.startsWith("GITHUB_"))).toBe(true);
    expect(result.projects.filter(({ name }) => name !== "tooling").every(({ env }) => !env)).toBe(
      true,
    );
    expect(result.host).toEqual({
      actions: "true",
      sha: "a".repeat(40),
      marker: "synthetic-host-marker",
      tools: "/synthetic/locked-python",
    });
  });
});
