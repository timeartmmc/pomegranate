import assert from 'node:assert/strict';

export const multipartSelection = {
  clients: ['browser', 'native'],
  targets: { browser: 'browser', native: 'native' },
};

export function multipartFixture() {
  const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
  const policy = {
    auth: 'public',
    retry: 'never',
    timeout: 'upload',
    surfaces: ['browser', 'native'],
  };
  const operation = (id, schema) => ({
    operationId: id,
    'x-pom': policy,
    requestBody: {
      required: true,
      content: { 'multipart/form-data': { schema } },
    },
    responses: {
      201: {
        description: 'Stored',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { count: { type: 'integer', minimum: 1 } },
              required: ['count'],
            },
          },
        },
      },
    },
  });
  return {
    openapi: '3.1.0',
    info: { title: 'Synthetic uploads', version: '1' },
    'x-pom-policy': {
      version: 2,
      auth: { public: { transport: 'none' } },
      retry: ['never'],
      timeout: ['upload'],
      surfaces: ['browser', 'native'],
    },
    components: {
      schemas: {
        File: { type: 'string', format: 'binary' },
        RawFile: {
          type: 'string',
          contentMediaType: 'application/octet-stream',
        },
        Files: { type: 'array', items: ref('RawFile'), maxItems: 2 },
        Upload: {
          type: 'object',
          properties: {
            caption: { type: 'string', minLength: 1, maxLength: 16 },
            cover: ref('File'),
            attachments: ref('Files'),
            extras: { ...ref('Files'), default: [] },
            note: {
              type: 'string',
              const: 'a\r\nb',
              minLength: 4,
              maxLength: 4,
            },
          },
          required: ['caption', 'cover', 'attachments'],
        },
      },
    },
    paths: {
      '/uploads': { post: operation('upload', ref('Upload')) },
      '/file': {
        post: operation('uploadInline', {
          type: 'object',
          properties: { file: { type: 'string', format: 'binary' } },
          required: ['file'],
        }),
      },
    },
  };
}

export async function verifyMultipart(browser, native, RequestValidationError) {
  const file = new File(['hello'], 'sample.txt', { type: 'text/plain' });
  const reference = {
    uri: 'file:///synthetic/sample.txt',
    name: 'sample.txt',
    mediaType: 'text/plain',
  };
  for (const [operations, upload] of [
    [browser, file],
    [native, reference],
  ]) {
    const body = { caption: 'Sample 🪴', cover: upload, attachments: [upload] };
    const request = operations.upload.build({ body });
    assert.equal(request.bodyKind, 'multipart');
    assert.equal(request.url, '/uploads');
    assert.deepEqual(request.body, body);
    assert.notEqual(request.body, body);
    assert.notEqual(request.body.attachments, body.attachments);
    assert.equal(Object.hasOwn(request.body, 'extras'), false);
    assert.deepEqual(request.multipart, [
      { name: 'attachments', kind: 'file', multiple: true, required: true },
      { name: 'caption', kind: 'text', multiple: false, required: true },
      { name: 'cover', kind: 'file', multiple: false, required: true },
      { name: 'extras', kind: 'file', multiple: true, required: false },
      { name: 'note', kind: 'text', multiple: false, required: false },
    ]);
    assert.equal(Object.isFrozen(request.multipart), true);
    assert.equal(Object.isFrozen(request.multipart[0]), true);
    const invalid = [
      { ...body, attachments: [] },
      { ...body, attachments: [upload, upload, upload] },
      { ...body, cover: undefined },
      { ...body, caption: '' },
      { ...body, caption: 'x'.repeat(17) },
      { ...body, caption: '\ud800' },
      { ...body, note: 'a\nb' },
      { ...body, cover: 'file.txt' },
      { ...body, extras: [upload, upload, upload] },
      { ...body, unknown: 'field' },
    ];
    for (const value of invalid)
      assert.throws(
        () => operations.upload.build({ body: value }),
        RequestValidationError,
      );
    for (const caption of [
      '\r',
      '\n',
      'a\rb',
      'a\nb',
      'a\r\nb\nc',
      'a\r\r\nb',
      'x'.repeat(15) + '\n',
    ]) {
      const value = { ...body, caption };
      assert.throws(
        () => operations.upload.build({ body: value }),
        (error) =>
          error instanceof RequestValidationError &&
          error.issues.some(
            (issue) =>
              issue.path.join('.') === 'body.caption' &&
              issue.message.includes('CRLF'),
          ),
      );
      assert.equal(value.caption, caption);
    }
    for (const caption of [
      '\r\n',
      'a\r\nb',
      '\r\na\r\n',
      'x'.repeat(14) + '\r\n',
    ]) {
      const value = { ...body, caption, note: 'a\r\nb' };
      const prepared = operations.upload.build({ body: value });
      assert.deepEqual(prepared.body, value);
      const form = new FormData();
      for (const field of prepared.multipart)
        if (field.kind === 'text')
          form.append(field.name, prepared.body[field.name]);
      // FormData.get does not expose newline changes made during encoding.
      // Decode the actual multipart bytes before checking the contract again.
      const encoded = new Request('https://synthetic.invalid/uploads', {
        method: 'POST',
        body: form,
      });
      const decoded = await encoded.formData();
      assert.equal(decoded.get('caption'), caption);
      assert.equal(decoded.get('note'), value.note);
      assert.doesNotThrow(() =>
        operations.upload.build({
          body: {
            ...body,
            caption: decoded.get('caption'),
            note: decoded.get('note'),
          },
        }),
      );
      assert.deepEqual(value, { ...body, caption, note: 'a\r\nb' });
    }
    assert.throws(
      () => operations.upload.build({ body: { ...body, attachments: [] } }),
      (error) =>
        error.issues.some(
          (issue) => issue.path.join('.') === 'body.attachments',
        ),
    );
    assert.deepEqual(
      operations.upload.build({ body: { ...body, extras: [] } }).body.extras,
      [],
    );
    assert.deepEqual(
      operations.uploadInline.build({ body: { file: upload } }).body,
      { file: upload },
    );
    const response = request.parseResponse({
      status: 201,
      headers: { 'content-type': 'application/json' },
      body: '{"count":2,"extra":true}',
    });
    assert.equal(response.kind, 'success');
    assert.deepEqual(response.data, { count: 2 });
  }
  assert.throws(
    () => browser.uploadInline.build({ body: { file: reference } }),
    RequestValidationError,
  );
  assert.throws(
    () => browser.uploadInline.build({ body: { file: new Blob(['hello']) } }),
    RequestValidationError,
  );
  assert.throws(
    () => native.uploadInline.build({ body: { file } }),
    RequestValidationError,
  );
  for (const value of [
    { uri: '' },
    { uri: 'local', name: '' },
    { uri: 'local', mediaType: '' },
    { uri: 'local', extra: true },
  ])
    assert.throws(
      () => native.uploadInline.build({ body: { file: value } }),
      RequestValidationError,
    );
  const request = native.uploadInline.build({ body: { file: reference } });
  reference.uri = 'changed';
  assert.equal(request.body.file.uri, 'file:///synthetic/sample.txt');

  // This serializer represents application code. POM supplies the complete
  // validated body and field inventory; it never constructs FormData itself.
  const form = new FormData();
  const prepared = browser.upload.build({
    body: {
      caption: 'Saved',
      cover: file,
      attachments: [file, file],
      extras: [],
    },
  });
  for (const field of prepared.multipart) {
    const value = prepared.body[field.name];
    for (const part of field.multiple
      ? (value ?? [])
      : value === undefined
        ? []
        : [value])
      form.append(field.name, part);
  }
  assert.deepEqual(
    [...form.keys()],
    ['attachments', 'attachments', 'caption', 'cover'],
  );
  assert.equal(form.get('caption'), 'Saved');
  assert.equal(await form.get('cover').text(), 'hello');
  assert.equal(form.getAll('attachments').length, 2);

  const globals = { File: globalThis.File, FormData: globalThis.FormData };
  try {
    delete globalThis.File;
    delete globalThis.FormData;
    assert.equal(
      native.uploadInline.build({ body: { file: { uri: 'file:///local' } } })
        .body.file.uri,
      'file:///local',
    );
    assert.throws(
      () => browser.uploadInline.build({ body: { file } }),
      RequestValidationError,
    );
  } finally {
    Object.assign(globalThis, globals);
  }
}
