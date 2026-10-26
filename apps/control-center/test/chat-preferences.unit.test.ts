import { describe, expect, it } from "vitest";
import { ACCENT_COLORS, ControlCenterBrowserStorage } from "../src/browser-storage.js";

describe("chat preferences", () => {
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
  it("preserves the approved system theme and normalizes invalid accents without losing pane preferences", () => {
    const raw = storage();
    raw.setItem(
      "himawari.control-center.v1.preferences",
      JSON.stringify({ theme: "system", accent: "red", density: "compact", detailPanePercent: 31 }),
    );
    expect(new ControlCenterBrowserStorage(raw).readPreferences()).toEqual({
      theme: "system",
      accent: "violet",
      density: "compact",
      detailPanePercent: 31,
      listPanePercent: 26,
    });
  });
  it("persists each independent theme and accent combination", () => {
    const client = new ControlCenterBrowserStorage(storage());
    for (const theme of ["light", "dark", "system"] as const)
      for (const accent of ACCENT_COLORS) {
        client.savePreferences({ ...client.readPreferences(), theme, accent });
        expect(client.readPreferences()).toMatchObject({ theme, accent });
      }
  });
});
