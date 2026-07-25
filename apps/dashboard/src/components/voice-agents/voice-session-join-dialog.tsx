"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/src/components/ui/button";
import { Icon } from "@/src/components/ui/icon";
import {
  DIALOG_FOCUSABLE_SELECTOR,
  focusFirstDialogControl,
  wrapDialogFocus,
} from "@/src/lib/dialog-focus";

type LiveKitRoom = {
  connect: (url: string, token: string) => Promise<void>;
  disconnect: () => Promise<void>;
  startAudio: () => Promise<void>;
  localParticipant: {
    identity: string;
    setMicrophoneEnabled: (enabled: boolean) => Promise<unknown>;
  };
  remoteParticipants: Map<string, RemoteParticipantLike>;
  on: (event: string, listener: (...args: never[]) => void) => LiveKitRoom;
};

interface RemoteParticipantLike {
  trackPublications: Map<string, { track?: RemoteTrackLike }>;
}

interface RemoteTrackLike {
  kind: string;
  attach: () => HTMLMediaElement;
}

type JoinState =
  | { phase: "idle" }
  | { phase: "connecting" }
  | { phase: "connected"; speaking: "nobody" | "you" | "agent" }
  | { phase: "failed"; message: string };

/**
 * The executor returns the LiveKit endpoint it dials internally; the browser
 * needs the reachable signalling host, which may differ behind a bridge or
 * mock. NEXT_PUBLIC_EYEBALL_LIVEKIT_URL, when set, wins.
 */
function participantServerUrl(roomUrl: string): string {
  const override = process.env.NEXT_PUBLIC_EYEBALL_LIVEKIT_URL;
  const raw = override !== undefined && override !== "" ? override : roomUrl;
  return raw.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
}

export function VoiceSessionJoinDialog({
  grant,
  onClose,
  returnFocusTo,
}: {
  grant: { expiresAt: string; participantToken: string; roomUrl: string };
  onClose: () => void;
  returnFocusTo?: HTMLElement | null;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const audioSinkRef = useRef<HTMLDivElement>(null);
  const roomRef = useRef<LiveKitRoom>(undefined);
  const [joinState, setJoinState] = useState<JoinState>({ phase: "idle" });

  const leaveRoom = useCallback(() => {
    const room = roomRef.current;
    roomRef.current = undefined;
    if (room !== undefined) void room.disconnect().catch(() => undefined);
  }, []);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    focusFirstDialogControl(dialogRef.current);
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        DIALOG_FOCUSABLE_SELECTOR,
      );
      wrapDialogFocus(event, [...(focusable ?? [])], document.activeElement);
    }
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("keydown", handleKey);
      document.body.style.overflow = previousOverflow;
      window.requestAnimationFrame(() => returnFocusTo?.focus());
    };
  }, [onClose, returnFocusTo]);

  useEffect(() => leaveRoom, [leaveRoom]);

  const attachAudio = useCallback((track: RemoteTrackLike) => {
    const element = track.attach();
    element.autoplay = true;
    audioSinkRef.current?.appendChild(element);
    void element.play().catch(() => undefined);
  }, []);

  const join = useCallback(async () => {
    setJoinState({ phase: "connecting" });
    try {
      const livekit = await import("livekit-client");
      const room = new livekit.Room() as unknown as LiveKitRoom;
      roomRef.current = room;
      room.on("trackSubscribed", ((track: RemoteTrackLike) => {
        if (track.kind === "audio") attachAudio(track);
      }) as never);
      room.on("activeSpeakersChanged", ((speakers: { identity: string }[]) => {
        const me = room.localParticipant.identity;
        const agent = speakers.some((speaker) => speaker.identity !== me);
        const you = speakers.some((speaker) => speaker.identity === me);
        setJoinState({
          phase: "connected",
          speaking: agent ? "agent" : you ? "you" : "nobody",
        });
      }) as never);
      room.on("disconnected", (() => {
        if (roomRef.current === room) {
          roomRef.current = undefined;
          setJoinState({ phase: "idle" });
        }
      }) as never);
      await room.connect(
        participantServerUrl(grant.roomUrl),
        grant.participantToken,
      );
      await room.startAudio().catch(() => undefined);
      for (const participant of room.remoteParticipants.values()) {
        for (const publication of participant.trackPublications.values()) {
          const track = publication.track;
          if (track !== undefined && track.kind === "audio") attachAudio(track);
        }
      }
      await room.localParticipant.setMicrophoneEnabled(true);
      setJoinState({ phase: "connected", speaking: "nobody" });
    } catch (error) {
      leaveRoom();
      setJoinState({
        phase: "failed",
        message: error instanceof Error ? error.message : "Connection failed.",
      });
    }
  }, [attachAudio, grant.participantToken, grant.roomUrl, leaveRoom]);

  const connected = joinState.phase === "connected";
  const statusLabel =
    joinState.phase === "idle"
      ? "Not connected. Join to talk with the agent from this browser."
      : joinState.phase === "connecting"
        ? "Connecting to the room…"
        : joinState.phase === "failed"
          ? `Could not join: ${joinState.message} Mock and development transports do not accept browser connections; connect a real LiveKit provider to talk live.`
          : joinState.speaking === "agent"
            ? "Agent is speaking…"
            : joinState.speaking === "you"
              ? "You are speaking…"
              : "Connected. Say something — the transcript updates below the test panel.";

  return (
    <div
      aria-labelledby="voice-session-join-title"
      aria-modal="true"
      className="modal-overlay"
      ref={dialogRef}
      role="dialog"
    >
      <button
        aria-label="Close session join dialog"
        className="modal-overlay__backdrop"
        onClick={onClose}
        tabIndex={-1}
        type="button"
      />
      <section className="hosted-connect-link surface surface--raised">
        <div className="hosted-connect-link__icon" aria-hidden="true">
          <Icon name="voice" />
        </div>
        <p className="eyebrow">Live voice session</p>
        <h2 id="voice-session-join-title">Join this session</h2>
        <p aria-live="polite">{statusLabel}</p>
        <p>
          <small>
            Uses your microphone in this tab. The join grant expires{" "}
            {grant.expiresAt} and never leaves this dialog.
          </small>
        </p>
        <div className="modal-actions">
          <Button
            onClick={() => {
              leaveRoom();
              onClose();
            }}
            variant="ghost"
          >
            {connected ? "Leave & close" : "Close"}
          </Button>
          {connected ? (
            <Button onClick={leaveRoom} variant="danger">
              Leave room
            </Button>
          ) : (
            <Button
              disabled={joinState.phase === "connecting"}
              icon={<Icon name="voice" />}
              onClick={() => void join()}
              variant="primary"
            >
              {joinState.phase === "connecting" ? "Joining…" : "Join & talk"}
            </Button>
          )}
        </div>
        <div hidden ref={audioSinkRef} />
      </section>
    </div>
  );
}
