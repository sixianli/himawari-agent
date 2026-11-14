import { writeFileSync } from "node:fs";
import { joinDraft, splitDraft } from "../../../apps/control-center/src/draft-attachments.ts";

const output = process.argv[2];
if (!output) {
  process.stderr.write(
    "usage: node --experimental-strip-types make-attachment-fixture.mjs <out.json>\n",
  );
  process.exit(2);
}
const cases = [
  { text: "这段为什么配对超时后会崩", files: [] },
  {
    text: "和上个月的差在哪",
    files: [
      { name: "报价单 11 月.xlsx", ref: "pay_01", bytes: 18234, kind: "text", truncated: false },
    ],
  },
  {
    text: "",
    files: [
      { name: "正在用：Xcode", ref: "pay_02", bytes: 28, kind: "text", truncated: false },
      { name: "PairingView.swift", ref: "pay_03", bytes: 262144, kind: "text", truncated: true },
    ],
  },
];
const vectors = cases.map(({ text, files }) => {
  const joined = joinDraft(text, files);
  const back = splitDraft(joined);
  if (back.text !== text || back.files.length !== files.length)
    throw new Error("ROUND_TRIP_FAILED");
  return { text, files, joined };
});
writeFileSync(
  output,
  `${JSON.stringify({ source: "apps/control-center/src/draft-attachments.ts joinDraft", vectors }, null, 2)}\n`,
);
