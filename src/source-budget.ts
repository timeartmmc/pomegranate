import { fail } from './diagnostics.js';

const maximumGeneratedBytes = 32 * 1024 * 1024;

// Declaration budgets stop expansion before joining a module. A separate
// budget admits complete raw modules, including imports and registry wrappers,
// exactly once; declaration bytes must not be charged to that total again.
export function sourceBudget(): (source: string, location: string) => void {
  let bytes = 0;
  return (source, location) => {
    bytes += Buffer.byteLength(source);
    if (bytes > maximumGeneratedBytes)
      fail(location, 'generated source exceeds the 32 MiB limit');
  };
}
