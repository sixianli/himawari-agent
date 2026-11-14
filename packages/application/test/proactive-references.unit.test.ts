import { describe, expect, it } from "vitest";
import type { ProactiveSourceItem } from "../src/index.js";
import { parseMailReferences, validMailReferences } from "../src/index.js";

const mail = (messageId: string, subject: string, body: string) =>
  ({ messageId, subject, body, snippet: "" }) as unknown as ProactiveSourceItem;

describe("[T3] numbers the model found in a mail are checked by the program", () => {
  const item = mail("m1", "ご注文のご案内", "注文番号 250-1234567-8901234 と No. 99887766 の件");

  it("keeps a number that appears word-for-word, in capitals, without a trailing dash", () => {
    expect(validMailReferences(["250-1234567-8901234", "no. 99887766-"], item)).toEqual([
      "250-1234567-8901234",
    ]);
    expect(validMailReferences(["99887766"], item)).toEqual(["99887766"]);
  });

  it("REVERSE: drops numbers that are not in the mail, dates, short ones, ones without digits and non-strings", () => {
    const other = mail("m2", "予約", "予約日 2026-11-07、ABCDEFGH、12345、999-0000000-1111111");
    expect(
      validMailReferences(
        ["999-0000000-1111111x", "2026-11-07", "ABCDEFGH", "12345", 42, null, "ZZZ-77777777"],
        other,
      ),
    ).toEqual([]);
  });

  it("REVERSE: does not accept a number that is only part of a longer one", () => {
    expect(validMailReferences(["12345678"], mail("m", "s", "参照 912345678901 です"))).toEqual([]);
  });

  it("keeps at most three numbers per mail and ignores anything that is not a list", () => {
    const body = "AB123456 CD123456 EF123456 GH123456";
    expect(validMailReferences(body.split(" "), mail("m", "s", body))).toHaveLength(3);
    expect(validMailReferences("AB123456", mail("m", "s", body))).toEqual([]);
  });

  it("reads the answer strictly and only for mails that were asked about", () => {
    const answer = JSON.stringify({
      items: [
        { id: "m1", references: ["250-1234567-8901234"] },
        { id: "unknown", references: ["250-1234567-8901234"] },
      ],
    });
    expect([...parseMailReferences(answer, [item])]).toEqual([["m1", ["250-1234567-8901234"]]]);
    for (const bad of ["没有单号", "{}", '{"items":"x"}', "[]"])
      expect(() => parseMailReferences(bad, [item])).toThrow("MAIL_REFERENCES_INVALID");
  });
});
