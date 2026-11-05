import assert from 'node:assert/strict';
import test from 'node:test';
import { compile } from '../dist/index.js';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { StandaloneModule } from './runtime-types.ts';

for (const pollution of ['pattern', 'check', 'both'])
  void test(`generated built-in and registered formats ignore inherited ${pollution} rules`, async (t) => {
    const files = await compile(
      {
        openapi: '3.1.2',
        info: { title: 'Synthetic inherited format rules', version: '1' },
        paths: {},
        components: {
          schemas: {
            Uuid: { type: 'string', format: 'uuid' },
            Slug: { type: 'string', format: 'slug' },
          },
        },
      },
      {
        clients: [],
        formats: { slug: { type: 'string', pattern: '^[a-z]+$' } },
        standalone: {
          uuid: { schema: '#/components/schemas/Uuid', usage: 'request' },
          slug: { schema: '#/components/schemas/Slug', usage: 'response' },
        },
      },
    );
    const root = await generatedTestWorkspace(t, files);
    const uuid = await importGenerated<StandaloneModule>(
      root,
      'standalone.uuid.ts',
    );
    const slug = await importGenerated<StandaloneModule>(
      root,
      'standalone.slug.ts',
    );
    const previous = new Map(
      ['pattern', 'check'].map((name) => [
        name,
        Object.getOwnPropertyDescriptor(Object.prototype, name),
      ]),
    );
    let inheritedChecks = 0;
    try {
      if (pollution !== 'check')
        Object.defineProperty(Object.prototype, 'pattern', {
          configurable: true,
          value: '.*',
        });
      if (pollution !== 'pattern')
        Object.defineProperty(Object.prototype, 'check', {
          configurable: true,
          value: () => {
            inheritedChecks++;
            return true;
          },
        });
      // Parsing first under pollution exercises the lazy rule compilation too.
      assert.equal(uuid.schema.safeParse('not-a-uuid').success, false);
      assert.equal(slug.schema.safeParse('BAD slug').success, false);
      assert.equal(
        uuid.schema.parse('123e4567-e89b-42d3-a456-426614174000'),
        '123e4567-e89b-42d3-a456-426614174000',
      );
      assert.equal(slug.schema.parse('ready'), 'ready');
      assert.equal(inheritedChecks, 0);
    } finally {
      for (const [name, descriptor] of previous) {
        if (descriptor)
          Object.defineProperty(Object.prototype, name, descriptor);
        else Reflect.deleteProperty(Object.prototype, name);
      }
    }
  });
