import type { StringFormat } from './runtime.js';

export type Scalar = string | number | boolean | null;
export type Direction = 'request' | 'response';
export type RegisteredStringFormat = Readonly<{
  name: string;
  pattern: string;
}>;
export type SchemaFormat = StringFormat | RegisteredStringFormat;
export type Constraints = {
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly exclusiveMaximum?: number;
  readonly multipleOf?: number;
  readonly float?: true;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly minProperties?: number;
  readonly maxProperties?: number;
};

export type Schema = {
  readonly readOnly?: true;
  readonly writeOnly?: true;
} & (
  | { readonly kind: 'json' }
  | { readonly kind: 'binary' }
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
      readonly values: Schema | true;
      readonly minProperties?: number;
      readonly maxProperties?: number;
    }
  | {
      readonly kind: 'union';
      readonly branches: readonly Schema[];
      readonly discriminator?: {
        readonly propertyName: string;
        readonly mapping: Readonly<Record<string, string>>;
      };
    }
  | {
      readonly kind: 'object';
      readonly properties: Readonly<Record<string, Schema>>;
      readonly required: readonly string[];
      readonly forbidden?: readonly string[];
      readonly minProperties?: number;
      readonly maxProperties?: number;
    }
  | {
      readonly kind: 'array';
      readonly items: Schema;
      readonly minItems?: number;
      readonly maxItems?: number;
    }
  | {
      readonly kind: 'string';
      readonly minLength?: number;
      readonly maxLength?: number;
      readonly pattern?: string;
      readonly format?: SchemaFormat;
      readonly literals?: readonly Scalar[];
    }
  | {
      readonly kind: 'number' | 'integer';
      readonly minimum?: number;
      readonly maximum?: number;
      readonly exclusiveMinimum?: number;
      readonly exclusiveMaximum?: number;
      readonly multipleOf?: number;
      readonly float?: true;
      readonly literals?: readonly Scalar[];
    }
  | {
      readonly kind: 'boolean' | 'null';
      readonly literals?: readonly Scalar[];
    }
);

export type SchemaTable = Readonly<Record<string, Schema>>;
export type DirectionalSchemas = Readonly<Record<Direction, SchemaTable>>;

export type AuthTransport = 'none' | 'bearer';
export type Policy = Readonly<Record<string, Scalar>>;
export type PolicyVocabulary = {
  readonly version: 3;
  readonly auth: Readonly<Record<string, AuthTransport>>;
  readonly fields: Readonly<Record<string, Schema>>;
  readonly required: readonly string[];
  readonly surfaces: readonly string[];
};

export type Parameter = {
  readonly name: string;
  readonly in: 'path' | 'query' | 'header';
  readonly required: boolean;
  readonly schema: Schema;
  readonly explode?: false;
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
        readonly content: Readonly<
          Record<
            string,
            { readonly kind: 'json' | 'text'; readonly schema: Schema }
          >
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
  readonly security: Readonly<{ transport: AuthTransport }>;
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
  readonly target?: 'browser' | 'native';
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

export type InfiniteQueryBinding = CursorQueryBinding | OffsetQueryBinding;

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
