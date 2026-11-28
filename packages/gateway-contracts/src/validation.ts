export const CONTRACT_ERROR_CODE = "CONTRACT_VALIDATION_ERROR" as const;

export class ContractValidationError extends Error {
  readonly code = CONTRACT_ERROR_CODE;
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ContractValidationError";
    this.path = path;
  }
}

export type SchemaDescription = Readonly<Record<string, unknown>>;

export interface Schema<T> {
  parse(input: unknown, path?: string): T;
  describe?(): SchemaDescription;
}

export function describeSchema(schema: Schema<unknown>): SchemaDescription {
  return schema.describe ? schema.describe() : {};
}

export type InferSchema<TSchema> = TSchema extends Schema<infer TValue> ? TValue : never;

function fail(path: string, message: string): never {
  throw new ContractValidationError(path, message);
}

export function literal<const TValue extends string | number | boolean | null>(
  expected: TValue,
): Schema<TValue> {
  return {
    describe: () => ({ const: expected }),
    parse(input, path = "$") {
      if (input !== expected) fail(path, `expected ${JSON.stringify(expected)}`);
      return expected;
    },
  };
}

export function enumeration<const TValues extends readonly string[]>(
  values: TValues,
): Schema<TValues[number]> {
  const allowed = new Set<string>(values);
  return {
    describe: () => ({ type: "string", enum: [...values] }),
    parse(input, path = "$") {
      if (typeof input !== "string" || !allowed.has(input)) {
        fail(path, `expected one of ${values.join(", ")}`);
      }
      return input as TValues[number];
    },
  };
}

export const MACHINE_STRING_MAX_LENGTH = 128;

export const machineString: Schema<string> = {
  describe: () => ({
    type: "string",
    maxLength: MACHINE_STRING_MAX_LENGTH,
    pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
  }),
  parse(input, path = "$") {
    if (
      typeof input !== "string" ||
      input.length > MACHINE_STRING_MAX_LENGTH ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(input)
    ) {
      fail(path, `expected a 1-${MACHINE_STRING_MAX_LENGTH} character machine string`);
    }
    return input;
  },
};

export const PROACTIVE_SOURCE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;

export const proactiveSourceName: Schema<string> = {
  describe: () => ({ type: "string", pattern: PROACTIVE_SOURCE_NAME_PATTERN.source }),
  parse(input, path = "$") {
    if (typeof input !== "string" || !PROACTIVE_SOURCE_NAME_PATTERN.test(input)) {
      fail(path, "expected a registered proactive source name");
    }
    return input;
  },
};

export const GMAIL_MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/u;

export const gmailMessageId: Schema<string> = {
  parse(input, path = "$") {
    if (typeof input !== "string" || !GMAIL_MESSAGE_ID_PATTERN.test(input)) {
      fail(path, "expected a 1-256 character Gmail message id");
    }
    return input;
  },
};

export const modelRefString: Schema<string> = {
  describe: () => ({ type: "string", maxLength: 128 }),
  parse(input, path = "$") {
    if (
      typeof input !== "string" ||
      input.length > 128 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(input) ||
      input.includes("//") ||
      input.endsWith("/") ||
      /(^|[/:])\.\.?([/:]|$)/.test(input)
    ) {
      fail(path, "expected a 1-128 character model reference");
    }
    return input;
  },
};

export function boundedString(maximum = 2048): Schema<string> {
  return {
    describe: () => ({ type: "string", minLength: 1, maxLength: maximum }),
    parse(input, path = "$") {
      if (
        typeof input !== "string" ||
        input.length === 0 ||
        input.length > maximum ||
        [...input].some((character) => {
          const code = character.charCodeAt(0);
          return code < 0x20 || code === 0x7f;
        })
      ) {
        fail(path, `expected a 1-${maximum} character string without control characters`);
      }
      return input;
    },
  };
}

export function codePointString(
  maximum: number,
  options: { readonly allowLineBreaks?: boolean } = {},
): Schema<string> {
  return {
    describe: () => ({ type: "string", minLength: 1, maxLength: maximum }),
    parse(input, path = "$") {
      if (typeof input !== "string") fail(path, `expected a 1-${maximum} character string`);
      const characters = [...(input as string)];
      if (
        characters.length === 0 ||
        characters.length > maximum ||
        characters.some((character) => {
          const code = character.charCodeAt(0);
          if (options.allowLineBreaks === true && (code === 0x0a || code === 0x09)) return false;
          return code < 0x20 || code === 0x7f;
        })
      ) {
        fail(path, `expected a 1-${maximum} character string without control characters`);
      }
      return input as string;
    },
  };
}

export const booleanValue: Schema<boolean> = {
  describe: () => ({ type: "boolean" }),
  parse(input, path = "$") {
    if (typeof input !== "boolean") fail(path, "expected a boolean");
    return input;
  },
};

export const timestamp: Schema<string> = {
  describe: () => ({ type: "string", format: "date-time" }),
  parse(input, path = "$") {
    if (typeof input !== "string") fail(path, "expected an RFC 3339 timestamp string");

    const parsed = new Date(input);
    if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== input) {
      fail(path, "expected a canonical UTC timestamp with millisecond precision");
    }
    return input;
  },
};

export function integer(minimum: number, maximum = Number.MAX_SAFE_INTEGER): Schema<number> {
  return {
    describe: () => ({ type: "integer", minimum, maximum }),
    parse(input, path = "$") {
      if (
        !Number.isSafeInteger(input) ||
        (input as number) < minimum ||
        (input as number) > maximum
      ) {
        fail(path, `expected an integer from ${minimum} through ${maximum}`);
      }
      return input as number;
    },
  };
}

export function nullable<TValue>(schema: Schema<TValue>): Schema<TValue | null> {
  return {
    describe: () => ({ anyOf: [describeSchema(schema), { type: "null" }] }),
    parse(input, path = "$") {
      return input === null ? null : schema.parse(input, path);
    },
  };
}

export function array<TValue>(schema: Schema<TValue>): Schema<readonly TValue[]> {
  return {
    describe: () => ({ type: "array", items: describeSchema(schema) }),
    parse(input, path = "$") {
      if (!Array.isArray(input)) fail(path, "expected an array");
      return Object.freeze(input.map((value, index) => schema.parse(value, `${path}[${index}]`)));
    },
  };
}

type Shape = Readonly<Record<string, Schema<unknown>>>;

export interface ObjectSchema<TShape extends Shape>
  extends Schema<Readonly<{ [TKey in keyof TShape]: InferSchema<TShape[TKey]> }>> {
  readonly shape: TShape;
}

export function object<const TShape extends Shape>(shape: TShape): ObjectSchema<TShape> {
  const expectedKeys = Object.keys(shape);
  const expectedKeySet = new Set(expectedKeys);

  return {
    shape,
    describe: () => ({
      type: "object",
      properties: Object.fromEntries(
        expectedKeys.map((key) => [key, describeSchema(shape[key] as Schema<unknown>)]),
      ),
      required: [...expectedKeys],
      additionalProperties: false,
    }),
    parse(input, path = "$") {
      if (input === null || typeof input !== "object" || Array.isArray(input)) {
        fail(path, "expected an object");
      }

      const record = input as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (!expectedKeySet.has(key)) fail(`${path}.${key}`, "unknown field");
      }

      const result: Record<string, unknown> = {};
      for (const key of expectedKeys) {
        if (!Object.hasOwn(record, key)) fail(`${path}.${key}`, "missing required field");
        const schema = shape[key];
        if (!schema) fail(path, "invalid schema definition");
        result[key] = schema.parse(record[key], `${path}.${key}`);
      }

      return Object.freeze(result) as Readonly<{
        [TKey in keyof TShape]: InferSchema<TShape[TKey]>;
      }>;
    },
  };
}

export function parseJson<TValue>(schema: Schema<TValue>, json: string): TValue {
  let input: unknown;
  try {
    input = JSON.parse(json);
  } catch {
    fail("$", "expected valid JSON");
  }
  return schema.parse(input, "$");
}
