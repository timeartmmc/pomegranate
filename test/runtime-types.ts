import type { ZodType } from 'zod';
import type {
  ObservedResponse,
  PreparedRequest,
  ProtocolResult,
  RequestValidationError,
  Responses,
} from '../src/runtime.ts';

// Runtime-only tables deliberately contain unknown values, including invalid
// ones. Their exact static contracts are checked by separate consumer fixtures;
// do not assert a particular body type at this dynamic loading boundary.
export interface RuntimeOperation {
  build: (input?: unknown) => PreparedRequest<Responses, 'json', unknown>;
  parseResponse: (response: ObservedResponse) => ProtocolResult<Responses>;
}
export interface RuntimeClient {
  operations: Record<string, RuntimeOperation>;
  RequestValidationError: typeof RequestValidationError;
}
export interface StandaloneModule {
  schema: ZodType;
}
