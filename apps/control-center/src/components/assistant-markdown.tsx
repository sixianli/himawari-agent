import { Lexer, lexer, type MarkedToken, type Token } from "marked";
import { Fragment, createElement as h, type ReactNode } from "react";

function safeLink(value: string): string | undefined {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
function children(tokens: readonly Token[]): ReactNode {
  // No lexer extensions: all tokens come from Marked's built-in discriminated union.
  return tokens.map((token, index) =>
    h(Fragment, { key: `${index}:${token.type}` }, renderToken(token as MarkedToken)),
  );
}
function renderToken(token: MarkedToken): ReactNode {
  switch (token.type) {
    case "space":
    case "def":
    case "html":
      return null;
    case "image":
    case "escape":
      return token.text;
    case "text":
      return token.tokens ? children(token.tokens) : token.text;
    case "code":
      return h(
        "pre",
        null,
        h(
          "code",
          { className: token.lang ? `language-${token.lang.split(/\s/)[0]}` : undefined },
          token.text,
        ),
      );
    case "codespan":
      return h("code", null, token.text);
    case "br":
    case "hr":
      return h(token.type);
    case "heading":
      return h(`h${token.depth}`, null, children(token.tokens));
    case "paragraph":
      return h("p", null, children(token.tokens));
    case "strong":
    case "em":
    case "del":
    case "blockquote":
      return h(token.type, null, children(token.tokens));
    case "link": {
      // GFM bare-URL detection can absorb CJK sentence punctuation. Trim only
      // automatically detected links; explicit Markdown destinations stay exact.
      const boundary =
        token.raw === token.text && /^(?:https?:\/\/|www\.)/.test(token.raw)
          ? token.raw.search(/[，。；：！？（）【】《》「」『』、]/u)
          : -1;
      const label = boundary >= 0 ? token.raw.slice(0, boundary) : undefined;
      const href = safeLink(
        label === undefined ? token.href : label.startsWith("www.") ? `http://${label}` : label,
      );
      const body = label ?? children(token.tokens);
      const link = href
        ? h(
            "a",
            { href, target: "_blank", rel: "noopener noreferrer", referrerPolicy: "no-referrer" },
            body,
          )
        : body;
      return boundary >= 0
        ? h(
            Fragment,
            null,
            link,
            children(Lexer.lexInline(token.raw.slice(boundary), { gfm: true })),
          )
        : link;
    }
    case "checkbox":
      return token.checked ? "☑ " : "☐ ";
    case "list_item":
      return h(
        "li",
        null,
        token.task ? (token.checked ? "☑ " : "☐ ") : null,
        children(token.tokens),
      );
    case "list":
      return h(
        token.ordered ? "ol" : "ul",
        token.ordered && token.start !== "" ? { start: token.start } : null,
        children(token.items),
      );
    case "table":
      return h(
        "div",
        { className: "markdown-table" },
        h(
          "table",
          null,
          h(
            "thead",
            null,
            h(
              "tr",
              null,
              token.header.map((cell, i) => h("th", { key: i }, children(cell.tokens))),
            ),
          ),
          h(
            "tbody",
            null,
            token.rows.map((row, i) =>
              h(
                "tr",
                { key: i },
                row.map((cell, j) => h("td", { key: j }, children(cell.tokens))),
              ),
            ),
          ),
        ),
      );
  }
}
/** Parse Markdown to React nodes, never HTML. Remote images and implicit URLs are inert. */
export function AssistantMarkdown({ text }: { readonly text: string }) {
  return h(
    "div",
    { className: "thread-message-content assistant-markdown" },
    children(lexer(text, { gfm: true })),
  );
}
