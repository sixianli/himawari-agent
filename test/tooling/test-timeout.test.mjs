import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));

function loadConfiguration(value) {
  const env = { ...process.env };
  if (value === undefined) delete env.HIMAWARI_TEST_TIMEOUT_MS;
  else env.HIMAWARI_TEST_TIMEOUT_MS = value;
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import config from './vitest.workspace.ts'; process.stdout.write(JSON.stringify(config.test));",
    ],
    { cwd: root, encoding: "utf8", env },
  );
}

function projectConfiguration(value) {
  const result = loadConfiguration(value);
  expect(result.status, result.stderr).toBe(0);
  const configuration = JSON.parse(result.stdout);
  expect(configuration).not.toHaveProperty("testTimeout");
  expect(configuration).not.toHaveProperty("hookTimeout");
  expect(configuration.projects.length).toBeGreaterThan(1);
  for (const project of configuration.projects) {
    expect(project.test).not.toHaveProperty("hookTimeout");
  }
  return configuration.projects.map(({ test }) => test);
}

describe("cloud test timeout configuration", () => {
  it("keeps the existing defaults when the variable is absent", () => {
    const projects = projectConfiguration(undefined);
    expect(projects.find(({ name }) => name === "integration").testTimeout).toBe(30_000);
    for (const project of projects.filter(({ name }) => name !== "integration")) {
      expect(project).not.toHaveProperty("testTimeout");
    }
  });

  it.each(["1", "30000", "45000", "00030"])(
    "sets only projects without their own timeout for %s",
    (value) => {
      for (const project of projectConfiguration(value)) {
        expect(project.testTimeout).toBe(project.name === "integration" ? 30_000 : Number(value));
      }
    },
  );

  it.each([
    "",
    "0",
    "-1",
    "1.5",
    "abc",
    "NaN",
    "Infinity",
    "1e4",
    "0x10",
    " 30000 ",
    "9007199254740992",
  ])("rejects an invalid timeout during configuration loading: %j", (value) => {
    const result = loadConfiguration(value);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("HIMAWARI_TEST_TIMEOUT_MS");
  });
});
