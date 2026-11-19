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
import type { Parse } from './runtime.ts';

export function binaryBodyParser(
  maxLength?: number,
): Parse<Uint8Array<ArrayBuffer>> {
  const Bytes = Uint8Array;
  const prototype = Object.getPrototypeOf(Bytes.prototype) as object;
  const getter = (owner: object, key: PropertyKey) =>
    (
      Object.getOwnPropertyDescriptor(owner, key) as {
        get: (this: unknown) => unknown;
      }
    ).get;
  const tag = getter(prototype, Symbol.toStringTag);
  const buffer = getter(prototype, 'buffer');
  const length = getter(prototype, 'byteLength');
  const arrayBufferLength = getter(ArrayBuffer.prototype, 'byteLength');
  const expected =
    'expected a Uint8Array backed by an attached, non-shared ArrayBuffer';
  return (input, issues) => {
    if (Reflect.apply(tag, input, []) !== 'Uint8Array')
      return report(issues, expected, true);
    try {
      // The intrinsic getters work across realms without reading input-owned
      // properties. ArrayBuffer's getter rejects SharedArrayBuffer backing.
      const backing: unknown = Reflect.apply(buffer, input, []);
      Reflect.apply(arrayBufferLength, backing, []);
      if (
        maxLength !== undefined &&
        (Reflect.apply(length, input, []) as number) > maxLength
      )
        return report(issues, `expected at most ${maxLength} bytes`, false);
      // The typed-array constructor rejects detached views and copies the
      // visible range without consulting an iterator or species constructor.
      return new Bytes(input as Uint8Array);
    } catch {
      return report(issues, expected, true);
    }
  };
}
