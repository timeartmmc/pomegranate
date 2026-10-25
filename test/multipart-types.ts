import { operations as browser } from './multipart-generated/client.browser.js';
import {
  operations as native,
  type RequestTypes,
} from './multipart-generated/client.native.js';

export function multipartTypes(file: File) {
  const request = browser.upload.build({
    body: {
      caption: 'Image',
      cover: file,
      attachments: [file],
      note: 'a\r\nb',
    },
  });
  const browserFile: File = request.body.cover;
  const input: RequestTypes['Upload'] = {
    caption: 'Image',
    cover: { uri: 'file:///image' },
    attachments: [{ uri: 'file:///image' }],
  };
  const prepared = native.upload.build({ body: input });
  const uri: string = prepared.body.cover.uri;
  const kind: 'multipart' = prepared.bodyKind;
  // @ts-expect-error Native references cannot replace browser File values.
  browser.uploadInline.build({ body: { file: { uri: 'file:///image' } } });
  // @ts-expect-error Browser File cannot replace a native reference.
  native.uploadInline.build({ body: { file } });
  // @ts-expect-error File arrays retain their item type.
  native.upload.build({ body: { ...input, attachments: ['file:///image'] } });
  // @ts-expect-error Required fields remain required.
  browser.upload.build({ body: { cover: file, attachments: [file] } });
  return { browserFile, uri, kind };
}
