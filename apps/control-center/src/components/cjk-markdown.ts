import { Marked, type TokenizerAndRendererExtension } from "marked";

const CJK_PUNCTUATION = "，。；：！？（）【】《》「」『』、“”‘’—…·〈〉〔〕";
const OPEN = new RegExp(
  `^\\*\\*([${CJK_PUNCTUATION}][^\\n]*?[^\\s*]|[^\\s*][^\\n]*?[${CJK_PUNCTUATION}])\\*\\*`,
  "u",
);
const ENDS_WITH_CJK_PUNCTUATION = new RegExp(`[${CJK_PUNCTUATION}]$`, "u");
const STARTS_WITH_CJK_PUNCTUATION = new RegExp(`^[${CJK_PUNCTUATION}]`, "u");

const strongNextToCjkPunctuation: TokenizerAndRendererExtension = {
  name: "strong",
  level: "inline",
  start: (source) => source.indexOf("**"),
  tokenizer(source) {
    const match = OPEN.exec(source);
    const text = match?.[1];
    if (!match || text === undefined) return undefined;
    if (!STARTS_WITH_CJK_PUNCTUATION.test(text) && !ENDS_WITH_CJK_PUNCTUATION.test(text))
      return undefined;
    if (text.includes("**")) return undefined;
    return {
      type: "strong",
      raw: match[0],
      text,
      tokens: this.lexer.inlineTokens(text),
    };
  },
};

export const markdown = new Marked({ gfm: true, extensions: [strongNextToCjkPunctuation] });
