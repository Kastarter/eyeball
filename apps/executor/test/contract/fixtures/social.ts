import { defineCapabilityFixtures } from "../fixtures.js";

interface SocialSeed {
  readonly handle: string;
  readonly postId: string;
  readonly url: string;
}

const SOCIAL_SEEDS: Readonly<Record<string, SocialSeed>> = {
  "instagram-data": {
    handle: "avery.builds",
    postId: "sc_instagram_post_000001",
    url: "https://instagram.acme.example/avery.builds/posts/sc_instagram_post_000001",
  },
  "linkedin-data": {
    handle: "avery-example",
    postId: "sc_linkedin_post_000001",
    url: "https://linkedin.acme.example/avery-example/posts/sc_linkedin_post_000001",
  },
  "reddit-data": {
    handle: "r_fixturebuilders",
    postId: "sc_reddit_post_000001",
    url: "https://reddit.acme.example/r_fixturebuilders/posts/sc_reddit_post_000001",
  },
  "snapchat-data": {
    handle: "avery.snap.fixture",
    postId: "sc_snapchat_post_000001",
    url: "https://snapchat.acme.example/avery.snap.fixture/posts/sc_snapchat_post_000001",
  },
  "tiktok-data": {
    handle: "averyexplains",
    postId: "sc_tiktok_post_000001",
    url: "https://tiktok.acme.example/averyexplains/posts/sc_tiktok_post_000001",
  },
  "twitch-data": {
    handle: "avery_fixture_live",
    postId: "sc_twitch_post_000001",
    url: "https://twitch.acme.example/avery_fixture_live/posts/sc_twitch_post_000001",
  },
  "x-data": {
    handle: "avery_example",
    postId: "sc_x_post_000001",
    url: "https://x.acme.example/avery_example/posts/sc_x_post_000001",
  },
  "youtube-data": {
    handle: "AveryExampleTV",
    postId: "sc_youtube_post_000001",
    url: "https://youtube.acme.example/AveryExampleTV/posts/sc_youtube_post_000001",
  },
};

function seed(provider: string): SocialSeed {
  const value = SOCIAL_SEEDS[provider];
  if (value === undefined) {
    throw new Error(`Missing social seed for ${provider}.`);
  }
  return value;
}

export const socialFixtures = defineCapabilityFixtures("social_media_data", {
  get_audience_metrics: {
    input: (context) => ({
      handle: context.value("HANDLE", seed(context.provider).handle),
    }),
  },
  get_channel_videos: {
    input: (context) => ({
      handle: context.value("HANDLE", seed(context.provider).handle),
      pageSize: 10,
    }),
  },
  get_channel: {
    input: (context) => ({
      handle: context.value("HANDLE", seed(context.provider).handle),
    }),
  },
  get_comments: {
    input: (context) => ({
      postId: context.value("POST_ID", seed(context.provider).postId),
    }),
  },
  get_live_content: {
    input: (context) => ({
      handle: context.value("HANDLE", seed(context.provider).handle),
    }),
  },
  get_post: {
    input: (context) => ({
      postId: context.value("POST_ID", seed(context.provider).postId),
    }),
  },
  get_posts: {
    input: (context) => ({
      handle: context.value("HANDLE", seed(context.provider).handle),
      pageSize: 10,
    }),
  },
  get_profile: {
    input: (context) => ({
      handle: context.value("HANDLE", seed(context.provider).handle),
    }),
  },
  get_transcript: {
    input: (context) => ({
      url: context.value("POST_URL", seed(context.provider).url),
    }),
  },
  get_trending_content: { input: { pageSize: 10 } },
  search_creators: { input: { query: "Avery", pageSize: 10 } },
  search_posts: { input: { query: "fixture", pageSize: 10 } },
});
