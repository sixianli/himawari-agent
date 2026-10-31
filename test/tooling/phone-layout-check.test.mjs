import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkPhoneLayout } from "../../scripts/check-phone-layout.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const app = "apps/control-center";
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function copy() {
  const root = mkdtempSync(path.join(tmpdir(), "phone-layout-"));
  roots.push(root);
  cpSync(path.join(repositoryRoot, app, "index.html"), path.join(root, app, "index.html"));
  cpSync(path.join(repositoryRoot, app, "src"), path.join(root, app, "src"), { recursive: true });
  return root;
}

function edit(root, file, from, to) {
  const target = path.join(root, app, file);
  const text = readFileSync(target, "utf8");
  if (!text.includes(from)) throw new Error(`fixture text missing in ${file}`);
  writeFileSync(target, text.replace(from, to));
}

describe("phone layout check", () => {
  it("passes on the current control center", () => {
    expect(checkPhoneLayout({ root: repositoryRoot })).toEqual([]);
  });

  it("refuses inputs that fall back to the 14px page font on phones", () => {
    const root = copy();
    edit(root, "src/styles.css", "font-size: 16px !important;", "font-size: 14px;");
    expect(checkPhoneLayout({ root })).toContain("PHONE_INPUT_FONT_GUARD_MISSING styles.css");
  });

  it("refuses a later rule that can beat the phone input font", () => {
    const root = copy();
    edit(
      root,
      "src/review-v4.css",
      ".composer textarea {\n  font-weight: 400;\n}",
      ".composer textarea {\n  font-weight: 400;\n  font-size: 14px !important;\n}",
    );
    expect(checkPhoneLayout({ root })).toContain(
      `PHONE_INPUT_FONT_OVERRIDE ${app}/src/review-v4.css`,
    );
  });

  it("[UI-43] refuses a page that does not follow the visual viewport when the keyboard opens", () => {
    const root = copy();
    edit(root, "src/main.tsx", "installViewportSync(window);", "");
    expect(checkPhoneLayout({ root })).toContain("PHONE_KEYBOARD_VIEWPORT_SYNC_MISSING main.tsx");
  });

  it("[UI-43] refuses a keyboard-open layout that keeps a fixed height or the home indicator gap", () => {
    const root = copy();
    edit(root, "src/chat-layout.css", "height: var(--app-height);", "height: 100dvh;");
    edit(
      root,
      "src/chat-layout.css",
      'html[data-keyboard="open"] .thread-workarea > .thread-content {\n  padding-bottom: 0;',
      'html[data-keyboard="open"] .thread-workarea > .thread-content {\n  padding-bottom: env(safe-area-inset-bottom, 0px);',
    );
    expect(checkPhoneLayout({ root })).toEqual(
      expect.arrayContaining([
        "PHONE_KEYBOARD_SHELL_IGNORES_VISUAL_VIEWPORT chat-layout.css",
        "PHONE_KEYBOARD_KEEPS_HOME_INDICATOR_GAP chat-layout.css",
      ]),
    );
  });

  it("refuses a viewport that blocks pinch zoom", () => {
    const root = copy();
    edit(root, "index.html", "viewport-fit=cover", "viewport-fit=cover, maximum-scale=1");
    expect(checkPhoneLayout({ root })).toContain("PHONE_VIEWPORT_BLOCKS_PINCH_ZOOM");
  });

  it("refuses a dialog whose height ignores the status bar and scrolls as a whole", () => {
    const root = copy();
    edit(
      root,
      "src/styles.css",
      "max-height: calc(\n    100dvh -\n    env(safe-area-inset-top, 0px) -\n    env(safe-area-inset-bottom, 0px) -\n    2rem\n  );",
      "max-height: calc(100vh - 2rem);",
    );
    edit(
      root,
      "src/components/overlays.tsx",
      '<div className="dialog-body">{children}</div>',
      "{children}",
    );
    expect(checkPhoneLayout({ root })).toEqual(
      expect.arrayContaining([
        "PHONE_DIALOG_HEIGHT_IGNORES_SAFE_AREA styles.css .modal-dialog",
        "PHONE_DIALOG_BODY_WRAPPER_MISSING overlays.tsx",
      ]),
    );
  });
});
