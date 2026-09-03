import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

// Build entrypoints load ES modules by explicit relative filenames. Follow those
// imports instead of coupling artifacts to unrelated test/security executors.
export async function relativeModuleClosure(root, entrypoints) {
  const canonicalRoot = await realpath(root);
  const pending = [...entrypoints];
  const visited = new Set();
  while (pending.length) {
    const relative = pending.pop();
    if (visited.has(relative)) continue;
    const filename = path.resolve(root, relative);
    const canonical = await realpath(filename);
    if (!canonical.startsWith(`${canonicalRoot}${path.sep}`))
      throw new Error(`BUILD_IMPORT_ESCAPES_ROOT:${relative}`);
    visited.add(relative);
    if (path.extname(relative) === ".json") continue;
    const content = await readFile(filename, "utf8");
    const ast = ts.createSourceFile(
      relative,
      content,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const add = (specifier) => {
      if (!specifier || !ts.isStringLiteralLike(specifier) || !specifier.text.startsWith("."))
        return;
      const target = path.resolve(path.dirname(filename), specifier.text);
      const targetRelative = path.relative(path.resolve(root), target).split(path.sep).join("/");
      if (targetRelative === ".." || targetRelative.startsWith("../"))
        throw new Error(`BUILD_IMPORT_ESCAPES_ROOT:${specifier.text}`);
      pending.push(targetRelative);
    };
    const visit = (node) => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
        add(node.arguments[0]);
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  return [...visited].sort();
}
