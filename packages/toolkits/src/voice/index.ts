export * from "./deepgram.js";
export * from "./elevenlabs.js";
export * from "./livekit.js";
export * from "./pipecat.js";
export * from "./session-driver.js";
export * from "./twilio.js";
export * from "./voice-agents.js";

import { deepgramAdapter } from "./deepgram.js";
import { elevenLabsAdapter } from "./elevenlabs.js";
import { liveKitAdapter } from "./livekit.js";
import { pipecatAdapter } from "./pipecat.js";
import { twilioAdapter } from "./twilio.js";
import { voiceAgentsAdapter } from "./voice-agents.js";

export const voiceToolkitAdapters = Object.freeze([
  twilioAdapter,
  liveKitAdapter,
  elevenLabsAdapter,
  deepgramAdapter,
  pipecatAdapter,
  voiceAgentsAdapter,
]);
