import type {
  ActivepiecesAuthDeclaration,
  ActivepiecesPiece,
  ActivepiecesProperty,
  SpikePiece,
} from "./types.js";

export interface IntrospectedProperty {
  readonly name: string;
  readonly displayName: string;
  readonly type: string;
  readonly required: boolean;
  readonly dynamic: boolean;
  readonly refreshers: readonly string[];
}

export interface IntrospectedOperation {
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly props: readonly IntrospectedProperty[];
  readonly strategy?: string;
}

export interface IntrospectedAuth {
  readonly type: string;
  readonly displayName: string;
  readonly required: boolean;
  readonly scopes: readonly string[];
  readonly fields: readonly string[];
}

export interface PieceIntrospection {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly slug: string;
  readonly displayName: string;
  readonly auth: readonly IntrospectedAuth[];
  readonly actions: readonly IntrospectedOperation[];
  readonly triggers: readonly IntrospectedOperation[];
}

export interface BridgeIntrospectionReport {
  readonly generatedBy: "@eyeball/bridge";
  readonly pieces: readonly PieceIntrospection[];
  readonly totals: {
    readonly pieces: number;
    readonly actions: number;
    readonly triggers: number;
    readonly props: number;
    readonly dynamicProps: number;
  };
}

function introspectProps(
  props: Readonly<Record<string, ActivepiecesProperty>>,
): readonly IntrospectedProperty[] {
  return Object.entries(props).map(([name, property]) => ({
    name,
    displayName: property.displayName,
    type: property.type,
    required: property.required,
    dynamic: property.type === "DYNAMIC",
    refreshers: [...(property.refreshers ?? [])],
  }));
}

function authDeclarations(
  piece: ActivepiecesPiece,
): readonly ActivepiecesAuthDeclaration[] {
  if (piece.auth === undefined) {
    return [];
  }
  return Array.isArray(piece.auth)
    ? piece.auth
    : [piece.auth as ActivepiecesAuthDeclaration];
}

function authFields(auth: ActivepiecesAuthDeclaration): readonly string[] {
  if (auth.type === "BASIC_AUTH") {
    return ["username", "password"];
  }
  if (typeof auth.props === "object" && auth.props !== null) {
    return Object.keys(auth.props);
  }
  if (auth.type === "SECRET_TEXT") {
    return ["secret_text"];
  }
  return [];
}

export function introspectPiece(entry: SpikePiece): PieceIntrospection {
  const actions = Object.values(entry.piece.actions()).map((action) => ({
    name: action.name,
    displayName: action.displayName,
    description: action.description,
    props: introspectProps(action.props),
  }));
  const triggers = Object.values(entry.piece.triggers()).map((trigger) => ({
    name: trigger.name,
    displayName: trigger.displayName,
    description: trigger.description,
    props: introspectProps(trigger.props),
    ...(trigger.type === undefined ? {} : { strategy: trigger.type }),
  }));

  return {
    packageName: entry.packageName,
    packageVersion: entry.packageVersion,
    slug: entry.slug,
    displayName: entry.piece.displayName,
    auth: authDeclarations(entry.piece).map((auth) => ({
      type: auth.type,
      displayName: auth.displayName,
      required: auth.required,
      scopes: [...(auth.scope ?? [])],
      fields: authFields(auth),
    })),
    actions,
    triggers,
  };
}

export function generateIntrospectionReport(
  entries: readonly SpikePiece[],
): BridgeIntrospectionReport {
  const pieces = entries.map(introspectPiece);
  const operations = pieces.flatMap((piece) => [
    ...piece.actions,
    ...piece.triggers,
  ]);
  const props = operations.flatMap((operation) => operation.props);

  return {
    generatedBy: "@eyeball/bridge",
    pieces,
    totals: {
      pieces: pieces.length,
      actions: pieces.reduce((total, piece) => total + piece.actions.length, 0),
      triggers: pieces.reduce(
        (total, piece) => total + piece.triggers.length,
        0,
      ),
      props: props.length,
      dynamicProps: props.filter((property) => property.dynamic).length,
    },
  };
}
