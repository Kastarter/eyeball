import {
  type AdapterContext,
  EyeballError,
  type JsonValue,
  TOOL_ERROR_CODES,
  type ToolkitAdapter,
} from "@eyeball/core";
import { createProviderHttpClient } from "../http-client.js";
import {
  asJson,
  booleanValue,
  finiteNumber,
  inputString,
  isRecord,
  numberValue,
  page,
  parseOffsetToken,
  providerError,
  queryPath,
  records,
  requiredId,
  requiredString,
  stringArray,
  stringValue,
  unsupported,
} from "../productivity/common.js";

export const SCRAPECREATORS_PLATFORM_BY_TOOLKIT = Object.freeze({
  "instagram-data": "instagram",
  "tiktok-data": "tiktok",
  "youtube-data": "youtube",
  "x-data": "x",
  "linkedin-data": "linkedin",
  "reddit-data": "reddit",
  "twitch-data": "twitch",
  "snapchat-data": "snapchat",
} as const);

export type ScrapeCreatorsToolkit =
  keyof typeof SCRAPECREATORS_PLATFORM_BY_TOOLKIT;

function credentialApiKey(context: AdapterContext): string {
  if (context.credential.type !== "api_key") {
    throw new EyeballError({
      code: TOOL_ERROR_CODES.AUTH_MISSING,
      message: "A ScrapeCreators API key is required.",
    });
  }
  const preferred = ["apiKey", "api_key", "token", "key"];
  for (const field of preferred) {
    const value = context.credential.values[field];
    if (value !== undefined && value.length > 0) return value;
  }
  const fallback = Object.entries(context.credential.values).sort(
    ([left], [right]) => left.localeCompare(right),
  )[0]?.[1];
  if (fallback === undefined || fallback.length === 0) {
    throw new EyeballError({
      code: TOOL_ERROR_CODES.AUTH_MISSING,
      message: "A ScrapeCreators API key is required.",
    });
  }
  return fallback;
}

async function socialJson(
  context: AdapterContext,
  path: string,
): Promise<Readonly<Record<string, unknown>>> {
  const response = await createProviderHttpClient(context, {
    authorization: null,
  })(path, { headers: { "x-api-key": credentialApiKey(context) } });
  const value: unknown = await response.json();
  if (!isRecord(value)) {
    throw providerError(
      context,
      "ScrapeCreators returned an invalid JSON object.",
    );
  }
  return value;
}

function profile(
  context: AdapterContext,
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    profileId: requiredId(context, value.id, "profile"),
    platform: requiredString(context, value, "platform"),
    handle: requiredString(context, value, "handle"),
    displayName: requiredString(context, value, "displayName"),
    ...(stringValue(value, "bio") === undefined
      ? {}
      : { bio: stringValue(value, "bio") }),
    verified: booleanValue(value, "verified") ?? false,
    followers: finiteNumber(context, value.followers, "followers", 0),
    following: finiteNumber(context, value.following, "following", 0),
    totalPosts: finiteNumber(context, value.totalPosts, "totalPosts", 0),
    ...(stringValue(value, "profileUrl") === undefined
      ? {}
      : { profileUrl: stringValue(value, "profileUrl") }),
    ...(stringValue(value, "avatarUrl") === undefined
      ? {}
      : { avatarUrl: stringValue(value, "avatarUrl") }),
    ...(stringValue(value, "channelId") === undefined
      ? {}
      : { channelId: stringValue(value, "channelId") }),
  };
}

function engagement(
  context: AdapterContext,
  value: unknown,
): Readonly<Record<string, number>> {
  const counters = isRecord(value) ? value : {};
  return {
    likes: finiteNumber(context, counters.likes, "likes", 0),
    comments: finiteNumber(context, counters.comments, "comments", 0),
    shares: finiteNumber(context, counters.shares, "shares", 0),
    views: finiteNumber(context, counters.views, "views", 0),
  };
}

function post(
  context: AdapterContext,
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    postId: requiredId(context, value.id, "post"),
    platform: requiredString(context, value, "platform"),
    authorHandle: requiredString(context, value, "authorHandle"),
    url: requiredString(context, value, "url"),
    text: requiredString(context, value, "text"),
    mediaType: requiredString(context, value, "mediaType"),
    createdAt: requiredString(context, value, "createdAt"),
    ...(numberValue(value, "durationSeconds") === undefined
      ? {}
      : { durationSeconds: numberValue(value, "durationSeconds") }),
    engagement: engagement(context, value.engagement),
    hashtags: stringArray(value.hashtags),
  };
}

function comment(
  context: AdapterContext,
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    commentId: requiredId(context, value.id, "comment"),
    platform: requiredString(context, value, "platform"),
    postId: requiredId(context, value.postId, "post"),
    authorHandle: requiredString(context, value, "authorHandle"),
    text: requiredString(context, value, "text"),
    likes: finiteNumber(context, value.likes, "likes", 0),
    createdAt: requiredString(context, value, "createdAt"),
  };
}

function transcript(
  context: AdapterContext,
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    transcriptId: requiredId(context, value.id, "transcript"),
    platform: requiredString(context, value, "platform"),
    postId: requiredId(context, value.postId, "post"),
    url: requiredString(context, value, "url"),
    language: requiredString(context, value, "language"),
    text: requiredString(context, value, "text"),
    segments: records(value.segments).map((segment) => ({
      startSeconds: finiteNumber(context, segment.start, "segment start"),
      endSeconds: finiteNumber(context, segment.end, "segment end"),
      text: requiredString(context, segment, "text"),
    })),
  };
}

function contentQuery(context: AdapterContext): string {
  const input = context.canonicalInput;
  return queryPath("", {
    id: stringValue(input, "postId"),
    url: stringValue(input, "url"),
  }).replace(/^\?/u, "");
}

export class ScrapeCreatorsAdapter implements ToolkitAdapter {
  readonly toolkitSlug: ScrapeCreatorsToolkit;
  readonly #platform: string;

  constructor(toolkitSlug: ScrapeCreatorsToolkit) {
    this.toolkitSlug = toolkitSlug;
    this.#platform = SCRAPECREATORS_PLATFORM_BY_TOOLKIT[toolkitSlug];
  }

  async execute(context: AdapterContext): Promise<JsonValue> {
    const operation = context.tool.name.slice(
      context.tool.name.indexOf(".") + 1,
    );
    switch (operation) {
      case "get_profile":
        return this.getProfile(context);
      case "get_posts":
        return this.getPosts(context);
      case "get_post":
        return this.getPost(context);
      case "get_comments":
        return this.getComments(context);
      case "search_posts":
        return this.searchPosts(context);
      case "search_creators":
        return this.searchCreators(context);
      case "get_transcript":
        return this.getTranscript(context);
      case "get_channel":
        return this.getChannel(context);
      case "get_channel_videos":
        return this.getChannelVideos(context);
      case "get_live_content":
        return this.getLiveContent(context);
      case "get_audience_metrics":
        return this.getAudienceMetrics(context);
      case "get_trending_content":
        return this.getTrendingContent(context);
      default:
        return unsupported(context);
    }
  }

  private path(surface: string): string {
    return `v1/${this.#platform}/${surface}`;
  }

  private async getProfile(context: AdapterContext): Promise<JsonValue> {
    const body = await socialJson(
      context,
      queryPath(this.path("profile"), {
        handle: inputString(context, "handle"),
      }),
    );
    return asJson({
      profile: profile(context, isRecord(body.profile) ? body.profile : {}),
    });
  }

  private async getPosts(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const body = await socialJson(
      context,
      queryPath(this.path("posts"), {
        handle: inputString(context, "handle"),
        limit: Math.min(numberValue(input, "pageSize") ?? 50, 5),
        cursor: stringValue(input, "pageToken"),
      }),
    );
    return asJson({
      posts: records(body.posts).map((value) => post(context, value)),
      ...(stringValue(body, "cursor") === undefined
        ? {}
        : { nextPageToken: stringValue(body, "cursor") }),
    });
  }

  private async getPost(context: AdapterContext): Promise<JsonValue> {
    const body = await socialJson(
      context,
      `${this.path("post")}?${contentQuery(context)}`,
    );
    return asJson({
      post: post(context, isRecord(body.post) ? body.post : {}),
    });
  }

  private async getComments(context: AdapterContext): Promise<JsonValue> {
    const body = await socialJson(
      context,
      `${this.path("post/comments")}?${contentQuery(context)}`,
    );
    return asJson({
      comments: records(body.comments).map((value) => comment(context, value)),
      ...(stringValue(body, "cursor") === undefined
        ? {}
        : { nextPageToken: stringValue(body, "cursor") }),
    });
  }

  private async searchPosts(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const body = await socialJson(
      context,
      queryPath(this.path("search/posts"), {
        query: inputString(context, "query"),
      }),
    );
    const selected = page(
      records(body.posts),
      parseOffsetToken(context, stringValue(input, "pageToken")),
      numberValue(input, "pageSize") ?? 50,
    );
    return asJson({
      posts: selected.values.map((value) => post(context, value)),
      ...(selected.nextPageToken === undefined
        ? {}
        : { nextPageToken: selected.nextPageToken }),
    });
  }

  private async searchCreators(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const body = await socialJson(
      context,
      queryPath(this.path("search/creators"), {
        query: inputString(context, "query"),
      }),
    );
    const selected = page(
      records(body.creators),
      parseOffsetToken(context, stringValue(input, "pageToken")),
      numberValue(input, "pageSize") ?? 50,
    );
    return asJson({
      profiles: selected.values.map((value) => profile(context, value)),
      ...(selected.nextPageToken === undefined
        ? {}
        : { nextPageToken: selected.nextPageToken }),
    });
  }

  private async getTranscript(context: AdapterContext): Promise<JsonValue> {
    const body = await socialJson(
      context,
      queryPath(this.path("transcript"), {
        url: inputString(context, "url"),
      }),
    );
    return asJson({
      transcript: transcript(
        context,
        isRecord(body.transcript) ? body.transcript : {},
      ),
    });
  }

  private async getChannel(context: AdapterContext): Promise<JsonValue> {
    const body = await socialJson(
      context,
      queryPath(this.path("channel"), {
        handle: inputString(context, "handle"),
      }),
    );
    return asJson({
      channel: profile(context, isRecord(body.channel) ? body.channel : {}),
    });
  }

  private async getChannelVideos(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const body = await socialJson(
      context,
      queryPath(this.path("channel/videos"), {
        handle: inputString(context, "handle"),
        limit: Math.min(numberValue(input, "pageSize") ?? 50, 5),
        cursor: stringValue(input, "pageToken"),
      }),
    );
    return asJson({
      posts: records(body.videos).map((value) => post(context, value)),
      ...(stringValue(body, "cursor") === undefined
        ? {}
        : { nextPageToken: stringValue(body, "cursor") }),
    });
  }

  private async getLiveContent(context: AdapterContext): Promise<JsonValue> {
    const body = await socialJson(
      context,
      queryPath(this.path("live"), {
        handle: inputString(context, "handle"),
      }),
    );
    const live = isRecord(body.live) ? body.live : {};
    return asJson({
      live: {
        platform: requiredString(context, body, "platform"),
        handle: requiredString(context, live, "handle"),
        isLive: booleanValue(live, "isLive") ?? false,
        title: requiredString(context, live, "title"),
        ...(stringValue(live, "scheduledStart") === undefined
          ? {}
          : { scheduledStart: stringValue(live, "scheduledStart") }),
        viewerCount: finiteNumber(context, live.viewerCount, "viewerCount", 0),
      },
    });
  }

  private async getAudienceMetrics(
    context: AdapterContext,
  ): Promise<JsonValue> {
    const body = await socialJson(
      context,
      queryPath(this.path("metrics"), {
        handle: inputString(context, "handle"),
      }),
    );
    const metrics = isRecord(body.metrics) ? body.metrics : {};
    return asJson({
      metrics: {
        platform: requiredString(context, body, "platform"),
        handle: requiredString(context, metrics, "handle"),
        followers: finiteNumber(context, metrics.followers, "followers", 0),
        averageViews: finiteNumber(
          context,
          metrics.averageViews,
          "averageViews",
          0,
        ),
        engagementRate: finiteNumber(
          context,
          metrics.engagementRate,
          "engagementRate",
          0,
        ),
        audienceCountries: records(metrics.audienceCountries).map(
          (country) => ({
            country: requiredString(context, country, "country"),
            percentage: finiteNumber(
              context,
              country.percentage,
              "percentage",
              0,
            ),
          }),
        ),
      },
    });
  }

  private async getTrendingContent(
    context: AdapterContext,
  ): Promise<JsonValue> {
    const body = await socialJson(context, this.path("trending"));
    const pageSize = numberValue(context.canonicalInput, "pageSize") ?? 50;
    return asJson({
      posts: records(body.posts)
        .slice(0, pageSize)
        .map((value) => post(context, value)),
    });
  }
}

export const socialDataToolkitAdapters = Object.freeze(
  (
    Object.keys(SCRAPECREATORS_PLATFORM_BY_TOOLKIT) as ScrapeCreatorsToolkit[]
  ).map((toolkit) => new ScrapeCreatorsAdapter(toolkit)),
);
