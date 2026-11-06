import { fail } from './diagnostics.js';

export function parseJson(source: string, path: string): unknown {
  const start = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  const body = source.slice(start);
  const location = (offset: number): string => {
    let line = 1;
    let column = 1;
    for (let index = 0; index < offset; index++) {
      if (source[index] === '\n') {
        line++;
        column = 1;
      } else column++;
    }
    return `${path}:${line}:${column}`;
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
  // deeply nested annotation data. Scan strings iteratively: a repeated regexp
  // group can exhaust the engine stack on an otherwise valid long string.
  const stack: { keys: Set<string> | undefined; keyExpected: boolean }[] = [];
  for (let index = 0; index < body.length; index++) {
    const token = body[index];
    if (token === '"') {
      const begin = index++;
      while (body[index] !== '"') index += body[index] === '\\' ? 2 : 1;
      const frame = stack[stack.length - 1];
      if (!frame?.keys || !frame.keyExpected) continue;
      const key = JSON.parse(body.slice(begin, index + 1)) as string;
      if (frame.keys.has(key))
        fail(
          location(start + begin),
          `invalid JSON: duplicate key ${JSON.stringify(key)}`,
        );
      frame.keys.add(key);
      frame.keyExpected = false;
      continue;
    }
    if (token === '{') {
      stack.push({ keys: new Set(), keyExpected: true });
    } else if (token === '[') {
      stack.push({ keys: undefined, keyExpected: false });
    } else if (token === '}' || token === ']') {
      stack.pop();
    } else {
      const frame = stack[stack.length - 1];
      if (!frame?.keys) continue;
      if (token === ',') frame.keyExpected = true;
      else if (token === ':') frame.keyExpected = false;
    }
  }
  return document;
}
