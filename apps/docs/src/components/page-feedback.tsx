"use client";

import { useState } from "react";
import { Icon } from "./icon";

type FeedbackValue = "no" | "yes";

export function PageFeedback() {
  const [feedback, setFeedback] = useState<FeedbackValue>();

  function submitFeedback(value: FeedbackValue) {
    setFeedback((current) => (current === value ? undefined : value));
  }

  return (
    <section aria-label="Page feedback" className="page-feedback">
      <p aria-live="polite">
        {feedback ? "Thanks for the feedback." : "Was this page helpful?"}
      </p>
      <div className="page-feedback__actions">
        <button
          aria-label="Yes, this page was helpful"
          aria-pressed={feedback === "yes"}
          onClick={() => submitFeedback("yes")}
          type="button"
        >
          <Icon name="thumbs-up" size={16} />
          <span>Yes</span>
        </button>
        <button
          aria-label="No, this page was not helpful"
          aria-pressed={feedback === "no"}
          onClick={() => submitFeedback("no")}
          type="button"
        >
          <Icon name="thumbs-down" size={16} />
          <span>No</span>
        </button>
      </div>
    </section>
  );
}
