import {
  operations as browser,
  createClient as createBrowser,
} from './multipart-generated/client.browser.js';
import {
  operations as native,
  type RequestTypes,
  createClient as createNative,
} from './multipart-generated/client.native.js';

export function multipartTypes(file: File) {
  const request = browser.upload.build({
    body: {
      caption: 'Image',
      cover: file,
      attachments: [file],
      opacity: 0.25,
      position: 0,
      note: 'a\r\nb',
    },
  });
  const browserFile: File = request.body.cover;
  const opacity: number | undefined = request.body.opacity;
  const input: RequestTypes['Upload'] = {
    caption: 'Image',
    cover: { uri: 'file:///image' },
    attachments: [{ uri: 'file:///image' }],
    enabled: false,
  };
  const prepared = native.upload.build({ body: input });
  const uri: string = prepared.body.cover.uri;
  const enabled: boolean | undefined = prepared.body.enabled;
  const kind: 'multipart' = prepared.bodyKind;
  browser.uploadOptional.build();
  native.uploadOptional.build({ body: undefined });
  const optional = native.uploadOptional.build({ body: input });
  const optionalKind: 'multipart' | 'none' = optional.bodyKind;
  if (optional.bodyKind === 'multipart') {
    const optionalUri: string = optional.body.cover.uri;
    void optionalUri;
  }
  // @ts-expect-error An optional multipart body must be narrowed before access.
  optional.body;
  void optionalKind;
  // @ts-expect-error Native references cannot replace browser File values.
  browser.uploadInline.build({ body: { file: { uri: 'file:///image' } } });
  // @ts-expect-error Browser File cannot replace a native reference.
  native.uploadInline.build({ body: { file } });
  // @ts-expect-error File arrays retain their item type.
  native.upload.build({ body: { ...input, attachments: ['file:///image'] } });
  // @ts-expect-error The transport converts validated numbers to text.
  native.upload.build({ body: { ...input, opacity: '0.25' } });
  // @ts-expect-error Multipart booleans do not accept text.
  native.upload.build({ body: { ...input, enabled: 'false' } });
  // @ts-expect-error Required fields remain required.
  browser.upload.build({ body: { cover: file, attachments: [file] } });
  return { browserFile, uri, kind, opacity, enabled };
}

export async function executableMultipartTypes(file: File) {
  const config = {
    namespace: 'typed-uploads',
    execute: async () => ({ status: 201, headers: {}, body: '' }),
  };
  const browser = createBrowser(config);
  const native = createNative(config);
  await native.uploadOptional.call({ context: {} });
  const browserResult = await browser.uploadInline.call({
    context: {},
    input: { body: { file } },
  });
  const nativeResult = await native.uploadInline.call({
    context: {},
    input: { body: { file: { uri: 'native://item' } } },
  });
  const status: 201 = browserResult.status;
  const count: number = nativeResult.data.count;
  void [status, count];
  await browser.uploadInline.call({
    context: {},
    // @ts-expect-error Executable browser uploads require browser File inputs.
    input: { body: { file: { uri: 'native://item' } } },
  });
  // @ts-expect-error Executable native uploads require URI inputs.
  await native.uploadInline.call({ context: {}, input: { body: { file } } });
}
