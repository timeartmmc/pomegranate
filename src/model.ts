import type { Security, StringFormat } from './runtime.js';

export type Scalar = string | number | boolean | null;
export type Direction = 'request' | 'response';
export type RegisteredStringFormat = Readonly<{
  name: string;
  pattern: string;
}>;
export type SchemaFormat = StringFormat | RegisteredStringFormat;
export type Constraints = {
  readonly minLength: number | undefined;
  readonly maxLength: number | undefined;
  readonly pattern: string | undefined;
  readonly minimum: number | undefined;
  readonly maximum: number | undefined;
  readonly exclusiveMinimum: number | undefined;
  readonly exclusiveMaximum: number | undefined;
  readonly multipleOf: number | undefined;
  readonly float: true | undefined;
  readonly minItems: number | undefined;
  readonly maxItems: number | undefined;
  // Only true asserts uniqueness; false is the JSON Schema default.
  readonly uniqueItems: true | undefined;
  readonly minProperties: number | undefined;
  readonly maxProperties: number | undefined;
};
export type ConstraintInput = Partial<Constraints>;

export type SchemaDraft = {
  readonly readOnly?: boolean | undefined;
  readonly writeOnly?: boolean | undefined;
} & (
  | { readonly kind: 'json' }
  | { readonly kind: 'binary' }
  | {
      // Normalization folds object conjunctions before projection. Only scalar
      // intersections retain branches in the validated descriptor.
      readonly kind: 'intersection';
      readonly branches: readonly Schema[];
      readonly location: string;
      readonly literals?: readonly Scalar[] | undefined;
    }
  | {
      readonly kind: 'ref';
      readonly name: string;
      readonly location: string;
      // Siblings restrict the referenced base; they do not replace its kind or
      // constraints. Terminal nodes carry their type-specific limits inline.
      readonly constraints: Constraints;
    }
  | {
      readonly kind: 'map';
      readonly additionalPropertiesExplicit?: boolean | undefined;
      readonly values: Schema | true;
      readonly minProperties?: number | undefined;
      readonly maxProperties?: number | undefined;
    }
  | {
      readonly kind: 'union';
      readonly branches: readonly Schema[];
      // anyOf accepts any matching branch; oneOf requires exactly one. Keep this
      // independent of discriminator dispatch, which selects one tagged branch.
      readonly cardinality?: 'any' | 'one' | undefined;
      // Diagnostic provenance: these branches came from a nullable type
      // declaration, rather than an anyOf keyword in the source document.
      readonly sourceTypeArray?: true | undefined;
      readonly discriminator?:
        | {
            readonly propertyName: string;
            // Tag to branch position, so composed branches keep their tags.
            readonly mapping: ReadonlyMap<string, number>;
          }
        | undefined;
    }
  | {
      readonly kind: 'object';
      // Preserve source closure and object-type assertions until composition;
      // an omitted type in an object fragment must not narrow primitive values.
      readonly closed?: boolean | undefined;
      readonly typeExplicit?: boolean | undefined;
      readonly additionalPropertiesExplicit?: boolean | undefined;
      readonly properties: ReadonlyMap<string, Schema>;
      readonly required: readonly string[];
      readonly forbidden?: readonly string[] | undefined;
      readonly minProperties?: number | undefined;
      readonly maxProperties?: number | undefined;
    }
  | {
      readonly kind: 'array';
      readonly items: Schema;
      readonly minItems?: number | undefined;
      readonly maxItems?: number | undefined;
      readonly uniqueItems?: true | undefined;
    }
  | {
      readonly kind: 'string';
      readonly minLength?: number | undefined;
      readonly maxLength?: number | undefined;
      readonly pattern?: string | undefined;
      readonly format?: SchemaFormat | undefined;
      readonly literals?: readonly Scalar[] | undefined;
    }
  | {
      readonly kind: 'number' | 'integer';
      readonly minimum?: number | undefined;
      readonly maximum?: number | undefined;
      readonly exclusiveMinimum?: number | undefined;
      readonly exclusiveMaximum?: number | undefined;
      readonly multipleOf?: number | undefined;
      readonly float?: true | undefined;
      readonly literals?: readonly Scalar[] | undefined;
    }
  | {
      readonly kind: 'boolean' | 'null';
      readonly literals?: readonly Scalar[] | undefined;
    }
);

// Sparse declarations enter schemaNode() once. Every fixed field in the normalized
// graph is an own slot, including absence, and remains so through projection.
export type Schema = {
  readonly readOnly: boolean;
  readonly writeOnly: boolean;
} & (
  | { readonly kind: 'json' | 'binary' }
  | {
      readonly kind: 'intersection';
      readonly branches: readonly Schema[];
      readonly location: string;
      readonly literals: readonly Scalar[] | undefined;
    }
  | {
      readonly kind: 'ref';
      readonly name: string;
      readonly location: string;
      readonly constraints: Constraints;
    }
  | ({
      readonly kind: 'map';
      readonly additionalPropertiesExplicit: boolean;
      readonly values: Schema | true;
    } & Pick<Constraints, 'minProperties' | 'maxProperties'>)
  | {
      readonly kind: 'union';
      readonly branches: readonly Schema[];
      readonly cardinality: 'any' | 'one';
      readonly sourceTypeArray: true | undefined;
      readonly discriminator:
        | {
            readonly propertyName: string;
            // Tag to branch position, so composed branches keep their tags.
            readonly mapping: ReadonlyMap<string, number>;
          }
        | undefined;
    }
  | ({
      readonly kind: 'object';
      readonly closed: boolean;
      readonly typeExplicit: boolean;
      readonly additionalPropertiesExplicit: boolean;
      readonly properties: ReadonlyMap<string, Schema>;
      readonly required: readonly string[];
      readonly forbidden: readonly string[] | undefined;
    } & Pick<Constraints, 'minProperties' | 'maxProperties'>)
  | ({ readonly kind: 'array'; readonly items: Schema } & Pick<
      Constraints,
      'minItems' | 'maxItems' | 'uniqueItems'
    >)
  | ({
      readonly kind: 'string';
      readonly format: SchemaFormat | undefined;
      readonly literals: readonly Scalar[] | undefined;
    } & Pick<Constraints, 'minLength' | 'maxLength' | 'pattern'>)
  | ({
      readonly kind: 'number' | 'integer';
      readonly literals: readonly Scalar[] | undefined;
    } & Pick<
      Constraints,
      | 'minimum'
      | 'maximum'
      | 'exclusiveMinimum'
      | 'exclusiveMaximum'
      | 'multipleOf'
      | 'float'
    >)
  | {
      readonly kind: 'boolean' | 'null';
      readonly literals: readonly Scalar[] | undefined;
    }
);

export type SchemaTable = ReadonlyMap<string, Schema>;
export type DirectionalSchemas = Readonly<Record<Direction, SchemaTable>>;

export type AuthTransport = Security['transport'];
export type Policy = ReadonlyMap<string, Scalar>;
export type PolicyVocabulary = {
  readonly version: 3;
  readonly auth: ReadonlyMap<string, AuthTransport>;
  readonly fields: ReadonlyMap<string, Schema>;
  readonly required: readonly string[];
  readonly surfaces: readonly string[];
};

export type Parameter = {
  readonly name: string;
  readonly in: 'path' | 'query' | 'header';
  readonly required: boolean;
  readonly schema: Schema;
  readonly explode: boolean;
};

export type ResponseHeader = {
  readonly name: string;
  readonly required: boolean;
  readonly schema: Schema;
};
export type ContractResponse = {
  readonly status: number;
  readonly body:
    | { readonly kind: 'none' }
    | {
        readonly kind: 'content';
        readonly content: ReadonlyMap<
          string,
          { readonly kind: 'json' | 'text'; readonly schema: Schema }
        >;
      };
  readonly headers: readonly ResponseHeader[];
};

export type Operation = {
  readonly id: string;
  readonly method:
    | 'GET'
    | 'POST'
    | 'PUT'
    | 'PATCH'
    | 'DELETE'
    | 'HEAD'
    | 'OPTIONS';
  readonly path: string;
  readonly security: Security;
  readonly policy: Policy;
  readonly surfaces: readonly string[];
  readonly parameters: readonly Parameter[];
  readonly body:
    | { readonly kind: 'none' }
    | {
        readonly kind: 'json' | 'text';
        readonly contentType: string;
        readonly schema: Schema;
        readonly required: boolean;
      }
    | {
        readonly kind: 'multipart';
        readonly schema: Schema;
        readonly fields: readonly MultipartField[];
      };
  readonly responses: readonly ContractResponse[];
};

export type MultipartField = {
  readonly name: string;
  readonly kind: 'text' | 'file';
  readonly multiple: boolean;
  readonly required: boolean;
};

export type Descriptor = {
  readonly policy: PolicyVocabulary;
  readonly schemas: DirectionalSchemas;
  readonly schemaOrder: readonly string[];
  readonly operations: readonly Operation[];
};

export type Client = {
  readonly name: string;
  readonly execution: boolean;
  readonly target: 'browser' | 'native' | undefined;
  readonly transportHeaders: readonly string[];
  readonly operations: readonly Operation[];
  readonly queries: readonly Operation[];
  readonly infiniteQueries: readonly InfiniteQuery[];
  readonly requestSchemas: readonly string[];
  readonly responseSchemas: readonly string[];
};

type CursorQueryBinding = Readonly<{
  cursor: string;
  nextCursor: string;
  items: string;
}>;

type OffsetQueryBinding = Readonly<{
  offset: string;
  responseOffset: string;
  responseLimit: string;
  total: string;
  items: string;
}>;

export type InfiniteQueryBindingInput = CursorQueryBinding | OffsetQueryBinding;

// Public bindings are sparse inputs. Internal dispatch uses an owned tag rather
// than the presence of a field that could be inherited from Object.prototype.
export type InfiniteQueryBinding =
  | (CursorQueryBinding & { readonly kind: 'cursor' })
  | (OffsetQueryBinding & { readonly kind: 'offset' });

type InfiniteQuery = Readonly<{
  operation: Operation;
  binding: InfiniteQueryBinding;
}>;

export type Standalone = {
  readonly name: string;
  readonly schema: Schema;
  readonly direction: Direction;
  readonly schemaOrder: readonly string[];
};
