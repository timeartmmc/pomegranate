import { operations } from './schema-generated/client.samples.js';
import type {
  RequestTypes,
  ResponseTypes,
} from './schema-generated/client.samples.js';
import type { Output as Message } from './schema-generated/standalone.message.js';
import type {
  Input as EmptyInput,
  Output as EmptyOutput,
} from './schema-generated/standalone.empty.js';
const emptyInput: EmptyInput = {};
const emptyOutput: EmptyOutput = {};
const emptyResponse: ResponseTypes['Empty'] = {};
operations.checkEmpty.build({ body: emptyInput });
void emptyOutput;
void emptyResponse;
// @ts-expect-error An empty fixed object excludes primitives at the builder boundary.
operations.checkEmpty.build({ body: 42 });
// @ts-expect-error Response maps preserve the empty-object constraint.
const wrongEmptyResponse: ResponseTypes['Empty'] = false;
// @ts-expect-error Standalone output excludes primitives too.
const wrongEmptyStandalone: EmptyOutput = 'text';
operations.checkEmptyContainers.build({
  // @ts-expect-error Nested inline empty objects retain their constraint.
  body: { child: {}, inline: 1, array: [{}], map: { first: {} } },
});
void wrongEmptyResponse;
void wrongEmptyStandalone;
const message: Message = { kind: 'circle', radius: 1 };
const shape: ResponseTypes['Shape'] = message;
const defaults: RequestTypes['Defaults'] = { required: false };
class CircleInput {
  kind = 'circle' as const;
  radius = 1;
}
operations.checkShape.build({ body: new CircleInput() });
void shape;
void defaults;

const circle: RequestTypes['Shape-Circle'] = { kind: 'circle', radius: 1 };
const rectangle: ResponseTypes['Shape.Circle'] = {
  kind: 'rectangle',
  width: 2,
};
const enabled: RequestTypes['Shape_Circle'] = true;
operations.checkNamedComponents.build({
  body: { hyphen: circle, period: rectangle, underscore: enabled },
});
// @ts-expect-error Component names preserve their exact, distinct schema types.
const mismatched: RequestTypes['Shape-Circle'] = rectangle;
void mismatched;

operations.checkShape.build({ body: { kind: 'circle', radius: 1 } });
operations.checkNullableShape.build({ body: null });
operations.checkShapeMap.build({
  body: { example: { kind: 'rectangle', width: 2 } },
});
operations.checkLocation.build({ body: ['field', 1], query: { index: [0] } });
type ScalarBody = Parameters<typeof operations.checkScalars.build>[0]['body'];
declare const scalarBody: ScalarBody;
operations.checkScalars.build({
  body: scalarBody,
  query: {
    q: null,
    cursor: null,
    count: null,
    ratio: null,
    active: null,
    date: null,
    instant: null,
    id: null,
  },
});
operations.checkScalars.build({
  body: scalarBody,
  query: { count: 0, ratio: 0.25, active: false, q: '' },
});
operations.checkScalars.build({
  body: scalarBody,
  query: { count: undefined, active: undefined },
});
// @ts-expect-error Nullable numeric queries still exclude strings.
operations.checkScalars.build({ body: scalarBody, query: { count: '0' } });
// @ts-expect-error Nullable boolean queries still exclude numbers.
operations.checkScalars.build({ body: scalarBody, query: { active: 0 } });
// @ts-expect-error Null is only allowed by a nullable parameter schema.
operations.checkScalars.build({ body: scalarBody, query: { limit: null } });
// @ts-expect-error Null does not make a query array nullable.
operations.checkScalars.build({ body: scalarBody, query: { tags: null } });
operations.checkScalars.build({
  body: scalarBody,
  query: { tags: ['one'] },
  headers: { 'X-Note': null },
});
// @ts-expect-error Query arrays retain their item type.
operations.checkScalars.build({ body: scalarBody, query: { tags: [1] } });
operations.checkScalars.build({
  body: scalarBody,
  // @ts-expect-error Transport-owned headers are supplied after building.
  headers: { 'X-Origin': 'native' },
});
operations.checkDefaults.build({ body: { required: false, count: undefined } });
// @ts-expect-error A default does not make a required field optional.
operations.checkDefaults.build({ body: {} });
// @ts-expect-error Tagged union branches keep their own fields.
operations.checkShape.build({ body: { kind: 'circle', width: 2 } });
// @ts-expect-error A nullable schema still excludes other primitive values.
operations.checkNullableShape.build({ body: 1 });
// @ts-expect-error Map values retain the union rather than becoming unknown.
operations.checkShapeMap.build({ body: { bad: false } });
// @ts-expect-error JSON map values cannot be undefined.
operations.checkJsonMap.build({ body: { bad: undefined } });
// @ts-expect-error The string/integer union excludes booleans.
operations.checkLocation.build({ body: [false], query: { index: [0] } });
const result = operations.checkShape.parseResponse({
  status: 200,
  headers: {},
  body: '',
});
if (result.kind === 'success' && result.data.kind === 'circle') {
  const radius: number = result.data.radius;
  void radius;
  // @ts-expect-error The discriminator narrows the response branch.
  void result.data.width;
}
