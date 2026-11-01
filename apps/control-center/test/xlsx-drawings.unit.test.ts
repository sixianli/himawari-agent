import ExcelJS from "exceljs";
import { expect, it } from "vitest";
import { OPENPYXL_LINE_CHART_BASE64 } from "./fixtures/openpyxl-line-chart.js";
import { workbookViews } from "../src/spreadsheet-model.js";
import { withoutDrawings } from "../src/xlsx-drawings.js";

function fixtureBytes(): ArrayBuffer {
  const bytes = Uint8Array.from(atob(OPENPYXL_LINE_CHART_BASE64), (char) => char.charCodeAt(0));
  return bytes.buffer;
}

it("ExcelJS cannot load a workbook with an openpyxl line chart, but can once drawings are removed", async () => {
  const original = fixtureBytes();
  await expect(new ExcelJS.Workbook().xlsx.load(original)).rejects.toThrow();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(withoutDrawings(original));
  const [view] = workbookViews(
    workbook.worksheets as unknown as Parameters<typeof workbookViews>[0],
  );
  expect(view?.name).toBe("销售");
  expect(view?.rows.map((row) => row.cells.map((cell) => cell.text))).toEqual([
    ["月份", "销售额"],
    ["1月", "100"],
    ["2月", "200"],
    ["3月", "300"],
    ["4月", "400"],
    ["5月", "500"],
    ["6月", "600"],
  ]);
});
