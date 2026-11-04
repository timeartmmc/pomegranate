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
import { report } from './runtime.ts';
import type { Invalid, Issues } from './runtime.ts';

function genuineFile(input: unknown): input is File {
  const FileClass = globalThis.File;
  const BlobClass = globalThis.Blob;
  if (
    typeof FileClass !== 'function' ||
    typeof BlobClass !== 'function' ||
    input === null ||
    typeof input !== 'object'
  )
    return false;
  try {
    // Bind to the current environment: DOM test setups can replace constructors.
    if (!(input instanceof FileClass)) return false;
    let owner: object | null = FileClass.prototype;
    let metadata: PropertyDescriptor | undefined;
    // Follow inherited platform getters, excluding root Object metadata.
    // File and Blob can share the same prototype (for example, in Bun).
    while (owner !== null) {
      const parent = Reflect.getPrototypeOf(owner);
      if (parent === null) break;
      metadata = Object.getOwnPropertyDescriptor(owner, 'name');
      if (metadata) break;
      owner = parent;
    }
    // Field-based implementations must own a string data name. Never execute
    // their input accessor or accept inherited data as File metadata.
    const own = metadata?.get
      ? undefined
      : Object.getOwnPropertyDescriptor(input, 'name');
    const name: unknown = metadata?.get
      ? Reflect.get(owner, 'name', input)
      : own && Object.hasOwn(own, 'value')
        ? own.value
        : undefined;
    if (typeof name !== 'string') return false;
    const size: unknown = Reflect.get(BlobClass.prototype, 'size', input);
    return typeof size === 'number' && Number.isInteger(size) && size >= 0;
  } catch {
    return false;
  }
}

// Genuine browser files keep identity: their native bytes are immutable.
export function browserFile(input: unknown, issues: Issues): File | Invalid {
  return genuineFile(input)
    ? input
    : report(issues, 'expected a browser File', true);
}
