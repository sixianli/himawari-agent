// @vitest-environment jsdom

import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ATTACHMENT_TEXT_LIMIT,
  attachmentKind,
  extractAttachmentText,
} from "../src/attachment-text.js";

const office = (name: string, entries: Record<string, string>) =>
  new File(
    [
      zipSync(
        Object.fromEntries(Object.entries(entries).map(([path, text]) => [path, strToU8(text)])),
      ),
    ],
    name,
  );

describe("[UI-16] reading attached files as text in the browser", () => {
  beforeEach(() => {
    Object.defineProperty(File.prototype, "arrayBuffer", {
      configurable: true,
      value(this: File) {
        return new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.readAsArrayBuffer(this);
        });
      },
    });
  });
  afterEach(() => {
    Reflect.deleteProperty(File.prototype, "arrayBuffer");
  });

  it("reads Word paragraphs, tabs and line breaks", async () => {
    const file = office("方案.docx", {
      "word/document.xml":
        '<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>第一段</w:t></w:r><w:r><w:tab/><w:t>续</w:t></w:r></w:p><w:p><w:r><w:t>第二</w:t><w:br/><w:t>行</w:t></w:r></w:p></w:body></w:document>',
    });
    expect(await extractAttachmentText(file)).toEqual({
      kind: "word",
      text: "第一段\t续\n第二\n行",
      truncated: false,
    });
  });

  it("reads every Excel sheet by name with shared and inline strings", async () => {
    const file = office("销售.xlsx", {
      "xl/workbook.xml":
        '<workbook xmlns:r="r"><sheets><sheet name="三季度" r:id="rId1"/><sheet name="备注" r:id="rId2"/></sheets></workbook>',
      "xl/_rels/workbook.xml.rels":
        '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
      "xl/sharedStrings.xml":
        "<sst><si><t>月份</t></si><si><r><t>销</t></r><r><t>售额</t></r></si></sst>",
      "xl/worksheets/sheet1.xml":
        '<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row><row><c><v>7</v></c><c><v>120.5</v></c></row></sheetData></worksheet>',
      "xl/worksheets/sheet2.xml":
        '<worksheet><sheetData><row><c t="inlineStr"><is><t>按月汇总</t></is></c></row></sheetData></worksheet>',
    });
    expect((await extractAttachmentText(file)).text).toBe(
      "## 三季度\n月份\t销售额\n7\t120.5\n\n## 备注\n按月汇总",
    );
  });

  it("reads PowerPoint slides in slide order", async () => {
    const slide = (text: string) =>
      `<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:sld>`;
    const file = office("汇报.pptx", {
      "ppt/slides/slide10.xml": slide("结尾"),
      "ppt/slides/slide2.xml": slide("数据"),
      "ppt/slides/slide1.xml": slide("封面"),
    });
    expect((await extractAttachmentText(file)).text).toBe(
      "[第 1 张幻灯片]\n封面\n\n[第 2 张幻灯片]\n数据\n\n[第 10 张幻灯片]\n结尾",
    );
  });

  it("keeps text files, cuts very long ones with a visible note, and refuses what it cannot read", async () => {
    expect(await extractAttachmentText(new File(["a,b\r\n1,2\r\n"], "data.csv"))).toEqual({
      kind: "text",
      text: "a,b\n1,2",
      truncated: false,
    });
    const long = await extractAttachmentText(
      new File(["长".repeat(ATTACHMENT_TEXT_LIMIT + 10)], "long.txt"),
    );
    expect(long.truncated).toBe(true);
    expect(long.text.length).toBe(ATTACHMENT_TEXT_LIMIT);
    expect(long.text.endsWith("[后面的内容太长，已截断]")).toBe(true);
    expect(attachmentKind(new File(["x"], "photo.png", { type: "image/png" }))).toBe("image");
    expect(attachmentKind(new File(["x"], "photo.heic", { type: "image/heic" }))).toBeNull();
    expect(attachmentKind(new File(["x"], "old.doc"))).toBeNull();
    await expect(
      extractAttachmentText(new File([new Uint8Array([0xff, 0xfe, 0x00])], "x.bin")),
    ).rejects.toThrow("ATTACHMENT_UNSUPPORTED");
    await expect(extractAttachmentText(new File(["   \n"], "blank.txt"))).rejects.toThrow(
      "ATTACHMENT_EMPTY",
    );
    await expect(extractAttachmentText(new File(["not a zip"], "broken.docx"))).rejects.toThrow(
      "ATTACHMENT_UNSUPPORTED",
    );
    await expect(
      extractAttachmentText(new File([new Uint8Array(20 * 1024 * 1024 + 1)], "huge.pdf")),
    ).rejects.toThrow("ATTACHMENT_TOO_LARGE");
  });
});
