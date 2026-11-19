export const rawUploadMediaType = 'application/octet-stream';

export const rawUploadSelection = {
  clients: ['consumer'],
  executionClients: ['consumer'],
  surfaces: { consumer: ['upload', 'uploadOptional'] },
} as const;

export function rawUploadFixture(
  media: Readonly<Record<string, unknown>> = {
    schema: { maxLength: 4 },
  },
  openapi = '3.1.2',
) {
  const operation = (operationId: string, required: boolean) => ({
    operationId,
    requestBody: { required, content: { [rawUploadMediaType]: media } },
    responses: {
      201: {
        description: 'Stored',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { size: { type: 'integer', minimum: 0 } },
              required: ['size'],
            },
          },
        },
      },
      413: {
        description: 'Rejected',
        content: { 'text/plain': { schema: { type: 'string' } } },
      },
    },
  });
  return {
    openapi,
    info: { title: 'Synthetic raw uploads', version: '1' },
    paths: {
      '/upload': { post: operation('upload', true) },
      '/optional-upload': { post: operation('uploadOptional', false) },
    },
  };
}

export const rawUploadConsumer = `
import { operations } from './client.consumer.ts';

const original = Uint8Array.of(17, 0, 255, 13, 29);
const request = operations.upload.build({ body: original.subarray(1, 4) });
const init: RequestInit = { body: request.body };
original.fill(42);
if (request.bodyKind !== 'binary' || request.contentType !== 'application/octet-stream')
  throw new Error('Expected an octet-stream request');
const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
if (bytes.join(',') !== '0,255,13') throw new Error('Upload did not preserve its byte view');
`;
