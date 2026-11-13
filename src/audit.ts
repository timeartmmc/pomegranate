import { buildDescriptor, openApiDocument } from './descriptor.js';
import {
  ContractError,
  ContractErrors,
  ContractWorkError,
  schemaWarnings,
} from './diagnostics.js';
import type { CompileWarning } from './diagnostics.js';
import { excludeOperations, operationFilter } from './exclusions.js';
import { ignoreExtensions } from './extensions.js';
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
  const initial = excludeOperations(
    openApiDocument(document),
    selection.excludeOperations,
    selection.standalone,
    selection.pruneUnusedComponents,
  );
  const ignoredExtensions = parseIgnoredExtensions(selection.ignoreExtensions);
  let remaining = 10_000_000;
  const index = operationFilter(
    initial.document,
    selection.standalone,
    (amount) => {
      if ((remaining -= amount) < 0)
        throw new ContractWorkError(
          'audit',
          'operation audit exceeds the supported limit of 10000000 work units; reduce or split the input contract',
        );
    },
  );
  const operationIds = [...index.operations.keys()].sort();
  const failed = new Set<string>();
  const diagnostics: AuditDiagnostic[] = [];
  const warnings = schemaWarnings();
  const warned = new Set<string>();
  const warn = (path: string, message: string): void => {
    const key = `${path}\0${message}`;
    if (warned.has(key)) return;
    warned.add(key);
    warnings.warn(path, message);
  };
  let supported: readonly string[] = [];
  let unassessed: readonly string[] = [];
  let complete = false;
  const pending = () => operationIds.filter((id) => !failed.has(id));
  for (;;) {
    const excluded = new Set(failed);
    try {
      const filtered = index.select(
        excluded,
        selection.pruneUnusedComponents === true,
      );
      const descriptor = buildDescriptor(
        ignoreExtensions(filtered.document, ignoredExtensions),
        {
          collectErrors: true,
          excludedOperations: [...initial.excluded, ...failed],
          warn,
          ...(Object.hasOwn(selection, 'surfaces')
            ? { surfaces: selection.surfaces }
            : {}),
          ...(Object.hasOwn(selection, 'formats')
            ? { formats: selection.formats }
            : {}),
        },
      );
      // Check selected compiler features too, without formatting generated code.
      selectStandalone(descriptor, parsed.standalone);
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
              .affected(diagnostic.location)
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
    excludeOperations: [...initial.excluded, ...failed].sort(),
    diagnostics,
    warnings: warnings.values(),
  };
}
