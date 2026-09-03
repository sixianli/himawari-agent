import { createHash } from "node:crypto";
import ts from "typescript";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const credentialName =
  /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret|webhook[_-]?secret)$/i;
const patterns = [
  [
    "private-key",
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  ],
  ["bearer-token", /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi],
  ["jwt-token", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g],
  ["openai-key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g],
  ["github-token", /\b(?:gh[opsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ["aws-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
];

function literalParts(node) {
  if (!node) return [];
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node)
  )
    return literalParts(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = literalParts(node.left),
      right = literalParts(node.right);
    return left.length === 1 && right.length === 1 ? [left[0] + right[0]] : [...left, ...right];
  }
  if (ts.isTemplateExpression(node))
    return [
      node.head.text,
      ...node.templateSpans.flatMap((span) => [
        ...literalParts(span.expression),
        span.literal.text,
      ]),
    ];
  return [];
}
function propertyName(node) {
  if (!node) return "";
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return propertyName(node.name);
  if (ts.isElementAccessExpression(node)) return propertyName(node.argumentExpression);
  return "";
}

/** Public code is data: variable references/calls are not credentials; string values are checked. */
export function findBuildSecrets({ name, bytes, sentinels = [] }) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes);
  const findings = [],
    identities = new Set();
  const add = (rule, value, line) => {
    const finding = { rule, digest: hash(value), line };
    const key = JSON.stringify(finding);
    if (!identities.has(key)) {
      identities.add(key);
      findings.push(finding);
    }
  };
  for (const sentinel of sentinels) {
    if (typeof sentinel !== "string" || !sentinel.length)
      throw new Error("PUBLIC_SENTINEL_INVALID");
    if (text.includes(sentinel)) add("sentinel", sentinel, null);
  }
  for (const [rule, pattern] of patterns)
    for (const match of text.matchAll(pattern))
      add(rule, match[0], text.slice(0, match.index).split("\n").length);
  const credential = (key, values, line) => {
    if (credentialName.test(key))
      for (const value of values) if (value.length >= 12) add("credential-literal", value, line);
  };
  const source = (filename, content) => {
    if (
      !/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret|webhook[_-]?secret)\b|\\u/i.test(
        content,
      )
    )
      return;
    const tree = ts.createSourceFile(filename, content, ts.ScriptTarget.Latest, true);
    if (tree.parseDiagnostics.length) throw new Error("PUBLIC_SOURCE_PARSE_FAILED");
    const visit = (node) => {
      const line = () => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
      if (
        ts.isPropertyAssignment(node) ||
        ts.isVariableDeclaration(node) ||
        ts.isBindingElement(node) ||
        ts.isPropertyDeclaration(node)
      )
        credential(propertyName(node.name), literalParts(node.initializer), line());
      else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken)
        credential(propertyName(node.left), literalParts(node.right), line());
      ts.forEachChild(node, visit);
    };
    visit(tree);
  };
  if (/\.(?:[cm]?[jt]s|[jt]sx)$/i.test(name)) source(name, text);
  else if (/\.(?:json|map)$/i.test(name)) {
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      const parsed = ts.parseConfigFileTextToJson(name, text);
      if (parsed.error) throw new Error("PUBLIC_SOURCE_PARSE_FAILED");
      value = parsed.config;
    }
    const visit = (node) => {
      if (!node || typeof node !== "object") return;
      for (const [key, child] of Object.entries(node)) {
        if (typeof child === "string") credential(key, [child], null);
        else visit(child);
      }
    };
    visit(value);
    if (Array.isArray(value?.sourcesContent))
      value.sourcesContent.forEach((content, index) => {
        if (
          typeof content === "string" &&
          /\.(?:[cm]?[jt]s|[jt]sx)$/i.test(value.sources?.[index] ?? "")
        )
          source(value.sources[index], content);
      });
  } else {
    // Non-code documents and configuration: only complete quoted values or complete dotenv lines.
    const quoted =
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret|webhook[_-]?secret)["']?\s*[:=]\s*(["'])([^"'\r\n]{12,})\2/gi;
    for (const match of text.matchAll(quoted))
      credential(match[1], [match[3]], text.slice(0, match.index).split("\n").length);
    if (/(?:^|\/)(?:\.env(?:\.[^/]*)?|[^/]+\.(?:env|conf|ini))$/i.test(name)) {
      const env =
        /^\s*(api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret|webhook[_-]?secret)\s*=\s*([^\s"']{12,})\s*$/gim;
      for (const match of text.matchAll(env))
        credential(match[1], [match[2]], text.slice(0, match.index).split("\n").length);
    }
  }
  return findings;
}
