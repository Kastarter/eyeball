import { beforeAll, describe, expect, it } from "vitest";
import {
  hasMocksCheckout,
  loadMocksModule,
  mocksSuiteTitle,
} from "../mocks-checkout.js";

type SocialMocksModule =
  typeof import("../../../../mocks/packages/mocks-social/dist/index.js");
type SocialHelpersModule = typeof import("./helpers.js");

let createScrapeCreatorsMock: SocialMocksModule["createScrapeCreatorsMock"];
let scrapeCreatorsFixtures: SocialMocksModule["scrapeCreatorsFixtures"];
let createSocialMockHarness: SocialHelpersModule["createSocialMockHarness"];
let executionOutput: SocialHelpersModule["executionOutput"];
const mocksAvailable = hasMocksCheckout();

const API_KEY_CREDENTIAL = {
  type: "api_key",
  values: { apiKey: "fixture:valid" },
} as const;

function posts(output: Readonly<Record<string, unknown>>) {
  return output.posts as ReadonlyArray<Readonly<Record<string, unknown>>>;
}

describe.skipIf(!mocksAvailable)(
  mocksSuiteTitle("ScrapeCreators social-data adapters", mocksAvailable),
  () => {
    beforeAll(async () => {
      const [mocks, helpers] = await Promise.all([
        loadMocksModule<SocialMocksModule>("mocks-social"),
        import("./helpers.js") as Promise<SocialHelpersModule>,
      ]);
      ({ createScrapeCreatorsMock, scrapeCreatorsFixtures } = mocks);
      ({ createSocialMockHarness, executionOutput } = helpers);
    });

    it("gets an Instagram profile, posts, and a video transcript", async () => {
      const provider = createScrapeCreatorsMock();
      await provider.seed(scrapeCreatorsFixtures.default);
      const harness = createSocialMockHarness(
        provider,
        "instagram-data",
        API_KEY_CREDENTIAL,
      );

      const profile = executionOutput(
        await harness.execute("instagram-data.get_profile", {
          handle: "avery.builds",
        }),
      );
      expect(profile.profile).toMatchObject({
        platform: "instagram",
        handle: "avery.builds",
      });

      const listed = executionOutput(
        await harness.execute("instagram-data.get_posts", {
          handle: "avery.builds",
        }),
      );
      expect(posts(listed)).toHaveLength(3);
      expect(posts(listed)[0]).toMatchObject({
        postId: "sc_instagram_post_000001",
        platform: "instagram",
        mediaType: "video",
      });

      const transcript = executionOutput(
        await harness.execute("instagram-data.get_transcript", {
          url: posts(listed)[0]?.url as string,
        }),
      );
      expect(transcript.transcript).toMatchObject({
        postId: "sc_instagram_post_000001",
        language: "en",
      });
    });

    it("gets a YouTube channel, its videos, and trending content", async () => {
      const provider = createScrapeCreatorsMock();
      await provider.seed(scrapeCreatorsFixtures.default);
      const harness = createSocialMockHarness(
        provider,
        "youtube-data",
        API_KEY_CREDENTIAL,
      );

      const channel = executionOutput(
        await harness.execute("youtube-data.get_channel", {
          handle: "AveryExampleTV",
        }),
      );
      expect(channel.channel).toMatchObject({
        platform: "youtube",
        handle: "AveryExampleTV",
        channelId: "UC_fixture_0001",
      });

      const videos = executionOutput(
        await harness.execute("youtube-data.get_channel_videos", {
          handle: "AveryExampleTV",
        }),
      );
      expect(posts(videos)).toHaveLength(2);
      expect(posts(videos)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ platform: "youtube" }),
        ]),
      );

      const trending = executionOutput(
        await harness.execute("youtube-data.get_trending_content", {
          pageSize: 2,
        }),
      );
      expect(posts(trending)).toHaveLength(2);
      expect(posts(trending)).toEqual([
        expect.objectContaining({ platform: "youtube" }),
        expect.objectContaining({ platform: "youtube" }),
      ]);
    });

    it("gets TikTok audience metrics and live content", async () => {
      const provider = createScrapeCreatorsMock();
      await provider.seed(scrapeCreatorsFixtures.default);
      const harness = createSocialMockHarness(
        provider,
        "tiktok-data",
        API_KEY_CREDENTIAL,
      );

      const metrics = executionOutput(
        await harness.execute("tiktok-data.get_audience_metrics", {
          handle: "averyexplains",
        }),
      );
      expect(metrics.metrics).toMatchObject({
        platform: "tiktok",
        handle: "averyexplains",
        followers: expect.any(Number),
        engagementRate: expect.any(Number),
      });

      const live = executionOutput(
        await harness.execute("tiktok-data.get_live_content", {
          handle: "averyexplains",
        }),
      );
      expect(live.live).toMatchObject({
        platform: "tiktok",
        handle: "averyexplains",
        isLive: expect.any(Boolean),
      });
    });

    it("gets Reddit comments for a public post", async () => {
      const provider = createScrapeCreatorsMock();
      await provider.seed(scrapeCreatorsFixtures.default);
      const harness = createSocialMockHarness(
        provider,
        "reddit-data",
        API_KEY_CREDENTIAL,
      );

      const output = executionOutput(
        await harness.execute("reddit-data.get_comments", {
          postId: "sc_reddit_post_000001",
        }),
      );
      expect(output.comments).toEqual([
        expect.objectContaining({
          postId: "sc_reddit_post_000001",
          authorHandle: "fixture_viewer_one",
        }),
        expect.objectContaining({
          postId: "sc_reddit_post_000001",
          authorHandle: "fixture_viewer_two",
        }),
      ]);
    });

    it("gets the sole supported Snapchat profile surface", async () => {
      const provider = createScrapeCreatorsMock();
      await provider.seed(scrapeCreatorsFixtures.default);
      const harness = createSocialMockHarness(
        provider,
        "snapchat-data",
        API_KEY_CREDENTIAL,
      );

      const output = executionOutput(
        await harness.execute("snapchat-data.get_profile", {
          handle: "avery.snap.fixture",
        }),
      );
      expect(output.profile).toMatchObject({
        platform: "snapchat",
        handle: "avery.snap.fixture",
      });
    });

    it("rejects Snapchat posts as unsupported before contacting the provider", async () => {
      const provider = createScrapeCreatorsMock();
      await provider.seed(scrapeCreatorsFixtures.default);
      const harness = createSocialMockHarness(
        provider,
        "snapchat-data",
        API_KEY_CREDENTIAL,
      );

      const result = await harness.execute("snapchat-data.get_posts", {
        handle: "avery.snap.fixture",
      });
      expect(result.status).toBe(422);
      expect(result.body).toMatchObject({
        error: { code: "not_supported", retryable: false },
        requestId: "req_social_mocks",
      });
      expect(harness.providerRequestCount()).toBe(0);
    });

    it("rejects X search as unsupported before contacting the provider", async () => {
      const provider = createScrapeCreatorsMock();
      await provider.seed(scrapeCreatorsFixtures.default);
      const harness = createSocialMockHarness(
        provider,
        "x-data",
        API_KEY_CREDENTIAL,
      );

      const result = await harness.execute("x-data.search_posts", {
        query: "fixture",
      });
      expect(result.status).toBe(422);
      expect(result.body).toMatchObject({
        error: { code: "not_supported", retryable: false },
        requestId: "req_social_mocks",
      });
      expect(harness.providerRequestCount()).toBe(0);
    });

    it("uses the canonical cursor to paginate social posts", async () => {
      const provider = createScrapeCreatorsMock();
      await provider.seed(scrapeCreatorsFixtures.default);
      const harness = createSocialMockHarness(
        provider,
        "instagram-data",
        API_KEY_CREDENTIAL,
      );

      const first = executionOutput(
        await harness.execute("instagram-data.get_posts", {
          handle: "avery.builds",
          pageSize: 1,
        }),
      );
      expect(posts(first)).toHaveLength(1);
      expect(first.nextPageToken).toEqual(expect.any(String));

      const second = executionOutput(
        await harness.execute("instagram-data.get_posts", {
          handle: "avery.builds",
          pageSize: 1,
          pageToken: first.nextPageToken as string,
        }),
      );
      expect(posts(second)).toHaveLength(1);
      expect(posts(second)[0]?.postId).not.toBe(posts(first)[0]?.postId);
    });

    it("maps the ScrapeCreators expired API key response to auth_expired", async () => {
      const provider = createScrapeCreatorsMock();
      await provider.seed(scrapeCreatorsFixtures.default);
      const harness = createSocialMockHarness(provider, "instagram-data", {
        type: "api_key",
        values: { apiKey: "fixture:EXPIRED_TOKEN" },
      });

      const result = await harness.execute("instagram-data.get_profile", {
        handle: "avery.builds",
      });
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        tool: "instagram-data.get_profile",
        status: "failed",
        error: { code: "auth_expired", retryable: false },
      });
    });
  },
);
