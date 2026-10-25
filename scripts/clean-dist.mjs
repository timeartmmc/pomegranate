import { rm } from 'node:fs/promises';

// dist is this package's disposable build output. A source rename must not leave
// an obsolete module in a subsequently packed compiler.
// Keep the final path unsuffixed: a trailing slash follows a directory symlink.
await rm(new URL('../dist', import.meta.url), { recursive: true, force: true });
