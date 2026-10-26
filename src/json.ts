import { fail } from './diagnostics.js';

export function parseJson(source: string, path: string): unknown {
  const start = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  const body = source.slice(start);
  const location = (offset: number): string => {
    const prefix = source.slice(0, offset);
    const line = 1 + (prefix.match(/\n/g)?.length ?? 0);
    return `${path}:${line}:${offset - prefix.lastIndexOf('\n')}`;
  };
  let document: unknown;
  try {
    document = JSON.parse(body) as unknown;
  } catch (error) {
    const position =
      error instanceof SyntaxError
        ? /position (\d+)(?: \(line \d+ column \d+\))?$/.exec(
            error.message,
          )?.[1]
        : undefined;
    const offset =
      position !== undefined
        ? start + Number(position)
        : error instanceof SyntaxError && /end of JSON/.test(error.message)
          ? source.length
          : start;
    fail(location(offset), 'invalid JSON');
  }
  // JSON.parse owns syntax and value interpretation, but discards duplicate
  // members before a reviver can see them. Scan the already-valid token stream
  // to reject that ambiguity without changing values or recursively walking
  // deeply nested annotation data. Strings are consumed whole, including escapes.
  const tokens = /"(?:[^"\\]|\\[\s\S])*"|[{}[\]:,]/g;
  const stack: { keys?: Set<string>; keyExpected: boolean }[] = [];
  for (const match of body.matchAll(tokens)) {
    const token = match[0];
    if (token === '{') {
      stack.push({ keys: new Set(), keyExpected: true });
    } else if (token === '[') {
      stack.push({ keyExpected: false });
    } else if (token === '}' || token === ']') {
      stack.pop();
    } else {
      const frame = stack[stack.length - 1];
      if (!frame?.keys) continue;
      if (token === ',') frame.keyExpected = true;
      else if (token === ':') frame.keyExpected = false;
      else if (frame.keyExpected) {
        const key = JSON.parse(token) as string;
        if (frame.keys.has(key)) {
          fail(
            location(start + match.index),
            `invalid JSON: duplicate key ${JSON.stringify(key)}`,
          );
        }
        frame.keys.add(key);
        frame.keyExpected = false;
      }
    }
  }
  return document;
}
