export type Scalar = string | number | boolean | null;
export type Direction = 'request' | 'response';
export type Constraints = {
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly exclusiveMaximum?: number;
  readonly multipleOf?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
};

export type Schema = { readonly hasDefault?: true } & (
  | { readonly kind: 'binary' }
  | {
      readonly kind: 'ref';
      readonly name: string;
      readonly location: string;
      // Siblings restrict the referenced base; they do not replace its kind or
      // constraints. Scalar nodes carry their own type-specific limits inline.
      readonly constraints: Constraints;
    }
  | { readonly kind: 'map'; readonly values: Schema | true }
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
      readonly format?: 'date' | 'date-time' | 'uuid';
      readonly literals?: readonly Scalar[];
    }
  | {
      readonly kind: 'number' | 'integer';
      readonly minimum?: number;
      readonly maximum?: number;
      readonly exclusiveMinimum?: number;
      readonly exclusiveMaximum?: number;
      readonly multipleOf?: number;
      readonly literals?: readonly Scalar[];
    }
  | {
      readonly kind: 'boolean' | 'null';
      readonly literals?: readonly Scalar[];
    }
);

export type AuthTransport = 'none' | 'bearer';
export type Policy = {
  readonly auth: Readonly<{ label: string; transport: AuthTransport }>;
  readonly retry: string;
  readonly timeout: string;
};
export type PolicyVocabulary = {
  readonly version: 2;
  readonly auth: Readonly<Record<string, AuthTransport>>;
  readonly retry: readonly string[];
  readonly timeout: readonly string[];
  readonly surfaces: readonly string[];
};

export type Parameter = {
  readonly name: string;
  readonly in: 'path' | 'query' | 'header';
  readonly required: boolean;
  readonly schema: Schema;
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
    | { readonly kind: 'json'; readonly schema: Schema };
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
  readonly policy: Policy;
  readonly surfaces: readonly string[];
  readonly parameters: readonly Parameter[];
  readonly body:
    | { readonly kind: 'none' }
    | { readonly kind: 'json'; readonly schema: Schema }
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
  readonly schemas: Readonly<Record<string, Schema>>;
  readonly schemaOrder: readonly string[];
  readonly operations: readonly Operation[];
};

export type Client = {
  readonly name: string;
  readonly target?: 'browser' | 'native';
  readonly transportHeaders: readonly string[];
  readonly operations: readonly Operation[];
  readonly queries: readonly Operation[];
  readonly infiniteQueries: readonly InfiniteQuery[];
  readonly requestSchemas: readonly string[];
  readonly responseSchemas: readonly string[];
};

export type InfiniteQueryBinding = Readonly<{
  cursor: string;
  nextCursor: string;
  items: string;
}>;

export type InfiniteQuery = Readonly<{
  operation: Operation;
  binding: InfiniteQueryBinding;
}>;

export type Standalone = {
  readonly name: string;
  readonly schema: Schema;
  readonly direction: Direction;
  readonly schemaOrder: readonly string[];
};
