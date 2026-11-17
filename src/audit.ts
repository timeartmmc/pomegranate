import { buildDescriptor, openApiDocument } from './descriptor.js';
import {
  ContractError,
  ContractErrors,
  ContractWorkError,
  schemaWarnings,
  errorSource,
  fail,
} from './diagnostics.js';
import type { CompileWarning } from './diagnostics.js';
import { parseOperationExclusions, operationFilter } from './exclusions.js';
import { selectClients, selectStandalone } from './projection.js';
import { parseIgnoredExtensions, parseSelection } from './selection.js';

export type AuditDiagnostic = Readonly<{
  operationIds: readonly string[];
  location: string;
  message: string;
}>;

export type AuditResult = Readonly<{
  clean: boolean;
  complete: boolean;
  supportedOperations: readonly string[];
  failedOperations: readonly string[];
  unassessedOperations: readonly string[];
  excludeOperations: readonly string[];
  diagnostics: readonly AuditDiagnostic[];
  warnings: readonly CompileWarning[];
}>;

// Diagnose a compatible operation subset using the canonical compiler. Shared
// dependencies are indexed once; one failed component removes all its users in
// the next validation attempt. Rendering and output ownership are not involved.
export function auditContract(
  document: unknown,
  selection: Record<string, unknown>,
): AuditResult {
  const parsed = parseSelection(selection);
  if (
    selection.pruneUnusedComponents !== undefined &&
    typeof selection.pruneUnusedComponents !== 'boolean'
  )
    fail('pruneUnusedComponents', 'expected a boolean');
  const ignoredExtensions = parseIgnoredExtensions(selection.ignoreExtensions);
  let remaining = 10_000_000;
  const charge = (amount: number): void => {
    if ((remaining -= amount) < 0)
      throw new ContractWorkError(
        'audit',
        'operation audit exceeds the supported limit of 10000000 work units; reduce or split the input contract',
      );
  };
  const initial = parseOperationExclusions(selection.excludeOperations, charge);
  const index = operationFilter(
    openApiDocument(document),
    selection.standalone,
    charge,
  );
  index.validateExclusions(initial);
  const operationIds = [...index.operations.keys()]
    .filter((id) => !initial.has(id))
    .sort();
  const failed = new Set<string>();
  const diagnostics: AuditDiagnostic[] = [];
  // One collector spans every retry: it counts each source location once.
  const warnings = schemaWarnings();
  const { warn } = warnings;
  let supported: readonly string[] = [];
  let unassessed: readonly string[] = [];
  let complete = false;
  const pending = () => operationIds.filter((id) => !failed.has(id));
  for (;;) {
    // Keep the original source registry for every retry: a retained fragment
    // may live inside an operation removed by this or an earlier attempt.
    const excluded = new Set([...initial, ...failed]);
    try {
      const filtered = index.select(
        excluded,
        selection.pruneUnusedComponents === true,
        true,
      );
      const descriptor = buildDescriptor(filtered.document, {
        collectErrors: true,
        excludedOperations: [...excluded],
        schemaSources: filtered.schemaSources,
        ignoreExtensions: ignoredExtensions,
        warn,
        ...(Object.hasOwn(selection, 'surfaces')
          ? { surfaces: selection.surfaces }
          : {}),
        ...(Object.hasOwn(selection, 'formats')
          ? { formats: selection.formats }
          : {}),
      });
      // Check selected compiler features too, without formatting generated code.
      selectStandalone(descriptor, parsed.standalone, warn);
      selectClients(descriptor, parsed);
      supported = pending();
      complete = true;
      break;
    } catch (error) {
      const errors =
        error instanceof ContractErrors
          ? error.errors
          : error instanceof ContractError
            ? [error]
            : undefined;
      if (!errors) throw error;
      let blocked = false;
      let progress = false;
      for (const diagnostic of errors) {
        let affected: readonly string[] = [];
        try {
          if (!(diagnostic instanceof ContractWorkError))
            // A retained dependency can still fail after all its users were
            // excluded. Report it globally; only same-attempt duplicates skip
            // below when their operations have just joined the failed set.
            affected = index
              .affected(errorSource(diagnostic))
              .filter((id) => !excluded.has(id));
        } catch (attributionError) {
          if (!(attributionError instanceof ContractError))
            throw attributionError;
          diagnostics.push({
            operationIds: [],
            location: attributionError.location,
            message: attributionError.message,
          });
          if (attributionError instanceof ContractWorkError) {
            blocked = true;
            break;
          }
        }
        if (affected.length === 0) blocked = true;
        else {
          affected = affected.filter((id) => !failed.has(id));
          if (affected.length === 0) continue;
          for (const id of affected) failed.add(id);
          progress = true;
        }
        diagnostics.push({
          operationIds: affected,
          location: diagnostic.location,
          message: diagnostic.message,
        });
      }
      if (blocked || !progress) {
        unassessed = pending();
        break;
      }
    }
  }
  return {
    clean: diagnostics.length === 0,
    complete,
    supportedOperations: supported,
    failedOperations: [...failed].sort(),
    unassessedOperations: unassessed,
    excludeOperations: [...initial, ...failed].sort(),
    diagnostics,
    warnings: warnings.values(),
  };
}
