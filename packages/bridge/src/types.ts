import type { FetchImplementation, ResolvedCredential } from "@eyeball/core";

export type ActivepiecesPropertyType =
  | "ARRAY"
  | "BASIC_AUTH"
  | "CHECKBOX"
  | "COLOR"
  | "CUSTOM"
  | "CUSTOM_AUTH"
  | "DATE_TIME"
  | "DROPDOWN"
  | "DYNAMIC"
  | "FILE"
  | "JSON"
  | "LONG_TEXT"
  | "MARKDOWN"
  | "MULTI_SELECT_DROPDOWN"
  | "NUMBER"
  | "OBJECT"
  | "OAUTH2"
  | "OIDC"
  | "SECRET_TEXT"
  | "SHORT_TEXT"
  | "STATIC_DROPDOWN"
  | "STATIC_MULTI_SELECT_DROPDOWN";

export interface ActivepiecesStaticOption {
  readonly label: string;
  readonly value: unknown;
}

export interface ActivepiecesStaticOptions {
  readonly disabled?: boolean;
  readonly placeholder?: string;
  readonly options: readonly ActivepiecesStaticOption[];
}

export interface ActivepiecesProperty {
  readonly type: ActivepiecesPropertyType | string;
  readonly displayName: string;
  readonly description?: string;
  readonly required: boolean;
  readonly defaultValue?: unknown;
  readonly refreshers?: readonly string[];
  readonly options?:
    | ActivepiecesStaticOptions
    | ((
        propsValue: Readonly<Record<string, unknown>>,
        context: ActivepiecesPropertyContext,
      ) => Promise<unknown>);
  readonly properties?: Readonly<Record<string, ActivepiecesProperty>>;
  readonly props?:
    | Readonly<Record<string, ActivepiecesProperty>>
    | ((
        propsValue: Readonly<Record<string, unknown>>,
        context: ActivepiecesPropertyContext,
      ) => Promise<Readonly<Record<string, ActivepiecesProperty>>>);
  readonly [key: string]: unknown;
}

export interface ActivepiecesAuthDeclaration extends ActivepiecesProperty {
  readonly scope?: readonly string[];
}

export interface ActivepiecesAction {
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly props: Readonly<Record<string, ActivepiecesProperty>>;
  readonly aiMetadata?: Readonly<Record<string, unknown>>;
  run(context: Readonly<Record<string, unknown>>): Promise<unknown>;
}

export interface ActivepiecesTrigger {
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly type?: string;
  readonly props: Readonly<Record<string, ActivepiecesProperty>>;
}

export interface ActivepiecesPiece {
  readonly displayName: string;
  readonly description: string;
  readonly auth?:
    | ActivepiecesAuthDeclaration
    | readonly ActivepiecesAuthDeclaration[];
  actions(): Readonly<Record<string, ActivepiecesAction>>;
  triggers(): Readonly<Record<string, ActivepiecesTrigger>>;
  getAction(name: string): ActivepiecesAction | undefined;
  getTrigger(name: string): ActivepiecesTrigger | undefined;
}

export interface SpikePiece {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly slug: string;
  readonly piece: ActivepiecesPiece;
}

export interface ActivepiecesPropertyContext {
  readonly server: {
    readonly apiUrl: string;
    readonly publicUrl: string;
    readonly token: string;
  };
  readonly project: {
    readonly id: string;
    externalId(): Promise<string | undefined>;
  };
  readonly searchValue?: string;
  readonly flows: {
    readonly current: {
      readonly id: string;
      readonly version: { readonly id: string };
    };
    list(): Promise<unknown>;
  };
  readonly connections: {
    get(key: string): Promise<unknown>;
  };
}

export interface PieceFetchRoute {
  /** Exact origin used by a piece, for example `https://api.airtable.com`. */
  readonly fromOrigin: string;
  /** Trusted executor base URL, which may include a path such as `/airtable`. */
  readonly toBaseUrl: string;
}

export interface PieceExecutionBoundaryContext {
  readonly fetchImpl: FetchImplementation;
  readonly routes: readonly PieceFetchRoute[];
}

/**
 * An isolation seam for clients that bypass `globalThis.fetch` (Gaxios,
 * `@slack/web-api`, and similar bundled clients).
 */
export interface PieceExecutionBoundary {
  run<T>(
    context: PieceExecutionBoundaryContext,
    operation: () => Promise<T>,
  ): Promise<T>;
}

export interface DynamicPropertyResolutionOptions {
  readonly piece: ActivepiecesPiece;
  readonly actionName: string;
  readonly propertyName: string;
  readonly credential: ResolvedCredential;
  readonly propsValue: Readonly<Record<string, unknown>>;
  readonly fetchImpl: FetchImplementation;
  readonly routes?: readonly PieceFetchRoute[];
  readonly boundary?: PieceExecutionBoundary;
  readonly projectId?: string;
  readonly searchValue?: string;
  readonly apiKeyField?: string;
}
