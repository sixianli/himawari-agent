import { describe, expect, it } from "vitest";
import { ACCENT_COLORS, ControlCenterBrowserStorage } from "../src/browser-storage.js";
import { appendTextAttachment } from "../src/components/chat-composer.js";

describe("chat preferences and explicit text attachment admission", () => {
  const storage = () => {
    const values = new Map<string, string>();
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    } as Storage;
  };
  it("migrates system and invalid appearance values without losing pane preferences", () => {
    const raw = storage();
    raw.setItem(
      "himawari.control-center.v1.preferences",
      JSON.stringify({ theme: "system", accent: "red", density: "compact", detailPanePercent: 31 }),
    );
    expect(new ControlCenterBrowserStorage(raw).readPreferences()).toEqual({
      theme: "dark",
      accent: "violet",
      density: "compact",
      detailPanePercent: 31,
      listPanePercent: 26,
    });
  });
  it("persists each independent theme and accent combination", () => {
    const client = new ControlCenterBrowserStorage(storage());
    for (const theme of ["light", "dark"] as const)
      for (const accent of ACCENT_COLORS) {
        client.savePreferences({ ...client.readPreferences(), theme, accent });
        expect(client.readPreferences()).toMatchObject({ theme, accent });
      }
  });
  it("adds user-selected UTF-8 contents to the reviewable draft", async () => {
    expect(await appendTextAttachment("请分析", new File(["内容\n第二行"], "notes.md"))).toBe(
      "请分析\n\n[notes.md]\n内容\n第二行",
    );
  });
  it("rejects binary, invalid UTF-8 and oversized combined drafts", async () => {
    await expect(
      appendTextAttachment("", new File([new Uint8Array([0xff])], "x.txt")),
    ).rejects.toThrow();
    await expect(
      appendTextAttachment("", new File([new Uint8Array([0])], "x.bin")),
    ).rejects.toThrow();
    await expect(
      appendTextAttachment("界".repeat(22000), new File(["text"], "x.txt")),
    ).rejects.toThrow("TEXT_ATTACHMENT_TOO_LARGE");
  });
});
