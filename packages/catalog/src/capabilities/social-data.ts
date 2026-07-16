import type { CapabilityToolContract, JSONSchema202012 } from "@eyeball/core";
import { deepFreeze } from "../immutable.js";
import {
  defineContract,
  nextPageTokenProperty,
  pageSizeProperty,
  pageTokenProperty,
  publishedObjectSchema,
} from "./schema.js";

const CAPABILITY = "social_media_data" as const;
const VERSION = "1.0.0" as const;
const READ_ONLY = {
  readOnly: true,
  destructive: false,
  idempotent: true,
  async: false,
} as const;

const id = (description: string): JSONSchema202012 => ({
  type: "string",
  description,
  minLength: 1,
});

const timestamp = (description: string): JSONSchema202012 => ({
  type: "string",
  format: "date-time",
  description,
});

const platform = (): JSONSchema202012 =>
  id("Social platform represented by the result.");

const profileSchema = (): JSONSchema202012 => ({
  type: "object",
  description:
    "A normalized public creator, user, channel, or community profile.",
  additionalProperties: false,
  required: [
    "profileId",
    "platform",
    "handle",
    "displayName",
    "verified",
    "followers",
    "following",
    "totalPosts",
  ],
  properties: {
    profileId: id("Provider identifier of the public profile."),
    platform: platform(),
    handle: id("Platform handle, username, channel name, or community name."),
    displayName: id("Public display name."),
    bio: { type: "string", description: "Public biography or description." },
    verified: {
      type: "boolean",
      description: "Whether the profile is verified.",
    },
    followers: {
      type: "integer",
      minimum: 0,
      description: "Visible follower or subscriber count.",
    },
    following: {
      type: "integer",
      minimum: 0,
      description: "Visible following count.",
    },
    totalPosts: {
      type: "integer",
      minimum: 0,
      description: "Visible total public post count.",
    },
    profileUrl: {
      type: "string",
      format: "uri",
      description: "Public profile URL.",
    },
    avatarUrl: {
      type: "string",
      format: "uri",
      description: "Public avatar URL.",
    },
    channelId: {
      type: "string",
      description:
        "Platform channel identifier when distinct from the profile ID.",
    },
  },
});

const engagementSchema = (): JSONSchema202012 => ({
  type: "object",
  description: "Public engagement counters for one content item.",
  additionalProperties: false,
  required: ["likes", "comments", "shares", "views"],
  properties: {
    likes: { type: "integer", minimum: 0, description: "Visible like count." },
    comments: {
      type: "integer",
      minimum: 0,
      description: "Visible comment count.",
    },
    shares: {
      type: "integer",
      minimum: 0,
      description: "Visible share count.",
    },
    views: { type: "integer", minimum: 0, description: "Visible view count." },
  },
});

const postSchema = (): JSONSchema202012 => ({
  type: "object",
  description: "A normalized public post, video, short, clip, or media item.",
  additionalProperties: false,
  required: [
    "postId",
    "platform",
    "authorHandle",
    "url",
    "text",
    "mediaType",
    "createdAt",
    "engagement",
    "hashtags",
  ],
  properties: {
    postId: id("Provider identifier of the content item."),
    platform: platform(),
    authorHandle: id("Public handle of the content author."),
    url: { type: "string", format: "uri", description: "Public content URL." },
    text: { type: "string", description: "Visible caption or text content." },
    mediaType: {
      type: "string",
      enum: ["image", "video", "text", "clip"],
      description: "Normalized public content kind.",
    },
    createdAt: timestamp("Content publication timestamp."),
    durationSeconds: {
      type: "number",
      minimum: 0,
      description: "Media duration in seconds when available.",
    },
    engagement: engagementSchema(),
    hashtags: {
      type: "array",
      description: "Hashtags attached to the content.",
      items: { type: "string" },
    },
  },
});

const commentSchema = (): JSONSchema202012 => ({
  type: "object",
  description: "A normalized public content comment.",
  additionalProperties: false,
  required: [
    "commentId",
    "platform",
    "postId",
    "authorHandle",
    "text",
    "likes",
    "createdAt",
  ],
  properties: {
    commentId: id("Provider identifier of the comment."),
    platform: platform(),
    postId: id("Provider identifier of the parent content item."),
    authorHandle: id("Public handle of the comment author."),
    text: id("Visible comment text."),
    likes: { type: "integer", minimum: 0, description: "Visible like count." },
    createdAt: timestamp("Comment publication timestamp."),
  },
});

const transcriptSchema = (): JSONSchema202012 => ({
  type: "object",
  description: "A normalized transcript for public video or audio content.",
  additionalProperties: false,
  required: [
    "transcriptId",
    "platform",
    "postId",
    "url",
    "language",
    "text",
    "segments",
  ],
  properties: {
    transcriptId: id("Provider identifier of the transcript."),
    platform: platform(),
    postId: id("Provider identifier of the transcribed content item."),
    url: { type: "string", format: "uri", description: "Public content URL." },
    language: id("Transcript language code."),
    text: id("Complete transcript text."),
    segments: {
      type: "array",
      description: "Timestamped transcript segments.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["startSeconds", "endSeconds", "text"],
        properties: {
          startSeconds: {
            type: "number",
            minimum: 0,
            description: "Segment start in seconds.",
          },
          endSeconds: {
            type: "number",
            minimum: 0,
            description: "Segment end in seconds.",
          },
          text: id("Segment text."),
        },
      },
    },
  },
});

const contentSelectorProperties = {
  postId: id("Provider identifier of the content item."),
  url: { type: "string", format: "uri", description: "Public content URL." },
} as const;

const contentSelector = (
  tool: "get_post" | "get_comments",
  description: string,
) => ({
  ...publishedObjectSchema({
    capability: CAPABILITY,
    tool,
    direction: "input",
    description,
    properties: contentSelectorProperties,
  }),
  anyOf: [
    {
      required: ["postId"],
      properties: { postId: contentSelectorProperties.postId },
    },
    {
      required: ["url"],
      properties: { url: contentSelectorProperties.url },
    },
  ],
});

const getProfile = defineContract({
  capability: CAPABILITY,
  name: "get_profile",
  description: "Retrieve a public creator or user profile and visible metrics.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_profile",
    direction: "input",
    description: "Public profile selector.",
    required: ["handle"],
    properties: { handle: id("Public profile handle or username.") },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_profile",
    direction: "output",
    description: "Requested public profile.",
    required: ["profile"],
    properties: { profile: profileSchema() },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const getPosts = defineContract({
  capability: CAPABILITY,
  name: "get_posts",
  description: "List public posts or media for a profile or community.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_posts",
    direction: "input",
    description: "Public profile and pagination selectors.",
    required: ["handle"],
    properties: {
      handle: id("Public profile or community handle."),
      pageSize: pageSizeProperty("posts"),
      pageToken: pageTokenProperty("post"),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_posts",
    direction: "output",
    description: "One page of public content.",
    required: ["posts"],
    properties: {
      posts: {
        type: "array",
        description: "Public content items.",
        items: postSchema(),
      },
      nextPageToken: nextPageTokenProperty("posts"),
    },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const getPost = defineContract({
  capability: CAPABILITY,
  name: "get_post",
  description: "Retrieve one public post, video, clip, short, or media item.",
  inputSchema: contentSelector(
    "get_post",
    "Provider content identifier or public URL.",
  ),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_post",
    direction: "output",
    description: "Requested public content item.",
    required: ["post"],
    properties: { post: postSchema() },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const getComments = defineContract({
  capability: CAPABILITY,
  name: "get_comments",
  description: "List public comments and supported replies for a content item.",
  inputSchema: contentSelector(
    "get_comments",
    "Provider content identifier or public URL.",
  ),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_comments",
    direction: "output",
    description: "Public comments for the selected content item.",
    required: ["comments"],
    properties: {
      comments: {
        type: "array",
        description: "Public comments.",
        items: commentSchema(),
      },
      nextPageToken: nextPageTokenProperty("comments"),
    },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const searchPosts = defineContract({
  capability: CAPABILITY,
  name: "search_posts",
  description: "Search public content using a platform-supported query.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "search_posts",
    direction: "input",
    description: "Public content search query.",
    required: ["query"],
    properties: {
      query: id("Platform-supported public content query."),
      pageSize: pageSizeProperty("matching posts"),
      pageToken: pageTokenProperty("matching post"),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "search_posts",
    direction: "output",
    description: "Public content matching the query.",
    required: ["posts"],
    properties: {
      posts: {
        type: "array",
        description: "Matching content items.",
        items: postSchema(),
      },
      nextPageToken: nextPageTokenProperty("matching posts"),
    },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const searchCreators = defineContract({
  capability: CAPABILITY,
  name: "search_creators",
  description:
    "Search or discover public creators where the platform supports it.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "search_creators",
    direction: "input",
    description: "Public creator search query.",
    required: ["query"],
    properties: {
      query: id("Platform-supported creator query."),
      pageSize: pageSizeProperty("matching creators"),
      pageToken: pageTokenProperty("matching creator"),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "search_creators",
    direction: "output",
    description: "Public creators matching the query.",
    required: ["profiles"],
    properties: {
      profiles: {
        type: "array",
        description: "Matching public profiles.",
        items: profileSchema(),
      },
      nextPageToken: nextPageTokenProperty("matching creators"),
    },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const getTranscript = defineContract({
  capability: CAPABILITY,
  name: "get_transcript",
  description:
    "Retrieve or derive the transcript for a supported public video or audio post.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_transcript",
    direction: "input",
    description: "Public content URL to transcribe.",
    required: ["url"],
    properties: {
      url: {
        type: "string",
        format: "uri",
        description: "Public content URL.",
      },
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_transcript",
    direction: "output",
    description: "Transcript for the selected public content.",
    required: ["transcript"],
    properties: { transcript: transcriptSchema() },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const getChannel = defineContract({
  capability: CAPABILITY,
  name: "get_channel",
  description:
    "Retrieve a public channel, company, community, or subreddit entity.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_channel",
    direction: "input",
    description: "Public channel selector.",
    required: ["handle"],
    properties: { handle: id("Public channel or community handle.") },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_channel",
    direction: "output",
    description: "Requested public channel.",
    required: ["channel"],
    properties: { channel: profileSchema() },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const getChannelVideos = defineContract({
  capability: CAPABILITY,
  name: "get_channel_videos",
  description: "List public videos, shorts, streams, or clips from a channel.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_channel_videos",
    direction: "input",
    description: "Public channel and pagination selectors.",
    required: ["handle"],
    properties: {
      handle: id("Public channel handle."),
      pageSize: pageSizeProperty("channel videos"),
      pageToken: pageTokenProperty("channel video"),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_channel_videos",
    direction: "output",
    description: "One page of public channel videos.",
    required: ["posts"],
    properties: {
      posts: {
        type: "array",
        description: "Channel videos.",
        items: postSchema(),
      },
      nextPageToken: nextPageTokenProperty("channel videos"),
    },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const getLiveContent = defineContract({
  capability: CAPABILITY,
  name: "get_live_content",
  description: "Retrieve current or scheduled public live-content metadata.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_live_content",
    direction: "input",
    description: "Public live-profile selector.",
    required: ["handle"],
    properties: { handle: id("Public creator or channel handle.") },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_live_content",
    direction: "output",
    description: "Current or scheduled live-content metadata.",
    required: ["live"],
    properties: {
      live: {
        type: "object",
        additionalProperties: false,
        required: ["platform", "handle", "isLive", "title", "viewerCount"],
        properties: {
          platform: platform(),
          handle: id("Public creator or channel handle."),
          isLive: {
            type: "boolean",
            description: "Whether content is live now.",
          },
          title: id("Live-content title."),
          scheduledStart: timestamp("Scheduled start timestamp."),
          viewerCount: {
            type: "integer",
            minimum: 0,
            description: "Visible concurrent viewer count.",
          },
        },
      },
    },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const getAudienceMetrics = defineContract({
  capability: CAPABILITY,
  name: "get_audience_metrics",
  description:
    "Retrieve public or explicitly supported audience and engagement metrics.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_audience_metrics",
    direction: "input",
    description: "Public profile selector.",
    required: ["handle"],
    properties: { handle: id("Public creator or channel handle.") },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_audience_metrics",
    direction: "output",
    description: "Public audience and engagement metrics.",
    required: ["metrics"],
    properties: {
      metrics: {
        type: "object",
        additionalProperties: false,
        required: [
          "platform",
          "handle",
          "followers",
          "averageViews",
          "engagementRate",
          "audienceCountries",
        ],
        properties: {
          platform: platform(),
          handle: id("Public creator or channel handle."),
          followers: {
            type: "integer",
            minimum: 0,
            description: "Visible follower count.",
          },
          averageViews: {
            type: "number",
            minimum: 0,
            description: "Provider-supported average view count.",
          },
          engagementRate: {
            type: "number",
            minimum: 0,
            description: "Provider-supported engagement ratio.",
          },
          audienceCountries: {
            type: "array",
            description: "Country shares explicitly supported by the provider.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["country", "percentage"],
              properties: {
                country: id("Country code."),
                percentage: {
                  type: "number",
                  minimum: 0,
                  maximum: 100,
                  description: "Audience percentage.",
                },
              },
            },
          },
        },
      },
    },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const getTrendingContent = defineContract({
  capability: CAPABILITY,
  name: "get_trending_content",
  description:
    "Retrieve a documented public trending feed, hashtag, reel, or short surface.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_trending_content",
    direction: "input",
    description: "Optional result limit.",
    properties: { pageSize: pageSizeProperty("trending posts") },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_trending_content",
    direction: "output",
    description: "Documented public trending content.",
    required: ["posts"],
    properties: {
      posts: {
        type: "array",
        description: "Trending content items.",
        items: postSchema(),
      },
    },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

export const socialDataCapabilityContracts = deepFreeze([
  getProfile,
  getPosts,
  getPost,
  getComments,
  searchPosts,
  searchCreators,
  getTranscript,
  getChannel,
  getChannelVideos,
  getLiveContent,
  getAudienceMetrics,
  getTrendingContent,
] as const satisfies readonly CapabilityToolContract[]);

type SocialDataContract = (typeof socialDataCapabilityContracts)[number];
type SocialDataContractsByName = {
  readonly [Contract in SocialDataContract as Contract["name"]]: Contract;
};

export const socialDataContractsByName = deepFreeze(
  Object.fromEntries(
    socialDataCapabilityContracts.map((contract) => [contract.name, contract]),
  ) as SocialDataContractsByName,
);
