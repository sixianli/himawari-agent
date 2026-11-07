import { describe, expect, it } from "vitest";
import { redactPrivateKeyFragments } from "../src/index.js";

const marker = (edge: "BEGIN" | "END") => [`-----${edge}`, "PRIVATE KEY-----"].join(" ");
const body = Array.from({ length: 6 }, (_, index) => `MIIE${index}${"Qk".repeat(30)}`);
const MASK = "[MACHINE_SECRET_REDACTED]";

describe("private key fragments", () => {
  it("masks a key that lost its last line", () => {
    const text = [marker("BEGIN"), ...body.slice(0, 3)].join("\n");
    expect(redactPrivateKeyFragments(`intro\n${text}`)).toBe(`intro\n${MASK}`);
  });

  it("masks a key that lost its first line and keeps the lines before it", () => {
    const filler = `line 3999 ${"f".repeat(40)}`;
    const text = [filler, ...body.slice(3), marker("END"), "done here"].join("\n");
    expect(redactPrivateKeyFragments(text)).toBe(`${filler}\n${MASK}\ndone here`);
  });

  it("masks a whole key once", () => {
    const text = [marker("BEGIN"), ...body, marker("END")].join("\n");
    expect(redactPrivateKeyFragments(`a\n${text}\nb`)).toBe(`a\n${MASK}\nb`);
  });

  it("masks key lines that carry diff numbers or grep file and line prefixes", () => {
    const diff = [
      ` 2 ${marker("BEGIN")}`,
      ...body.slice(0, 2).map((line, i) => ` ${i + 3} ${line}`),
    ];
    expect(redactPrivateKeyFragments(diff.join("\n"))).toBe(` 2 ${MASK}`);
    const grep = [...body.slice(4).map((line, i) => `keys/id.pem:${i + 5}:${line}`)];
    const ending = `keys/id.pem:7:${marker("END")}`;
    expect(redactPrivateKeyFragments([...grep, ending].join("\n"))).toBe(MASK);
  });

  it("masks key lines in grep context output", () => {
    const lines = [
      "notes.txt-1- deploy key:",
      `notes.txt:2: ${marker("BEGIN")}`,
      ...body.slice(0, 3).map((line, i) => `notes.txt-${i + 3}- ${line}`),
    ];
    expect(redactPrivateKeyFragments(lines.join("\n"))).toBe(
      `notes.txt-1- deploy key:\nnotes.txt:2: ${MASK}`,
    );
  });

  it("masks fragments inside JSON-escaped text", () => {
    const text = JSON.stringify({ text: [marker("BEGIN"), ...body.slice(0, 2)].join("\n") });
    expect(redactPrivateKeyFragments(text)).toBe(JSON.stringify({ text: MASK }));
  });

  it("masks a short body, a body on the marker's own line, and escaped CRLF line breaks", () => {
    expect(redactPrivateKeyFragments(`${marker("BEGIN")}\nMIIEvQ`)).toBe(MASK);
    expect(redactPrivateKeyFragments(`${marker("BEGIN")}${body[0]} tail`)).toBe(`${MASK} tail`);
    const escaped = [marker("BEGIN"), ...body.slice(0, 2)].join("\\r\\n");
    expect(redactPrivateKeyFragments(`"${escaped}"`)).toBe(`"${MASK}"`);
    const ending = [...body.slice(0, 2), marker("END")].join("\\r\\n");
    expect(redactPrivateKeyFragments(`"${ending}"`)).toBe(`"${MASK}"`);
  });

  it("masks a tail whose last line is longer than the look-back window", () => {
    const text = `before\n${"A".repeat(20000)}\n${marker("END")}\nafter`;
    const masked = redactPrivateKeyFragments(text);
    expect(masked).not.toContain("A".repeat(64));
    expect(masked).toContain(MASK);
    expect(masked.endsWith("\nafter")).toBe(true);
  });

  it("stays fast on a long base64 run next to a key marker", () => {
    const run = Array.from({ length: 20000 }, (_, index) => `${index}`.padStart(64, "Q"));
    const started = performance.now();
    for (const text of [
      [...run, marker("END")],
      [marker("BEGIN"), ...run],
      [...run, "x y", marker("END")],
      [marker("BEGIN"), "x", ...run, "x y"],
    ])
      redactPrivateKeyFragments(text.join("\n"));
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("leaves bare markers and ordinary text alone", () => {
    for (const text of [
      `grep -rn -- '${marker("BEGIN")}' .`,
      "docs/keys.md: rotate the PRIVATE KEY yearly",
      `${marker("END")}\nshort`,
    ])
      expect(redactPrivateKeyFragments(text)).toBe(text);
  });

  it("reports each masked fragment", () => {
    const seen: string[] = [];
    redactPrivateKeyFragments([marker("BEGIN"), body[0]].join("\n"), (ruleId) => seen.push(ruleId));
    expect(seen).toEqual(["private-key-block"]);
  });
});
