export function copy<TValue>(value: TValue): TValue {
  return structuredClone(value);
}

export function frozenCopy<TValue extends object>(value: TValue): TValue {
  return Object.freeze(copy(value));
}

export function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
