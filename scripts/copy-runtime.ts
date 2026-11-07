import { copyFile } from 'node:fs/promises';

// Keep the emitted helper ordinary, typechecked TypeScript rather than a second
// implementation embedded in a string template.
for (const name of [
  'runtime.ts',
  'endpoint-runtime.ts',
  'policy-types.ts',
  'runtime.browser.ts',
  'execution-runtime.ts',
  'call-runtime.ts',
  'query-runtime.ts',
  'query-sharing.ts',
])
  await copyFile(
    new URL(`../src/${name}`, import.meta.url),
    new URL(`../dist/${name}`, import.meta.url),
  );
