import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = join(import.meta.dirname, "../../apps/control-center/src");
const stylesheets = readdirSync(sourceRoot)
  .filter((name) => name.endsWith(".css"))
  .map((name) => ({ name, text: readFileSync(join(sourceRoot, name), "utf8") }));

const answerTextContainers =
  /(?:^|[\s>])(?:html|body|:root|\.app-shell|\.content-pane|\.thread-content|\.chat-scroll|\.chat-turn|\.thread-message|\.thread-message-agent|\.thread-message-content|\.assistant-markdown(?:\s+(?:p|li|ol|ul))?)(?:\[[^\]]*\])*$/;

function rules(text) {
  const plain = text.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selectors: (match[1] ?? "")
      .trim()
      .split(",")
      .map((selector) => selector.trim()),
    weights: [...(match[2] ?? "").matchAll(/font-weight\s*:\s*([^;]+)/g)].map((weight) =>
      (weight[1] ?? "").trim(),
    ),
  }));
}

describe("answer text weight", () => {
  it("uses only whole-hundred weights, which static Chinese fonts such as PingFang SC map without jumping to a heavier face", () => {
    const offenders = stylesheets.flatMap(({ name, text }) =>
      rules(text).flatMap(({ selectors, weights }) =>
        weights
          .filter((weight) => /^\d+$/.test(weight) && Number(weight) % 100 !== 0)
          .map((weight) => `${name}: ${selectors.join(", ")} { font-weight: ${weight} }`),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("keeps the containers around an answer at regular weight so bold stays visible", () => {
    const offenders = stylesheets.flatMap(({ name, text }) =>
      rules(text).flatMap(({ selectors, weights }) =>
        selectors.some((selector) => answerTextContainers.test(selector))
          ? weights
              .filter((weight) => weight !== "400" && weight !== "normal" && weight !== "inherit")
              .map((weight) => `${name}: ${selectors.join(", ")} { font-weight: ${weight} }`)
          : [],
      ),
    );
    expect(offenders).toEqual([]);
  });
});
