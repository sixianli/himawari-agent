import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

const DRAWING_PART = /^xl\/(drawings|charts)\//;
const SHEET_PART = /^xl\/worksheets\/[^/]+\.xml$/;
const SHEET_RELS_PART = /^xl\/worksheets\/_rels\/[^/]+\.rels$/;
const DRAWING_ELEMENT = /<(drawing|legacyDrawing|legacyDrawingHF)\b[^>]*?\/>/g;
const DRAWING_RELATIONSHIP = /<Relationship\b[^>]*\/(drawing|vmlDrawing)"[^>]*?\/>/g;

export function withoutDrawings(data: ArrayBuffer): ArrayBuffer {
  const parts = unzipSync(new Uint8Array(data));
  const kept: Record<string, Uint8Array> = {};
  for (const [name, bytes] of Object.entries(parts)) {
    if (DRAWING_PART.test(name)) continue;
    if (SHEET_PART.test(name)) {
      kept[name] = strToU8(strFromU8(bytes).replace(DRAWING_ELEMENT, ""));
    } else if (SHEET_RELS_PART.test(name)) {
      kept[name] = strToU8(strFromU8(bytes).replace(DRAWING_RELATIONSHIP, ""));
    } else {
      kept[name] = bytes;
    }
  }
  const zipped = zipSync(kept);
  return zipped.buffer.slice(
    zipped.byteOffset,
    zipped.byteOffset + zipped.byteLength,
  ) as ArrayBuffer;
}
