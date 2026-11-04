import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { browserFile } from '../dist/runtime.browser.js';
import { invalid } from '../dist/runtime.js';
import type { Issues } from '../dist/runtime.js';

void test('browser File validation checks native data without reading overridden public properties', () => {
  const file = new File(['contents'], 'native.txt');
  const subclass = new (class extends File {})(['subclass'], 'subclass.txt');
  const reparented = new File(['reparented'], 'reparented.txt');
  Object.setPrototypeOf(reparented, Object.create(File.prototype) as object);
  let reads = 0;
  for (const property of ['name', 'size'])
    Object.defineProperty(file, property, {
      get() {
        reads++;
        throw new Error('overridden public getters must not run');
      },
    });
  for (const value of [file, subclass, reparented]) {
    const issues: Issues = [];
    assert.equal(browserFile(value, issues), value);
    assert.deepEqual(issues, []);
  }
  assert.equal(reads, 0);
  const revoked = Proxy.revocable(file, {});
  revoked.revoke();
  const fake: unknown = Object.create(File.prototype);
  const blobAsFile = new Blob(['blob']);
  Object.setPrototypeOf(blobAsFile, File.prototype);
  for (const value of [
    undefined,
    null,
    'file',
    {},
    new Blob(['blob']),
    blobAsFile,
    fake,
    revoked.proxy,
    { [Symbol.toStringTag]: 'File' },
    {
      get name() {
        reads++;
        throw new Error('a File-like getter must not run');
      },
    },
    new Proxy(file, {
      get() {
        throw new Error('platform access failed');
      },
    }),
  ]) {
    const issues: Issues = [];
    assert.equal(browserFile(value, issues), invalid);
    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.message, 'expected a browser File');
  }
  assert.equal(reads, 0);
});

void test('metadata-only platform File imitations cannot supply missing Blob data', () => {
  const file = new File(['native bytes'], 'native.txt');
  // Node versions can store File metadata in an own symbol independently of
  // Blob backing. Discover partial state without depending on private names;
  // platforms with opaque native slots expose no such partial imitation.
  for (const key of Reflect.ownKeys(file)) {
    const imitation: unknown = Object.create(File.prototype, {
      [key]: Object.getOwnPropertyDescriptor(file, key)!,
    });
    let name: unknown;
    try {
      name = Reflect.get(File.prototype, 'name', imitation);
    } catch {
      continue;
    }
    if (typeof name !== 'string') continue;
    const issues: Issues = [];
    assert.equal(browserFile(imitation, issues), invalid);
    assert.equal(issues.length, 1);
  }
});

void test('File representations agree with native multipart filenames and bytes', async () => {
  const file = () => new File(['native bytes'], 'original.txt');
  const reparent = (prototype: object | null) => {
    const value = file();
    Object.setPrototypeOf(value, prototype);
    return value;
  };
  const foreign: unknown = runInNewContext('({})');
  const foreignSpoof: unknown = runInNewContext(
    '({[Symbol.toStringTag]:"File"})',
  );
  assert.ok(typeof foreign === 'object' && foreign !== null);
  assert.ok(typeof foreignSpoof === 'object' && foreignSpoof !== null);
  const candidates: readonly (readonly [string, unknown])[] = [
    ['ordinary', file()],
    ['subclass', new (class extends File {})(['native bytes'], 'original.txt')],
    ['transparent proxy', new Proxy(file(), {})],
    // oxlint-disable-next-line typescript/no-misused-spread -- Reproduce copied Node File state without the required prototype.
    ['spread', { ...file() }],
    ['assign', Object.assign({}, file())],
    // oxlint-disable-next-line typescript/no-misused-spread -- A spoofed tag must not rescue copied File state.
    ['tag spoof', { ...file(), [Symbol.toStringTag]: 'File' }],
    ['foreign copy', Object.assign(foreign, file())],
    ['foreign tag spoof', Object.assign(foreignSpoof, file())],
    ['null prototype', reparent(null)],
    ['nested null prototype', reparent(Object.create(null) as object)],
    ['Object prototype', reparent(Object.prototype)],
    [
      'foreign Object prototype',
      reparent(Object.getPrototypeOf(foreign) as object),
    ],
    ['Blob prototype', reparent(Object.create(Blob.prototype) as object)],
    [
      'File prototype bridge',
      reparent(Object.create(File.prototype) as object),
    ],
    ['forged prototype', Object.create(File.prototype) as unknown],
  ];
  for (const [label, value] of candidates) {
    let compatible = false;
    try {
      const form = new FormData();
      // Exercise native conversion of deliberately malformed JavaScript inputs.
      form.append('file', value as File);
      const received = (await new Response(form).formData()).get('file');
      compatible =
        received instanceof File &&
        received.name === 'original.txt' &&
        (await received.text()) === 'native bytes';
    } catch {
      // A rejected value or failed serialization cannot be a prepared File.
    }
    const issues: Issues = [];
    const parsed = browserFile(value, issues);
    assert.equal(parsed !== invalid, compatible, label);
    if (parsed === invalid) assert.equal(issues.length, 1, label);
    else {
      assert.equal(parsed, value, label);
      assert.deepEqual(issues, [], label);
    }
  }
});

void test('browser runtime imports without File and recognizes later platform availability', async () => {
  const result = await promisify(execFile)(process.execPath, [
    '--input-type=module',
    '-e',
    `
      import assert from 'node:assert/strict';
      const NativeFile = globalThis.File;
      delete globalThis.File;
      const {browserFile} = await import(process.argv[1]);
      const issues = [];
      assert.equal(typeof browserFile({name:'fake'}, issues), 'symbol');
      assert.equal(issues.length, 1);
      globalThis.File = NativeFile;
      const file = new NativeFile(['late'], 'late.txt');
      assert.equal(browserFile(file, []), file);
    `,
    new URL('../dist/runtime.browser.js', import.meta.url).href,
  ]);
  assert.equal(result.stderr, '');
});

void test('File validation follows current getter and own-field constructor environments', async () => {
  await promisify(execFile)(process.execPath, [
    '--input-type=module',
    '-e',
    `
      import assert from 'node:assert/strict';
      const NativeFile = File, NativeBlob = Blob;
      const {browserFile} = await import(process.argv[1]);
      class GetterFile extends NativeBlob {
        #name;
        constructor(bits, name) { super(bits); this.#name = name; }
        get name() { return this.#name; }
      }
      class FieldFile extends NativeBlob {
        constructor(bits, name) { super(bits); this.name = name; }
      }
      class GetterSubclass extends GetterFile {}
      for (const Current of [NativeFile, GetterFile, FieldFile, GetterSubclass, FieldFile, NativeFile]) {
        globalThis.File = Current;
        globalThis.Blob = NativeBlob;
        const file = new Current(['bytes'], 'real.txt');
        assert.equal(browserFile(file, []), file);
        assert.equal(await file.text(), 'bytes');
        for (const fake of [Object.create(Current.prototype), {...file}, Object.assign({}, file)])
          assert.equal(typeof browserFile(fake, []), 'symbol');
      }
      // Bun exposes File metadata on a prototype shared with Blob.
      globalThis.File = GetterFile;
      globalThis.Blob = GetterFile;
      const shared = new GetterFile(['shared bytes'], 'shared.txt');
      assert.equal(browserFile(shared, []), shared);
      assert.equal(await shared.text(), 'shared bytes');
      globalThis.File = FieldFile;
      const file = new FieldFile(['bytes'], 'real.txt');
      globalThis.Blob = class extends NativeBlob { get size() { throw new TypeError('wrong environment'); } };
      assert.equal(typeof browserFile(file, []), 'symbol');
      globalThis.Blob = NativeBlob;
      assert.equal(browserFile(file, []), file);
      const fake = new NativeBlob(['bytes']);
      Object.setPrototypeOf(fake, FieldFile.prototype);
      let reads = 0;
      for (const descriptor of [
        {value:'polluted.txt', configurable:true},
        {get() { reads++; return 'polluted.txt'; }, configurable:true}
      ]) {
        Object.defineProperty(Object.prototype, 'name', descriptor);
        try {
          assert.equal(browserFile(file, []), file);
          assert.equal(typeof browserFile(fake, []), 'symbol');
        } finally { delete Object.prototype.name; }
      }
      assert.equal(reads, 0);
      Object.defineProperty(file, 'name', {get() { reads++; return 'fake.txt'; }, configurable:true});
      assert.equal(typeof browserFile(file, []), 'symbol');
      assert.equal(reads, 0);
      globalThis.File = NativeFile;
    `,
    new URL('../dist/runtime.browser.js', import.meta.url).href,
  ]);
});
