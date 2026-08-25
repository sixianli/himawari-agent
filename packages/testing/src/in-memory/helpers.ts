export function copy<TValue>(value: TValue): TValue {
  return structuredClone(value);
}

export function frozenCopy<TValue extends object>(value: TValue): TValue {
  const cloned = copy(value);
  const freeze = (entry: unknown): void => {
    if (entry === null || typeof entry !== "object" || ArrayBuffer.isView(entry)) return;
    for (const nested of Object.values(entry)) freeze(nested);
    Object.freeze(entry);
  };
  freeze(cloned);
  return cloned;
}

export function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
