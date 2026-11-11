import type { ContractResponse, ResponseKey } from './model.js';

function isRange(key: string): key is Exclude<ResponseKey, number | 'default'> {
  return /^[2-5]XX$/.test(key);
}

// OAS 3.1.1 §4.8.16 spells ranges with an uppercase X. Interim 1xx statuses
// never arrive as the final response a transport reports.
export function responseKey(key: string): ResponseKey | undefined {
  if (/^[2-5][0-9]{2}$/.test(key)) return Number(key);
  return key === 'default' || isRange(key) ? key : undefined;
}

function exactSuccess(key: ResponseKey): boolean {
  return typeof key === 'number' && key < 300;
}

// Every match of these keys is a success. A default match depends on the
// observed status, so it is not listed here.
export function successKey(key: ResponseKey): boolean {
  return key === '2XX' || exactSuccess(key);
}

// The declarations that can produce a success. An exact status takes
// precedence over 2XX, and 2XX over default, so only one fallback applies, and
// only while some 2xx status is left without an exact declaration.
export function successResponses(
  responses: readonly ContractResponse[],
): readonly ContractResponse[] {
  const exact = responses.filter(({ status }) => exactSuccess(status));
  if (exact.length === 100) return exact;
  const fallback =
    responses.find(({ status }) => status === '2XX') ??
    responses.find(({ status }) => status === 'default');
  return fallback ? [...exact, fallback] : exact;
}
