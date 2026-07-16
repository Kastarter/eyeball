import type { ProviderManifest, Toolkit } from "@eyeball/core";
import { deepFreeze } from "../immutable.js";

export const SCRAPECREATORS_PLATFORMS_BY_TOOLKIT = deepFreeze({
  "instagram-data": "instagram",
  "tiktok-data": "tiktok",
  "youtube-data": "youtube",
  "x-data": "x",
  "linkedin-data": "linkedin",
  "reddit-data": "reddit",
  "twitch-data": "twitch",
  "snapchat-data": "snapchat",
} as const);

type SocialToolkit = keyof typeof SCRAPECREATORS_PLATFORMS_BY_TOOLKIT;
type SocialTool =
  | "get_profile"
  | "get_posts"
  | "get_post"
  | "get_comments"
  | "search_posts"
  | "search_creators"
  | "get_transcript"
  | "get_channel"
  | "get_channel_videos"
  | "get_live_content"
  | "get_audience_metrics"
  | "get_trending_content";

function socialManifest(
  toolkit: Toolkit & { slug: SocialToolkit },
  tools: readonly SocialTool[],
): ProviderManifest {
  const platform = SCRAPECREATORS_PLATFORMS_BY_TOOLKIT[toolkit.slug];
  return deepFreeze({
    schemaVersion: "1.0",
    catalogVersion: "1.0",
    toolkit,
    auth: { class: "api_key", fields: ["apiKey"] },
    endpoint: {
      baseUrl: "https://api.scrapecreators.com",
      baseUrlOverrideEnv: "EYEBALL_SCRAPECREATORS_BASE_URL",
    },
    implements: tools.map((canonicalTool) => ({
      capability: "social_media_data",
      canonicalTool,
      canonicalVersion: "1.0.0",
      operationId: `scrapecreators.${platform}.${canonicalTool}`,
    })),
  });
}

export const instagramDataManifest = socialManifest(
  {
    slug: "instagram-data",
    displayName: "Instagram via ScrapeCreators",
    source: "scrapecreators",
    tier: "P0",
  },
  [
    "get_profile",
    "get_posts",
    "get_post",
    "get_comments",
    "search_posts",
    "search_creators",
    "get_transcript",
    "get_trending_content",
  ],
);

export const tikTokDataManifest = socialManifest(
  {
    slug: "tiktok-data",
    displayName: "TikTok via ScrapeCreators",
    source: "scrapecreators",
    tier: "P0",
  },
  [
    "get_profile",
    "get_posts",
    "get_post",
    "get_comments",
    "search_posts",
    "search_creators",
    "get_transcript",
    "get_live_content",
    "get_audience_metrics",
    "get_trending_content",
  ],
);

export const youTubeDataManifest = socialManifest(
  {
    slug: "youtube-data",
    displayName: "YouTube via ScrapeCreators",
    source: "scrapecreators",
    tier: "P0",
  },
  [
    "get_posts",
    "get_post",
    "get_comments",
    "search_posts",
    "search_creators",
    "get_transcript",
    "get_channel",
    "get_channel_videos",
    "get_trending_content",
  ],
);

export const xDataManifest = socialManifest(
  {
    slug: "x-data",
    displayName: "Twitter/X via ScrapeCreators",
    source: "scrapecreators",
    tier: "P0",
  },
  ["get_profile", "get_posts", "get_post", "get_transcript"],
);

export const linkedInDataManifest = socialManifest(
  {
    slug: "linkedin-data",
    displayName: "LinkedIn via ScrapeCreators",
    source: "scrapecreators",
    tier: "P0",
  },
  ["get_profile", "get_posts", "get_post", "search_posts", "get_transcript"],
);

export const redditDataManifest = socialManifest(
  {
    slug: "reddit-data",
    displayName: "Reddit via ScrapeCreators",
    source: "scrapecreators",
    tier: "P0",
  },
  [
    "get_profile",
    "get_posts",
    "get_post",
    "get_comments",
    "search_posts",
    "get_transcript",
  ],
);

export const twitchDataManifest = socialManifest(
  {
    slug: "twitch-data",
    displayName: "Twitch via ScrapeCreators",
    source: "scrapecreators",
    tier: "P0",
  },
  ["get_profile", "get_posts", "get_post", "get_live_content"],
);

export const snapChatDataManifest = socialManifest(
  {
    slug: "snapchat-data",
    displayName: "Snapchat via ScrapeCreators",
    source: "scrapecreators",
    tier: "P0",
  },
  ["get_profile"],
);

export const socialDataManifests = deepFreeze([
  instagramDataManifest,
  tikTokDataManifest,
  youTubeDataManifest,
  xDataManifest,
  linkedInDataManifest,
  redditDataManifest,
  twitchDataManifest,
  snapChatDataManifest,
] as const satisfies readonly ProviderManifest[]);
