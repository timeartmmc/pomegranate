import { operations } from './symbol-generated/client.symbols.ts';

const request = operations.read_options.build({
  path: { entry: 'read_options' },
  query: { query: 'read_options' },
  headers: { 'X-Hint': 'read_options', 'X-Other': null },
  body: { tag: 'read_options', values: ['read_options', null] },
});
const tag: 'read_options' = request.body.tag;
void tag;
operations.read_uoptions.build({
  path: { entry: 'read_uoptions' },
  headers: { 'X-Hint': null },
  body: { tag: 'read_uoptions', values: [null] },
});
operations.read_options.build({
  path: { entry: 'read_options' },
  // @ts-expect-error Header validators retain their operation-specific literal.
  headers: { 'X-Hint': 'read' },
  body: { tag: 'read_options', values: [null] },
});
operations.read_uoptions.build({
  path: { entry: 'read_uoptions' },
  // @ts-expect-error An escape-looking ID must remain a distinct contract.
  body: { tag: 'read_options', values: [null] },
});
const response = request.parseResponse({ status: 200, headers: {}, body: '' });
if (response.kind === 'success') {
  const result: 'read_options' = response.data.tag;
  const value: 'read_options' | null | undefined = response.data.values[0];
  void [result, value];
  // @ts-expect-error Responses retain their operation-specific literal.
  const wrong: 'read' = response.data.tag;
  void wrong;
}

// @ts-expect-error Private-name encoding must not rename the public operation.
void operations.read_uuoptions;
