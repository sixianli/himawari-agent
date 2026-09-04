import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

export const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
export const identityFields = [
  "repository",
  "event",
  "runId",
  "attempt",
  "testedSha",
  "headSha",
  "baseSha",
  "policySha256",
  "toolchainSha256",
  "initialization",
];
export const readJson = (filename) => JSON.parse(readFileSync(filename, "utf8"));
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const fileSha256 = (filename) => sha256(readFileSync(filename));
export const memberId = (checkId, matrixKey) => `${checkId}/${matrixKey}`;
const ajv = new Ajv({ allErrors: true, strict: true });
const policySchema = readJson(path.join(repositoryRoot, "ci/policy.schema.json"));
const resultSchema = readJson(path.join(repositoryRoot, "ci/result.schema.json"));
const validators = {
  CheckPolicy: ajv.compile(policySchema),
  ...Object.fromEntries(
    Object.entries(resultSchema.definitions).map(([name, schema]) => [name, ajv.compile(schema)]),
  ),
};

export function validateRecord(name, value) {
  if (name === "CoveragePolicy" && !validators.CoveragePolicy) {
    validators.CoveragePolicy = ajv.compile(
      readJson(path.join(repositoryRoot, "ci/coverage.schema.json")),
    );
  }
  const validate = validators[name];
  if (!validate) throw new Error(`Unknown record schema: ${name}`);
  if (!validate(value))
    throw new Error(`${name}: ${ajv.errorsText(validate.errors, { separator: "; " })}`);
  return value;
}

export function contextIdentity(context) {
  return Object.fromEntries(identityFields.map((key) => [key, context[key]]));
}

export function expectedMembers(policy) {
  validateRecord("CheckPolicy", policy);
  return policy.checks
    .filter((check) => check.id !== "required")
    .flatMap((check) =>
      check.members.map((member) => ({ check, member, id: memberId(check.id, member.key) })),
    );
}

export function safeRelativePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !path.isAbsolute(value) &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

export function existingInside(root, relativePath) {
  if (!safeRelativePath(relativePath)) throw new Error(`Unsafe evidence path: ${relativePath}`);
  const realRoot = realpathSync(root);
  const target = realpathSync(path.join(realRoot, relativePath));
  if (!target.startsWith(`${realRoot}${path.sep}`))
    throw new Error(`Evidence escapes root: ${relativePath}`);
  return target;
}

export function parseArguments(argv, allowed) {
  const output = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (
      !allowed.includes(key) ||
      Object.hasOwn(output, key) ||
      argv[i + 1] === undefined ||
      argv[i + 1].startsWith("--")
    ) {
      throw new Error(`Invalid or duplicate argument: ${key}`);
    }
    output[key] = argv[i + 1];
  }
  return output;
}

export const githubExpression = (expression) => `\${{ ${expression} }}`;
