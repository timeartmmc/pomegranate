import { copyFile, mkdir } from 'node:fs/promises';

// Keep the emitted helper ordinary, typechecked TypeScript rather than a second
// implementation embedded in a string template.
// Separate templates from declarations: ./runtime.js in the public API must
// resolve to runtime.d.ts rather than making consumers compile its raw source.
await mkdir(new URL('../dist/templates/', import.meta.url), {
  recursive: true,
});
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
    new URL(`../dist/templates/${name}`, import.meta.url),
  );
