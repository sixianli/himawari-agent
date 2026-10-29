import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = "apps/control-center/src";
const FORMATTER = "apps/control-center/src/i18n/locale-format.ts";
const CATALOGS = "apps/control-center/src/i18n/resources";
const BROWSER_LOCALE_FORMATTING = [
  /\.toLocale(?:Date|Time)?String\(/,
  /new Intl\.(?:DateTimeFormat|NumberFormat|RelativeTimeFormat)\(\s*(?:undefined|\[\]|\))/,
];
const LATIN_PHRASE = /[A-Za-z]{3,}\s+[A-Za-z]{3,}/;

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

export function browserLocaleFormatting(root = repositoryRoot) {
  const offenders = [];
  for (const file of sourceFiles(path.join(root, SOURCE))) {
    const relative = path.relative(root, file);
    if (relative === FORMATTER) continue;
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (BROWSER_LOCALE_FORMATTING.some((pattern) => pattern.test(line)))
          offenders.push(`LOCALE_FORMAT_USES_BROWSER_LANGUAGE ${relative}:${index + 1}`);
      });
  }
  return offenders;
}

export async function untranslatedMessages(root = repositoryRoot) {
  const load = async (locale) =>
    (await import(pathToFileURL(path.join(root, CATALOGS, `${locale}.ts`)).href)).messages;
  const [english, chinese, japanese] = await Promise.all(["en", "zh-CN", "ja"].map(load));
  const findings = [];
  for (const [locale, catalog] of [
    ["zh-CN", chinese],
    ["ja", japanese],
  ]) {
    for (const [id, text] of Object.entries(english)) {
      const translated = catalog[id];
      if (typeof translated !== "string") findings.push(`MESSAGE_MISSING ${locale} ${id}`);
      else if (translated === text && LATIN_PHRASE.test(text.replace(/\{[^}]*\}/g, "")))
        findings.push(`MESSAGE_NOT_TRANSLATED ${locale} ${id}`);
    }
  }
  return findings;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const findings = [...browserLocaleFormatting(), ...(await untranslatedMessages())];
  for (const finding of findings) console.error(finding);
  if (findings.length) {
    console.error(
      `Format dates and numbers with useLocaleFormat from ${FORMATTER} and translate every message.`,
    );
    process.exit(1);
  }
  console.log("CONTROL_CENTER_LOCALE_OK");
}
