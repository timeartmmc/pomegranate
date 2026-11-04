/*
 * Copyright (c) 2012 Julian Berman
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
 *
 */
// String cases from the JSON Schema Test Suite, draft 2020-12 IPv4 format.
// https://raw.githubusercontent.com/json-schema-org/JSON-Schema-Test-Suite/efac9d6702bb1ce73ee8455cb20242be2e63b0bc/tests/draft2020-12/optional/format/ipv4.json
// Non-string cases test format annotations; POM explicitly requires a string.
export const ipv4ConformanceCases = [
  ['192.168.0.1', true],
  ['127.0.0.0.1', false],
  ['256.256.256.256', false],
  ['127.0', false],
  ['127.1', false],
  ['127.0.1', false],
  ['0x7f000001', false],
  ['2130706433', false],
  ['1২7.0.0.1', false],
  ['１９２.１６８.１.１', false],
  ['𝟏𝟗𝟐.𝟏𝟔𝟖.𝟏.𝟏', false],
  ['192.168.1.0/24', false],
  [' 192.168.0.1', false],
  ['192.168.0.1 ', false],
  ['192.168.0.1\n', false],
  ['0x7f.0.0.1', false],
  ['0o10.0.0.1', false],
  ['192.168..1', false],
  ['.192.168.0.1', false],
  ['192.168.0.1.', false],
  ['0.0.0.0', true],
  ['255.255.255.255', true],
  ['200.0.0.0', true],
  ['10.20.30.40', true],
  ['', false],
  ['+1.2.3.4', false],
  ['-1.2.3.4', false],
  ['1e2.0.0.1', false],
  ['192.168.a.1', false],
  ['192. 168.0.1', false],
  ['192.168.0.1\t', false],
  ['192.168.0.1\u0000.evil.com', false],
  ['192.168.0.1:80', false],
  ['::ffff:192.168.0.1', false],
  ['192.168.0.256', false],
] as const;
