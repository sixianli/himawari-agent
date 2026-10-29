import ExcelJS from "exceljs";
import { expect, it } from "vitest";
import {
  cellText,
  colorOf,
  columnName,
  SHEET_ROW_LIMIT,
  sheetView,
  type WorkbookSheet,
  workbookViews,
} from "../src/spreadsheet-model.js";

async function reloaded(build: (workbook: ExcelJS.Workbook) => void) {
  const workbook = new ExcelJS.Workbook();
  build(workbook);
  const bytes = await workbook.xlsx.writeBuffer();
  const loaded = new ExcelJS.Workbook();
  await loaded.xlsx.load(bytes);
  return loaded.worksheets as unknown as WorkbookSheet[];
}

it("keeps merged titles, fills, fonts, borders, number formats and frozen header rows from a saved workbook", async () => {
  const [sheet] = await reloaded((workbook) => {
    const ws = workbook.addWorksheet("新闻统计");
    ws.mergeCells("A1:D1");
    ws.getCell("A1").value = "2026-10-29 日本新闻来源统计";
    ws.getCell("A1").font = { bold: true, size: 14, color: { argb: "FFFFFFFF" } };
    ws.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E79" } };
    ws.getCell("A1").alignment = { horizontal: "center", vertical: "middle" };
    ws.getRow(1).height = 24;
    ws.addRow(["来源", "日期", "占比", "广告费"]);
    ws.addRow([
      "NHK",
      new Date(Date.UTC(2026, 9, 29)),
      { formula: "5/14", result: 5 / 14 },
      1250000,
    ]);
    ws.getCell("B3").numFmt = "yyyy-mm-dd";
    ws.getCell("C3").numFmt = "0.0%";
    ws.getCell("D3").numFmt = '"¥"#,##0';
    ws.getCell("D3").border = { bottom: { style: "medium", color: { argb: "FFA6A6A6" } } };
    ws.getCell("A3").font = { color: { argb: "FFC0392B" }, bold: true };
    ws.getColumn(4).width = 14;
    ws.views = [{ state: "frozen", ySplit: 2 }];
  });
  const view = sheetView(sheet as WorkbookSheet);
  expect(view.name).toBe("新闻统计");
  expect(view.frozenRows).toBe(2);
  expect(view.truncated).toBe(false);
  expect(view.columns.map((column) => column.name)).toEqual(["A", "B", "C", "D"]);
  expect(view.columns[3]?.width).toBe(103);
  const [title, header, data] = view.rows;
  expect(title?.height).toBe(32);
  expect(title?.cells).toHaveLength(1);
  expect(title?.cells[0]).toMatchObject({
    text: "2026-10-29 日本新闻来源统计",
    colSpan: 4,
    rowSpan: 1,
    style: {
      bold: true,
      fontSize: 14,
      color: "#FFFFFF",
      background: "#1F4E79",
      align: "center",
      verticalAlign: "middle",
    },
  });
  expect(header?.cells.map((cell) => cell.text)).toEqual(["来源", "日期", "占比", "广告费"]);
  expect(data?.cells.map((cell) => cell.text)).toEqual([
    "NHK",
    "2026-10-29",
    "35.7%",
    "¥1,250,000",
  ]);
  expect(data?.cells[0]?.style).toMatchObject({ bold: true, color: "#C0392B" });
  expect(data?.cells[3]?.style).toMatchObject({
    align: "right",
    borderBottom: "2px solid #A6A6A6",
  });
});

it("leaves hidden sheets, rows and columns out and stops at the row limit", async () => {
  const sheets = await reloaded((workbook) => {
    const visible = workbook.addWorksheet("Visible");
    for (let row = 1; row <= SHEET_ROW_LIMIT + 5; row += 1) visible.addRow([row, `r${row}`, "x"]);
    visible.getRow(2).hidden = true;
    visible.getColumn(2).hidden = true;
    workbook.addWorksheet("Hidden", { state: "hidden" }).addRow(["secret"]);
  });
  const views = workbookViews(sheets);
  expect(views.map((view) => view.name)).toEqual(["Visible"]);
  const [view] = views;
  expect(view?.truncated).toBe(true);
  expect(view?.columns.map((column) => column.name)).toEqual(["A", "C"]);
  expect(view?.rows.map((row) => row.number).slice(0, 3)).toEqual([1, 3, 4]);
  expect(view?.rows.at(-1)?.number).toBe(SHEET_ROW_LIMIT);
});

it("formats the number, date, currency and text formats spreadsheets usually carry", () => {
  const text = (value: unknown, numFmt?: string) => cellText({ value, numFmt });
  expect(text(1234567.891, "#,##0.00")).toBe("1,234,567.89");
  expect(text(-42.5, "#,##0.0;(#,##0.0)")).toBe("(42.5)");
  expect(text(0.2142857, "0%")).toBe("21%");
  expect(text(980000.5, "[$¥-411]#,##0")).toBe("¥980,001");
  expect(text(12, '0"件"')).toBe("12件");
  expect(text(46324, "yyyy/m/d")).toBe("2026/10/29");
  expect(text(new Date(Date.UTC(2026, 9, 29, 14, 5)), "yyyy-mm-dd hh:mm")).toBe("2026-10-29 14:05");
  expect(text(new Date(Date.UTC(2026, 9, 29, 14, 5)), "h:mm AM/PM")).toBe("2:05 PM");
  expect(text(0.1 + 0.2)).toBe("0.3");
  expect(text(true)).toBe("TRUE");
  expect(text({ richText: [{ text: "東京" }, { text: " Tokyo" }] })).toBe("東京 Tokyo");
  expect(text({ text: "NHK", hyperlink: "https://www3.nhk.or.jp" })).toBe("NHK");
  expect(text({ error: "#DIV/0!" })).toBe("#DIV/0!");
  expect(text({ formula: "A1+1" })).toBe("");
});

it("resolves theme colors with tint and names columns past Z", () => {
  expect(colorOf({ theme: 4 })).toBe("#4472c4");
  expect(colorOf({ theme: 0, tint: -0.5 })).toBe("#808080");
  expect(colorOf({ argb: "FF00FF00" })).toBe("#00FF00");
  expect(colorOf({ theme: 42 })).toBeUndefined();
  expect(columnName(27)).toBe("AA");
  expect(columnName(703)).toBe("AAA");
});
