const indexes = new WeakMap<readonly string[], ReadonlySet<string>>();

export function isRequired(required: readonly string[], name: string): boolean {
  // Normalized required lists never mutate. Keep small scans allocation-free
  // and index wide lists without changing their declaration/diagnostic order.
  if (required.length < 16) return required.includes(name);
  let index = indexes.get(required);
  if (!index) {
    index = new Set(required);
    indexes.set(required, index);
  }
  return index.has(name);
}
