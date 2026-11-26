import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
} from "@himawari-agent/persistence-sqlite";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  proportion,
  resolveWindow,
  wilsonInterval,
} from "../../scripts/calibration-report/calibration.mjs";
import { parseArguments, run } from "../../scripts/calibration-report/report.mjs";

const NOW = new Date("2026-11-02T03:00:00.000Z");
const IN_WINDOW = "2026-10-29T03:00:00.000Z";
const BEFORE_WINDOW = "2026-10-25T03:00:00.000Z";
const END = "2026-11-02";

describe("[P0-7] calibration report", () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function fixture() {
    const root = await mkdtemp(path.join(tmpdir(), "himawari-calibration-"));
    directories.push(root);
    const databasePath = path.join(root, "product.sqlite");
    const database = openQualifiedDatabase(databasePath);
    applyMigrations(database, await loadBundledMigrations());
    database.prepare("INSERT INTO owners (id, revision) VALUES ('o', 0)").run();
    database.prepare("INSERT INTO agents (id, owner_id, revision) VALUES ('a', 'o', 0)").run();
    return { root, databasePath, database };
  }

  let counter = 0;
  function addMemoryDecision(
    database: Database.Database,
    kind: string,
    outcome: string,
    rating: string | null,
    checkedAt = IN_WINDOW,
  ) {
    counter += 1;
    database
      .prepare(
        `INSERT INTO decision_ledger (
          id, owner_id, agent_id, kind, checked_at, counts, outcome, reason_code, inputs,
          cost_micros, duration_ms, owner_rating, rated_at
        ) VALUES (?, 'o', 'a', ?, ?, '{}', ?, 'fixture', '{}', 0, 0, ?, ?)`,
      )
      .run(`d${counter}`, kind, checkedAt, outcome, rating, rating === null ? null : checkedAt);
  }

  function addProactive(
    database: Database.Database,
    verdict: "pushed" | "silent",
    rating: string | null,
    checkedAt = IN_WINDOW,
  ) {
    counter += 1;
    database
      .prepare(
        `INSERT INTO decision_ledger (
          id, owner_id, agent_id, kind, scenario, checked_at, counts, verdict, reason_code, inputs,
          cost_micros, duration_ms, owner_rating, rated_at
        ) VALUES (?, 'o', 'a', 'proactive', 'gmail', ?, '{}', ?, 'fixture', '{}', 0, 0, ?, ?)`,
      )
      .run(`p${counter}`, checkedAt, verdict, rating, rating === null ? null : checkedAt);
  }

  function capture() {
    const chunks: string[] = [];
    return {
      write: (chunk: string) => chunks.push(chunk) > 0,
      text: () => chunks.join(""),
    };
  }

  it("matches the hand computed rates and intervals on constructed data", async () => {
    const { root, databasePath, database } = await fixture();
    for (const rating of ["useful", "useful", "useful", "useful", "useful", "useful"])
      addProactive(database, "pushed", rating);
    for (const rating of ["unneeded", "unneeded", "unneeded", "unneeded"])
      addProactive(database, "pushed", rating);
    addProactive(database, "pushed", null);
    for (const rating of ["useful", "useful", "missed"]) addProactive(database, "silent", rating);
    addProactive(database, "pushed", "useful", BEFORE_WINDOW);
    for (const rating of ["useful", "unneeded", "useful"])
      addMemoryDecision(database, "consolidation", "merge", rating);
    addMemoryDecision(database, "retrieval_degrade", "degraded", null);
    addMemoryDecision(database, "retrieval_degrade", "degraded", null);
    database.close();

    const output = capture();
    const result = run([`--db=${databasePath}`, `--end=${END}`, "--no-record"], {
      now: NOW,
      output,
      root,
    });
    const pushed = result.decisions.find((row) => row.group === "proactive_pushed");
    expect(pushed).toMatchObject({ total: 11, rated: 10, useful: 6, unneeded: 4, missed: 0 });
    const round = (value: number | null) => Math.round((value as number) * 1000) / 10;
    expect([
      round(pushed?.rates.useful?.value ?? null),
      round(pushed?.rates.useful?.low ?? null),
      round(pushed?.rates.useful?.high ?? null),
    ]).toEqual([60, 31.3, 83.2]);
    expect([
      round(pushed?.rates.unneeded?.value ?? null),
      round(pushed?.rates.unneeded?.low ?? null),
      round(pushed?.rates.unneeded?.high ?? null),
    ]).toEqual([40, 16.8, 68.7]);
    expect(pushed?.rates.missed).toBeNull();
    const silent = result.decisions.find((row) => row.group === "proactive_silent");
    expect(silent).toMatchObject({ total: 3, rated: 3, useful: 2, missed: 1 });
    expect(silent?.rates.unneeded).toBeNull();
    const text = output.text();
    expect(text).toContain(
      "| 读完邮件提醒了你 | 11 | 10 | 提醒得对 60.0%（6/10，95% 区间 31.3%–83.2%）；不该提醒 40.0%（4/10，95% 区间 16.8%–68.7%） |",
    );
    expect(text).toContain("| 读完邮件没提醒 | 3 | 3 | 样本不足（3 条） |");
    expect(text).toContain("| 整理记忆 | 3 | 3 | 样本不足（3 条） |");
    expect(text).toContain("| 记忆搜索没生效 | 2 | 0 | 样本不足（0 条） |");
    expect(text).not.toContain("不适用");
    expect(text).not.toContain("| consolidation | 3 | 3 | 0");
    expect(text).not.toContain("Muse");
  });

  it("says insufficient sample instead of 0% when nothing is rated, and lowering the threshold shows the rate", async () => {
    const { root, databasePath, database } = await fixture();
    for (let index = 0; index < 8; index += 1)
      addMemoryDecision(database, "memory_candidate", "kept", null);
    database.close();
    const output = capture();
    run([`--db=${databasePath}`, `--end=${END}`, "--no-record"], { now: NOW, output, root });
    expect(output.text()).toContain("| 已存的记忆 | 8 | 0 | 样本不足（0 条） |");
    expect(output.text()).not.toMatch(/\b0(\.0)?%/u);

    const empty = capture();
    const emptyFixture = await fixture();
    emptyFixture.database.close();
    run([`--db=${emptyFixture.databasePath}`, `--end=${END}`, "--no-record"], {
      now: NOW,
      output: empty,
      root: emptyFixture.root,
    });
    expect(empty.text()).toContain("这一周没有决策记录。");
  });

  it("appends one history line per changed measurement and compares with the earlier week", async () => {
    const { root, databasePath, database } = await fixture();
    for (let index = 0; index < 5; index += 1)
      addMemoryDecision(database, "memory_candidate", "kept", "useful", "2026-10-22T03:00:00.000Z");
    for (let index = 0; index < 5; index += 1)
      addMemoryDecision(database, "memory_candidate", "kept", index < 4 ? "useful" : "unneeded");
    database.close();
    const history = path.join(root, "history.jsonl");
    const base = [
      `--db=${databasePath}`,
      `--history=${history}`,
      `--out-dir=${path.join(root, "reports")}`,
    ];
    run([...base, "--end=2026-10-26"], { now: NOW, output: capture(), root });
    const output = capture();
    run([...base, `--end=${END}`], { now: NOW, output, root });
    expect(output.text()).toContain("已存的记忆 存对了：100.0% → 80.0%");
    const again = capture();
    run([...base, `--end=${END}`], { now: NOW, output: again, root });
    expect(again.text()).toContain("没有重复追加");
    const lines = (await readFile(history, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({
      schema: "himawari-calibration-week.v5",
      ownerId: "o",
      window: { start: "2026-10-25T15:00:00.000Z", end: "2026-11-01T15:00:00.000Z" },
      groups: [{ group: "memory_kept", total: 5, rated: 5, useful: 4, unneeded: 1, missed: 0 }],
    });
    expect(lines[1]).not.toHaveProperty("muse");
    expect(await readFile(path.join(root, "reports", "2026-11-02.md"), "utf8")).toContain(
      "# 校准周报",
    );
  });

  it("includes a decision at the window start and excludes one at the end", async () => {
    const { root, databasePath, database } = await fixture();
    addMemoryDecision(database, "memory_candidate", "kept", "useful", "2026-10-25T15:00:00.000Z");
    addMemoryDecision(database, "memory_candidate", "kept", "useful", "2026-11-01T14:59:59.999Z");
    addMemoryDecision(database, "memory_candidate", "kept", "useful", "2026-10-25T14:59:59.999Z");
    addMemoryDecision(database, "memory_candidate", "kept", "useful", "2026-11-01T15:00:00.000Z");
    database.close();
    const result = run([`--db=${databasePath}`, `--end=${END}`, "--no-record"], {
      now: NOW,
      output: capture(),
      root,
    });
    expect(result.decisions.find((row) => row.group === "memory_kept")).toMatchObject({
      total: 2,
      rated: 2,
    });
  });

  it("skips a damaged history line without touching the file, and refuses a half given scope or a timestamp it cannot window", async () => {
    const { root, databasePath, database } = await fixture();
    addMemoryDecision(database, "memory_candidate", "kept", "useful");
    database.close();
    const history = path.join(root, "history.jsonl");
    await writeFile(history, '{"schema":"himawari-calibration-week.v1","oops\n');
    const output = capture();
    run(
      [
        `--db=${databasePath}`,
        `--history=${history}`,
        `--out-dir=${path.join(root, "reports")}`,
        `--end=${END}`,
      ],
      {
        now: NOW,
        output,
        root,
      },
    );
    expect(output.text()).toContain("历史记录第 1 行不是有效的 JSON，已跳过");
    const lines = (await readFile(history, "utf8")).split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('{"schema":"himawari-calibration-week.v1","oops');
    expect(() =>
      run([`--db=${databasePath}`, "--owner=o", "--no-record"], {
        now: NOW,
        output: capture(),
        root,
      }),
    ).toThrow(/CALIBRATION_SCOPE/u);

    const odd = await fixture();
    addMemoryDecision(
      odd.database,
      "memory_candidate",
      "kept",
      "useful",
      "2026-10-30T12:00:00+09:00",
    );
    odd.database.close();
    expect(() =>
      run([`--db=${odd.databasePath}`, `--end=${END}`, "--no-record"], {
        now: NOW,
        output: capture(),
        root: odd.root,
      }),
    ).toThrow(/CALIBRATION_TIMESTAMP_FORMAT/u);
  });

  it("refuses unknown options, an unreadable window and an ambiguous owner", async () => {
    expect(() => parseArguments(["--db=x", "--oops"])).toThrow(/CALIBRATION_UNKNOWN_OPTION/u);
    expect(() => parseArguments([])).toThrow(/CALIBRATION_DB_REQUIRED/u);
    expect(() => resolveWindow({ end: "11/02" })).toThrow(/CALIBRATION_WINDOW_END/u);
    expect(() => resolveWindow({ end: "2026-02-30" })).toThrow(/CALIBRATION_WINDOW_END/u);
    expect(() => resolveWindow({ days: 0 })).toThrow(/CALIBRATION_WINDOW_DAYS/u);
    expect(wilsonInterval(0, 0)).toBeNull();
    expect(proportion(0, 4, 5).value).toBeNull();
    const { root, databasePath, database } = await fixture();
    database.prepare("INSERT INTO agents (id, owner_id, revision) VALUES ('b', 'o', 0)").run();
    addMemoryDecision(database, "memory_candidate", "kept", "useful");
    database
      .prepare(
        `INSERT INTO decision_ledger (
          id, owner_id, agent_id, kind, checked_at, counts, outcome, reason_code, inputs,
          cost_micros, duration_ms
        ) VALUES ('other', 'o', 'b', 'memory_candidate', ?, '{}', 'kept', 'fixture', '{}', 0, 0)`,
      )
      .run(IN_WINDOW);
    database.close();
    expect(() =>
      run([`--db=${databasePath}`, `--end=${END}`, "--no-record"], {
        now: NOW,
        output: capture(),
        root,
      }),
    ).toThrow(/CALIBRATION_SCOPE/u);
  });

  it("runs as a plain node program and records the revision it was given", async () => {
    const { root, databasePath, database } = await fixture();
    for (let index = 0; index < 5; index += 1) addProactive(database, "pushed", "useful");
    database.close();
    const history = path.join(root, "history.jsonl");
    const script = path.resolve("scripts/calibration-report/report.mjs");
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        script,
        `--db=${databasePath}`,
        `--end=${END}`,
        "--revision=41a6ce3",
        `--history=${history}`,
        `--out-dir=${path.join(root, "reports")}`,
      ],
      { cwd: root },
    );
    expect(stdout).toContain("| 读完邮件提醒了你 | 5 | 5 | 提醒得对 100.0%（5/5");
    const [line] = (await readFile(history, "utf8")).trim().split("\n");
    expect(JSON.parse(line as string)).toMatchObject({
      schema: "himawari-calibration-week.v5",
      commit: "41a6ce3",
    });
  });
});
