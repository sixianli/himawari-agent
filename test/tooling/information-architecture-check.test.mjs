import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ENTRY_PATH,
  PAGE_PATH,
  TABLE_PATH,
  checkRepository,
  checkTable,
  entriesInCode,
} from "../../clients/apple/scripts/check-information-architecture.mjs";

const root = path.join(import.meta.dirname, "../..");
const read = (relative) => readFileSync(path.join(root, relative), "utf8");
const table = () => JSON.parse(read(TABLE_PATH));
const entrySource = read(ENTRY_PATH);
const pageSource = read(PAGE_PATH).split(/\n\s*private func destination/u)[0];

describe("the Himawari page information architecture check", () => {
  it("passes on the entries and table in the repository", () => {
    expect(checkRepository()).toEqual([]);
  });

  it("fails when the evaluation row comes back as an entry without a row in the table", () => {
    const source = entrySource
      .replace(
        "    case devices\n    case about\n",
        "    case devices\n    case about\n    case evaluation\n",
      )
      .replace("case .about: .about\n", "case .about: .about\n        case .evaluation: .using\n");
    const errors = checkTable({
      table: table(),
      code: entriesInCode(source),
      pageSource,
    });
    expect(errors).toEqual([expect.stringMatching(/^IA_ENTRY_NOT_IN_TABLE evaluation\b/u)]);
  });

  it("fails when the code moves passwords back to another group than the table names", () => {
    const source = entrySource
      .replace(
        "case .personalization, .notifications, .voice, .dataAndApps: .using",
        "case .personalization, .notifications, .voice, .dataAndApps, .passwords: .using",
      )
      .replace("case .passwords, .noMoreAsking", "case .noMoreAsking");
    const errors = checkTable({
      table: table(),
      code: entriesInCode(source),
      pageSource,
    });
    expect(errors).toEqual([
      "IA_GROUP_MISMATCH passwords: code puts it in using, the table says guarding",
    ]);
  });

  it("fails when an entry gives this project or no source as its benchmark", () => {
    const changed = table();
    changed.entries.find((entry) => entry.id === "about").benchmark = [
      "https://github.com/sixianli/himawari-agent",
    ];
    const errors = checkTable({
      table: changed,
      code: entriesInCode(entrySource),
      pageSource,
    });
    expect(errors).toContain(
      "IA_BENCHMARK_MISSING about: name a first-party source outside this project",
    );
  });

  it("fails when a table row stays after its entry is gone from the code", () => {
    const changed = table();
    changed.entries.push({ ...changed.entries[0], id: "privacy" });
    const errors = checkTable({
      table: changed,
      code: entriesInCode(entrySource),
      pageSource,
    });
    expect(errors).toEqual(["IA_ENTRY_GONE privacy: it is no longer a HerEntry case"]);
  });

  it("fails when the Himawari page gets a hand-written row outside HerEntry", () => {
    const errors = checkTable({
      table: table(),
      code: entriesInCode(entrySource),
      pageSource: `${pageSource}\nNavigationLink(value: Page.evaluation) { Text("x") }`,
    });
    expect(errors).toEqual([expect.stringMatching(/^IA_HAND_WRITTEN_ROW .*Page\.evaluation/u)]);
  });
});
