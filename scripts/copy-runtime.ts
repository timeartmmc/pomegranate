import { copyFile } from 'node:fs/promises';

// Keep the emitted helper ordinary, typechecked TypeScript rather than a second
// implementation embedded in a string template.
for (const name of ['runtime.ts', 'runtime.browser.ts', 'query-runtime.ts'])
  await copyFile(
    new URL(`../src/${name}`, import.meta.url),
    new URL(`../dist/${name}`, import.meta.url),
  );
