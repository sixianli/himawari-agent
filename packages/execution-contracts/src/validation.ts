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

export interface Schema<T> {
  parse(input: unknown, path?: string): T;
}

export type InferSchema<TSchema> = TSchema extends Schema<infer TValue> ? TValue : never;

function fail(path: string, message: string): never {
  throw new ContractValidationError(path, message);
}

export function literal<const TValue extends string | null>(expected: TValue): Schema<TValue> {
  return {
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
    parse(input, path = "$") {
      if (typeof input !== "string" || !allowed.has(input)) {
        fail(path, `expected one of ${values.join(", ")}`);
      }
      return input as TValues[number];
    },
  };
}

export const machineString: Schema<string> = {
  parse(input, path = "$") {
    if (
      typeof input !== "string" ||
      input.length > 128 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(input)
    ) {
      fail(path, "expected a 1-128 character machine string");
    }
    return input;
  },
};

export const timestamp: Schema<string> = {
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
    parse(input, path = "$") {
      return input === null ? null : schema.parse(input, path);
    },
  };
}

export function array<TValue>(schema: Schema<TValue>): Schema<readonly TValue[]> {
  return {
    parse(input, path = "$") {
      if (!Array.isArray(input)) fail(path, "expected an array");
      return Object.freeze(input.map((value, index) => schema.parse(value, `${path}[${index}]`)));
    },
  };
}

type Shape = Readonly<Record<string, Schema<unknown>>>;

export function object<const TShape extends Shape>(
  shape: TShape,
): Schema<Readonly<{ [TKey in keyof TShape]: InferSchema<TShape[TKey]> }>> {
  const expectedKeys = Object.keys(shape);
  const expectedKeySet = new Set(expectedKeys);

  return {
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
