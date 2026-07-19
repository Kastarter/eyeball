"use client";

import type { CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";
import { RESTAURANT_TRANSCRIPT } from "@/src/content";

type DelayStyle = CSSProperties & { "--reveal-delay": string };

export function TranscriptReplay() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [replay, setReplay] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }

    if (typeof IntersectionObserver === "undefined") {
      setIsPlaying(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting === true) {
          setIsPlaying(true);
          observer.disconnect();
        }
      },
      { threshold: 0.3 },
    );
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  function replayTranscript(): void {
    setIsPlaying(true);
    setReplay((current) => current + 1);
  }

  return (
    <div
      className={`transcript-shell${isPlaying ? " is-playing" : ""}`}
      ref={containerRef}
    >
      <div className="transcript-shell__header">
        <div className="session-identity">
          <span aria-hidden="true" className="session-pulse" />
          <span>Table Host</span>
          <span className="session-id">ses_restaurant_01</span>
        </div>
        <button
          className="replay-button"
          onClick={replayTranscript}
          type="button"
        >
          Replay Transcript
        </button>
      </div>
      <ol className="transcript" key={replay}>
        {RESTAURANT_TRANSCRIPT.map((entry, index) => {
          const style = {
            "--reveal-delay": `${index * 520}ms`,
          } as DelayStyle;
          return entry.kind === "tool" ? (
            <li
              className="transcript-line transcript-line--tool"
              key={entry.id}
              style={style}
            >
              <span className="tool-chip">
                <span aria-hidden="true" className="tool-chip__spark" />
                <code>{entry.tool}</code>
                <span aria-hidden="true">→</span>
                <span>{entry.detail}</span>
              </span>
            </li>
          ) : (
            <li
              className={`transcript-line transcript-line--${
                entry.speaker === "Caller" ? "caller" : "agent"
              }`}
              key={entry.id}
              style={style}
            >
              <span className="transcript-speaker">{entry.speaker}</span>
              <p>“{entry.text}”</p>
            </li>
          );
        })}
      </ol>
      <div className="transcript-shell__status">
        <span>3 actions</span>
        <span>2 child executions</span>
        <span>1 trace</span>
      </div>
    </div>
  );
}
