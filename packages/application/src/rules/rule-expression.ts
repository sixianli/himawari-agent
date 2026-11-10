import {
  type ASTNode,
  Environment,
  ParseError,
  type ParseResult,
  TypeError as CelTypeError,
} from "@marcbachmann/cel-js";
import { RULE_GATES, type RuleGate, ruleFields } from "./field-catalog.js";

export const RULE_EXPRESSION_MAX_LENGTH = 262_144;

const ALLOWED_FUNCTIONS = new Set(["size", "exists", "all", "endsWith", "startsWith", "contains"]);
const ALLOWED_BINARY = new Set(["==", "!=", "<", "<=", ">", ">=", "in", "+", "-"]);
const ALLOWED_STRUCTURE = new Set(["value", "id", "call", "rcall", "list", "?:", "||", "&&", "!_"]);

export class RuleExpressionError extends Error {
  readonly reason: "too_long" | "syntax" | "type" | "not_allowed";

  constructor(reason: RuleExpressionError["reason"], message: string) {
    super(message);
    this.name = "RuleExpressionError";
    this.reason = reason;
  }
}

function environment(gate: RuleGate): Environment {
  const env = new Environment({
    unlistedVariablesAreDyn: false,
    homogeneousAggregateLiterals: true,
    enableOptionalTypes: false,
    limits: {
      maxAstNodes: 2_000,
      maxDepth: 24,
      maxListElements: 300,
      maxMapEntries: 1,
      maxCallArguments: 4,
    },
  });
  for (const field of ruleFields(gate)) env.registerVariable(field.name, field.type);
  return env;
}

const ENVIRONMENTS: Readonly<Record<RuleGate, Environment>> = Object.freeze(
  Object.fromEntries(RULE_GATES.map((gate) => [gate, environment(gate)])) as Record<
    RuleGate,
    Environment
  >,
);

function assertAllowed(node: ASTNode): void {
  const op = node.op as string;
  if (ALLOWED_BINARY.has(op)) {
    for (const argument of node.args as ASTNode[]) assertAllowed(argument);
    return;
  }
  if (!ALLOWED_STRUCTURE.has(op))
    throw new RuleExpressionError("not_allowed", `规则表达式不允许使用 ${op}`);
  switch (op) {
    case "value": {
      const literal = node.args as unknown;
      if (
        typeof literal !== "string" &&
        typeof literal !== "bigint" &&
        typeof literal !== "boolean"
      )
        throw new RuleExpressionError("not_allowed", "规则表达式里的字面量只能是整数、文字或真假");
      return;
    }
    case "id":
      return;
    case "list":
    case "||":
    case "&&":
    case "?:":
      for (const argument of node.args as ASTNode[]) assertAllowed(argument);
      return;
    case "!_":
      assertAllowed(node.args as ASTNode);
      return;
    case "call": {
      const [name, args] = node.args as [string, ASTNode[]];
      if (!ALLOWED_FUNCTIONS.has(name))
        throw new RuleExpressionError("not_allowed", `规则表达式不允许调用 ${name}`);
      for (const argument of args) assertAllowed(argument);
      return;
    }
    case "rcall": {
      const [name, target, args] = node.args as [string, ASTNode, ASTNode[]];
      if (!ALLOWED_FUNCTIONS.has(name))
        throw new RuleExpressionError("not_allowed", `规则表达式不允许调用 ${name}`);
      assertAllowed(target);
      const macro = name === "exists" || name === "all";
      for (const argument of macro ? args.slice(1) : args) assertAllowed(argument);
      return;
    }
    default:
      throw new RuleExpressionError("not_allowed", `规则表达式不允许使用 ${op}`);
  }
}

export interface CompiledRuleExpression {
  readonly gate: RuleGate;
  readonly source: string;
  evaluate(facts: RuleFacts): boolean;
}

export type RuleFacts = Readonly<Record<string, number | string | readonly string[]>>;

export function compileRuleExpression(gate: RuleGate, source: string): CompiledRuleExpression {
  if (typeof source !== "string" || source.length < 1 || source.length > RULE_EXPRESSION_MAX_LENGTH)
    throw new RuleExpressionError("too_long", "规则表达式为空或太长");
  const env = ENVIRONMENTS[gate];
  let parsed: ParseResult;
  try {
    parsed = env.parse(source);
  } catch (error) {
    if (error instanceof ParseError)
      throw new RuleExpressionError("syntax", firstLine(error.message));
    throw error;
  }
  assertAllowed(parsed.ast);
  const checked = parsed.check();
  if (!checked.valid) {
    const message = checked.error ? firstLine(checked.error.message) : "类型检查没有通过";
    throw new RuleExpressionError(
      checked.error instanceof CelTypeError ? "type" : "syntax",
      message,
    );
  }
  if (checked.type !== "bool")
    throw new RuleExpressionError("type", "规则表达式的结果必须是真或假");
  const fields = new Map(ruleFields(gate).map((field) => [field.name, field.type]));
  return Object.freeze({
    gate,
    source,
    evaluate(facts: RuleFacts) {
      const context: Record<string, unknown> = {};
      for (const [name, type] of fields) {
        const value = facts[name];
        if (type === "int") {
          if (typeof value !== "number" || !Number.isSafeInteger(value))
            throw new RuleExpressionError("type", `字段 ${name} 缺失或不是整数`);
          context[name] = BigInt(value);
        } else if (type === "string") {
          if (typeof value !== "string")
            throw new RuleExpressionError("type", `字段 ${name} 缺失或不是文字`);
          context[name] = value;
        } else {
          if (!Array.isArray(value))
            throw new RuleExpressionError("type", `字段 ${name} 缺失或不是文字列表`);
          context[name] = [...value];
        }
      }
      const result: unknown = parsed(context);
      if (typeof result !== "boolean")
        throw new RuleExpressionError("type", "规则表达式的结果必须是真或假");
      return result;
    },
  });
}

function firstLine(message: string): string {
  return message.split("\n", 1)[0] ?? message;
}
