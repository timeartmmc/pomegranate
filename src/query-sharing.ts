/*!
 * MIT License
 *
 * Copyright (c) 2026 Jamil Kazimzade
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
type Container = Readonly<{
  value: object;
  prototype: object | null;
  keys: readonly string[];
  extensible: boolean;
  length: number | undefined;
  lengthWritable: boolean;
}>;

function container(value: unknown): Container | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  try {
    const array = Array.isArray(value);
    const prototype: unknown = Object.getPrototypeOf(value);
    if (
      array
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    )
      return undefined;
    if (Object.getOwnPropertySymbols(value).length > 0) return undefined;
    const keys = Object.getOwnPropertyNames(value);
    let length: number | undefined;
    let lengthWritable = true;
    if (array) {
      const descriptor = Object.getOwnPropertyDescriptor(value, 'length');
      const size: unknown = descriptor?.value;
      if (
        typeof size !== 'number' ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        keys.length !== size + 1 ||
        keys[keys.length - 1] !== 'length'
      )
        return undefined;
      length = size;
      lengthWritable = descriptor?.writable === true;
      keys.pop();
      for (let index = 0; index < keys.length; index++)
        if (keys[index] !== String(index)) return undefined;
    }
    return {
      value,
      // The only admitted prototypes are the standard containers and null.
      prototype: prototype as object | null,
      keys,
      extensible: Object.isExtensible(value),
      length,
      lengthWritable,
    };
  } catch {
    // A selected proxy may reject reflection. Keep the caller's new value.
    return undefined;
  }
}

type Frame = {
  previous: Container | undefined;
  current: Container;
  index: number;
  equal: boolean;
  replacements: Map<string, unknown> | undefined;
  parent: Readonly<{ key: string; previous: unknown }> | undefined;
};

function frame(
  previous: Container | undefined,
  current: Container,
  parent?: Frame['parent'],
): Frame {
  return {
    previous,
    current,
    index: 0,
    equal:
      previous !== undefined &&
      previous.prototype === current.prototype &&
      previous.extensible === current.extensible &&
      previous.length === current.length &&
      previous.lengthWritable === current.lengthWritable &&
      previous.keys.length === current.keys.length,
    replacements: undefined,
    parent,
  };
}

function accept(
  frame: Frame,
  key: string,
  previous: unknown,
  next: unknown,
  shared: unknown,
): void {
  if (!Object.is(previous, shared)) frame.equal = false;
  if (!Object.is(next, shared))
    (frame.replacements ??= new Map()).set(key, shared);
}

function copy(frame: Frame): object | undefined {
  const { current, replacements } = frame;
  const result: object =
    current.length === undefined
      ? (Object.create(current.prototype) as object)
      : [];
  try {
    for (const key of current.keys) {
      const descriptor = Object.getOwnPropertyDescriptor(current.value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
        return undefined;
      if (replacements?.has(key)) descriptor.value = replacements.get(key);
      Object.defineProperty(result, key, descriptor);
    }
  } catch {
    return undefined;
  }
  if (current.length !== undefined && !current.lengthWritable)
    Object.defineProperty(result, 'length', { writable: false });
  if (!current.extensible) Object.preventExtensions(result);
  return result;
}

function share<T>(previous: unknown, next: T, skipIdentical: boolean): T {
  if (Object.is(previous, next)) return next;
  const current = container(next);
  const prior = container(previous);
  if (!current || !prior) return next;
  const seenNext = new WeakSet<object>([current.value]);
  const seenPrevious = new WeakSet<object>([prior.value]);
  const seenShared = new WeakSet<object>();
  const stack = [frame(prior, current)];
  let skipped = false;
  let replaced = false;
  // Iteration supports JSON deeper than the JS call stack. Existing page
  // references need no work if the assembled collection stays exactly next.
  // If reusing any other subtree would change next, scan identical children too:
  // they could contain an alias to a reused node. At most one rescan is needed.
  while (stack.length > 0) {
    const active = stack[stack.length - 1]!;
    if (active.index === active.current.keys.length) {
      const shared =
        active.equal && active.previous
          ? active.previous.value
          : active.replacements === undefined
            ? active.current.value
            : copy(active);
      // Separate input trees can still merge nodes when old references move.
      // Distinct frames must produce distinct objects in the shared tree too.
      if (shared === undefined || seenShared.has(shared)) return next;
      seenShared.add(shared);
      if (shared !== active.current.value) replaced = true;
      if (skipped && replaced) return share(previous, next, false);
      stack.pop();
      if (active.parent === undefined) {
        // Equal subtrees and descriptor-preserving copies have next's shape.
        return shared as T;
      }
      accept(
        stack[stack.length - 1]!,
        active.parent.key,
        active.parent.previous,
        active.current.value,
        shared,
      );
      continue;
    }
    const index = active.index++;
    const key = active.current.keys[index]!;
    let field: PropertyDescriptor | undefined;
    let oldField: PropertyDescriptor | undefined;
    try {
      field = Object.getOwnPropertyDescriptor(active.current.value, key);
      if (active.previous)
        oldField = Object.getOwnPropertyDescriptor(active.previous.value, key);
    } catch {
      return next;
    }
    if (!field?.enumerable || !Object.hasOwn(field, 'value')) return next;
    if (
      active.previous?.keys[index] !== key ||
      !oldField?.enumerable ||
      !Object.hasOwn(oldField, 'value') ||
      oldField.writable !== field.writable ||
      oldField.configurable !== field.configurable
    )
      active.equal = false;
    const value: unknown = field.value;
    const previousValue: unknown = oldField?.value;
    if (
      skipIdentical &&
      value !== null &&
      typeof value === 'object' &&
      Object.is(previousValue, value)
    ) {
      skipped = true;
      if (replaced) return share(previous, next, false);
      accept(active, key, previousValue, value, value);
      continue;
    }
    if (
      value !== null &&
      (typeof value === 'object' || typeof value === 'function')
    ) {
      const child = container(value);
      if (!child || seenNext.has(child.value)) return next;
      seenNext.add(child.value);
      const old = container(previousValue);
      if (old) {
        if (seenPrevious.has(old.value)) return next;
        seenPrevious.add(old.value);
      }
      stack.push(frame(old, child, { key, previous: previousValue }));
    } else accept(active, key, previousValue, value, value);
  }
  return next;
}

/**
 * Reuse equal plain-data trees without interpreting their keys as JS machinery.
 * Other selected values retain their new identity. Inputs are never modified.
 */
export function shareQueryData<T>(previous: unknown, next: T): T {
  return share(previous, next, true);
}
