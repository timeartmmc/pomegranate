import {
  operations,
  type RequestTypes,
  type ResponseTypes,
} from './client.oracle.js';

const omitted: RequestTypes['OptionalChoice'] = {};
operations.checkOptionalChoice.build({ body: omitted });
operations.checkOptionalChoice.build({ body: { value: undefined } });
operations.checkOptionalChoice.build({
  body: { value: { kind: 'text', value: 'AB' } },
});
operations.checkNullableChoice.build({ body: null });
operations.checkArrayCodes.build({ body: [['AB', 'CD']] });
operations.checkMapChoice.build({
  body: { first: { kind: 'count', value: 1 } },
});
operations.checkNestedChoiceGroups.build({
  body: { groups: { first: [{ kind: 'text', value: 'AB' }, null] } },
});

// @ts-expect-error A nullable union still requires its discriminator on object values.
operations.checkNullableChoice.build({ body: { value: 'AB' } });
// @ts-expect-error Optional means omission is allowed; it does not add null.
operations.checkOptionalChoice.build({ body: { value: null } });
operations.checkOptionalChoice.build({
  // @ts-expect-error The text branch retains its string type through aliases and optional fields.
  body: { value: { kind: 'text', value: 1 } },
});
// @ts-expect-error Array nesting does not widen referenced string items to numbers.
operations.checkArrayCodes.build({ body: [[1]] });
operations.checkMapChoice.build({
  // @ts-expect-error Map entries must still satisfy the tagged union.
  body: { first: { kind: 'other', value: 1 } },
});
// @ts-expect-error The nested container keeps its required groups field.
operations.checkNestedChoiceGroups.build({ body: {} });

declare const response: ResponseTypes['OptionalChoice'];
if (response.value?.kind === 'text') {
  const code: 'AB' | 'CD' | 'EFG' = response.value.value;
  void code;
  // @ts-expect-error Discriminator narrowing survives the optional referenced union.
  const count: number = response.value.value;
  void count;
}
