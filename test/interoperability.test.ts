import assert from 'node:assert/strict';
import test from 'node:test';
import { compile } from '../dist/index.js';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import {
  interoperabilityFixture,
  interoperabilitySelection,
  verifyInteroperability,
} from './interoperability-fixture.ts';
import type { MediaClient } from './media-fixture.ts';
import type { StandaloneModule } from './runtime-types.ts';

void test('schema, format, method, path, media and link support compose in one generated example', async (t) => {
  const files = await compile(
    interoperabilityFixture(),
    interoperabilitySelection,
  );
  assert.deepEqual(
    await compile(interoperabilityFixture('3.1.2'), interoperabilitySelection),
    files,
  );
  const root = await generatedTestWorkspace(t, files);
  verifyInteroperability(
    await importGenerated<MediaClient>(root, 'client.consumer.ts'),
    await importGenerated<StandaloneModule>(root, 'standalone.value.ts'),
  );
});
