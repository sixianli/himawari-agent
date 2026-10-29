import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = "apps/control-center";
const INPUT_GUARD =
  /@media \(pointer: coarse\), \(max-width: 560px\) \{\s*input:not\(\[type="checkbox"\], \[type="radio"\], \[type="range"\], \[type="file"\], \[type="color"\]\),\s*textarea,\s*select \{\s*font-size: 16px !important;\s*\}\s*\}/;

function rules(css, selector) {
  const found = [];
  const pattern = new RegExp(
    `(^|[},])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`,
    "gm",
  );
  for (const match of css.matchAll(pattern)) found.push(match[2]);
  return found;
}

function sourceFiles(directory, extension) {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

export function checkPhoneLayout({ root = repositoryRoot } = {}) {
  const errors = [];
  const app = path.join(root, APP);
  const viewport = readFileSync(path.join(app, "index.html"), "utf8").match(
    /<meta name="viewport" content="([^"]*)"/,
  )?.[1];
  if (!viewport) errors.push("PHONE_VIEWPORT_MISSING index.html");
  else {
    for (const part of ["width=device-width", "initial-scale=1", "viewport-fit=cover"])
      if (!viewport.includes(part)) errors.push(`PHONE_VIEWPORT_INCOMPLETE ${part}`);
    if (/maximum-scale|user-scalable/.test(viewport))
      errors.push("PHONE_VIEWPORT_BLOCKS_PINCH_ZOOM");
  }
  const cssFiles = sourceFiles(path.join(app, "src"), ".css");
  const css = Object.fromEntries(
    cssFiles.map((file) => [path.relative(root, file), readFileSync(file, "utf8")]),
  );
  const base = css[`${APP}/src/styles.css`] ?? "";
  if (!INPUT_GUARD.test(base)) errors.push("PHONE_INPUT_FONT_GUARD_MISSING styles.css");
  for (const [file, text] of Object.entries(css)) {
    const withoutGuard = file.endsWith("/src/styles.css") ? text.replace(INPUT_GUARD, "") : text;
    if (/font(-size)?\s*:[^;}]*!important/.test(withoutGuard))
      errors.push(`PHONE_INPUT_FONT_OVERRIDE ${file}`);
  }
  for (const file of sourceFiles(path.join(app, "src"), ".tsx"))
    if (/fontSize\s*:/.test(readFileSync(file, "utf8")))
      errors.push(`PHONE_INLINE_FONT_SIZE ${path.relative(root, file)}`);
  const dialog = rules(base, ".modal-dialog").join(";");
  if (
    !/max-height:\s*calc\(\s*100dvh\s*-\s*env\(safe-area-inset-top, 0px\)\s*-\s*env\(safe-area-inset-bottom, 0px\)/.test(
      dialog,
    )
  )
    errors.push("PHONE_DIALOG_HEIGHT_IGNORES_SAFE_AREA styles.css .modal-dialog");
  if (!/overflow:\s*hidden/.test(dialog)) errors.push("PHONE_DIALOG_SCROLLS_AS_WHOLE");
  if (!/overflow:\s*auto/.test(rules(base, ".dialog-body").join(";")))
    errors.push("PHONE_DIALOG_BODY_NOT_SCROLLING styles.css .dialog-body");
  for (const [file, text] of Object.entries(css))
    for (const body of rules(text, ".modal-dialog"))
      if (
        file !== `${APP}/src/styles.css` &&
        /(^|;|\s)(max-height|height|overflow(-y)?)\s*:/.test(body)
      )
        errors.push(`PHONE_DIALOG_SIZE_OVERRIDE ${file}`);
  const overlays = readFileSync(path.join(app, "src/components/overlays.tsx"), "utf8");
  if (!overlays.includes('<div className="dialog-body">{children}</div>'))
    errors.push("PHONE_DIALOG_BODY_WRAPPER_MISSING overlays.tsx");
  return errors;
}

if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  const errors = checkPhoneLayout({
    root: process.argv[2] ? path.resolve(process.argv[2]) : repositoryRoot,
  });
  for (const error of errors) console.error(error);
  console.log(`PHONE_LAYOUT ${errors.length ? "failed" : "passed"}`);
  process.exitCode = errors.length ? 1 : 0;
}
