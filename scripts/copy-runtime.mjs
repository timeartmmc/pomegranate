import { copyFile } from 'node:fs/promises';

// Keep the emitted helper ordinary, typechecked TypeScript rather than a second
// implementation embedded in a string template.
await copyFile(
  new URL('../src/runtime.ts', import.meta.url),
  new URL('../dist/runtime.ts', import.meta.url),
);
