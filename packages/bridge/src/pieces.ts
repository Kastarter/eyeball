import { airtable } from "@activepieces/piece-airtable";
import { discord } from "@activepieces/piece-discord";
import { gmail } from "@activepieces/piece-gmail";
import { slack } from "@activepieces/piece-slack";
import { typeform } from "@activepieces/piece-typeform";
import type { ActivepiecesPiece, SpikePiece } from "./types.js";

function asPiece(value: unknown): ActivepiecesPiece {
  return value as ActivepiecesPiece;
}

/** Exact npm inputs selected for the compatibility spike. */
export const spikePieces: readonly SpikePiece[] = [
  {
    packageName: "@activepieces/piece-gmail",
    packageVersion: "0.12.8",
    slug: "gmail",
    piece: asPiece(gmail),
  },
  {
    packageName: "@activepieces/piece-airtable",
    packageVersion: "0.6.10",
    slug: "airtable",
    piece: asPiece(airtable),
  },
  {
    packageName: "@activepieces/piece-slack",
    packageVersion: "0.17.3",
    slug: "slack",
    piece: asPiece(slack),
  },
  {
    packageName: "@activepieces/piece-discord",
    packageVersion: "0.5.4",
    slug: "discord",
    piece: asPiece(discord),
  },
  {
    packageName: "@activepieces/piece-typeform",
    packageVersion: "0.4.6",
    slug: "typeform",
    piece: asPiece(typeform),
  },
] as const;

export function getSpikePiece(slug: string): SpikePiece | undefined {
  return spikePieces.find((candidate) => candidate.slug === slug);
}
