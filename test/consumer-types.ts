import { operations } from './generated/client.consumer.js';
import type {
  PreparedRequest,
  Responses,
} from './generated/client.consumer.js';
import { execute } from './transport.js';
import { operations as staffOperations } from './generated/client.staff.js';
import {
  requestSchemas,
  responseSchemas,
} from './generated/client.staff.schemas.js';

// @ts-expect-error Staff-only operations cannot be called through the consumer client.
void operations.getStaffReport;
// @ts-expect-error Consumer-only operations cannot be called through the staff client.
void staffOperations.prepareWidget;
// @ts-expect-error A consumer-only request schema is absent from the staff client.
void requestSchemas.PreparationInput;
// @ts-expect-error A response-only staff schema needs no strict request variant.
void requestSchemas.StaffReport;
const staffReport = responseSchemas.StaffReport;
void staffReport;

export function rejectMultipartExample(
  request: PreparedRequest<Responses, 'multipart'>,
) {
  // @ts-expect-error The JSON transport cannot serialize multipart uploads.
  void execute(request, fetch, async () => 'token', 'https://example.invalid');
}

const request = operations.prepareWidget.build({
  path: { widgetId: 'example' },
  headers: { 'Idempotency-Key': 'example-key' },
  body: { acknowledged: true, label: 'Example' },
});
const consent: true = request.body.acknowledged;
void consent;

// @ts-expect-error Required request options cannot be omitted.
operations.prepareWidget.build();
// @ts-expect-error Required path parameters cannot be omitted.
operations.getWidget.build({ query: { limit: 1 } });
// @ts-expect-error An empty-body operation has no body input.
operations.checkHealth.build({ body: {} });
operations.prepareWidget.build({
  path: { widgetId: 'example' },
  headers: { 'Idempotency-Key': 'key' },
  body: {
    // @ts-expect-error The declared boolean const is preserved in request types.
    acknowledged: false,
    label: 'Example',
  },
});

operations.getWidget.build({
  path: { widgetId: 'example' },
  query: { limit: undefined },
});
const health = operations.checkHealth.build();
// @ts-expect-error Empty-body requests expose no body field.
void health.body;

const response = request.parseResponse({ status: 202, headers: {}, body: '' });
if (response.kind === 'success') {
  if (response.status === 202) {
    const reference: string = response.data.reference;
    void reference;
    // @ts-expect-error Status 202 cannot expose the status 200 refusal shape.
    void response.data.reason;
  } else {
    const reason: string = response.data.reason;
    void reason;
  }
} else if (response.kind === 'error') {
  if (response.status === 409) {
    const retryable: boolean = response.data.retryable;
    void retryable;
    // @ts-expect-error Different error statuses have different payloads.
    void response.data.detail;
  } else {
    const detail: string = response.data.detail;
    void detail;
  }
} else {
  const observedStatus: number = response.status;
  void observedStatus;
  // @ts-expect-error A protocol failure never exposes unvalidated body data.
  void response.data;
}
