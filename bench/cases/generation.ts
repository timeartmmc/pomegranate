import { typecheckCase, typecheckWorkload } from './typecheck.ts';

export const generationCase = {
  id: 'compiler-generation',
  version: 1,
  contract: typecheckCase,
} as const;
// Hold schema width and sharing fixed: only operation count changes.
export const generationProfiles = [100, 1000, 10000].map((operations) => ({
  id: `operations-${operations}`,
  components: 1,
  operations,
  width: 1,
}));
export const generationSmoke = {
  id: 'smoke',
  components: 1,
  operations: 3,
  width: 1,
};
export { typecheckWorkload as generationWorkload };
