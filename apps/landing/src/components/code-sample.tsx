import { DX_CODE } from "@/src/content";
import { CopyButton } from "./copy-button";

const CODE_LINES = DX_CODE.split("\n").map((line, index) => ({
  id: `quickstart-line-${index + 1}`,
  line,
}));

export function CodeSample() {
  return (
    <figure aria-labelledby="quickstart-caption" className="code-frame">
      <figcaption className="visually-hidden" id="quickstart-caption">
        Three-step Eyeball TypeScript quickstart
      </figcaption>
      <div className="code-frame__header">
        <div aria-hidden="true" className="code-frame__dots">
          <span />
          <span />
          <span />
        </div>
        <span className="code-frame__tab">quickstart.ts</span>
        <CopyButton code={DX_CODE} />
      </div>
      <pre>
        <code>
          {CODE_LINES.map(({ id, line }) => (
            <span
              className={
                line.trimStart().startsWith("//")
                  ? "code-line code-line--comment"
                  : "code-line"
              }
              key={id}
            >
              {line || " "}
            </span>
          ))}
        </code>
      </pre>
      <div className="code-frame__footer">
        <span>connect</span>
        <span aria-hidden="true">→</span>
        <span>get tools</span>
        <span aria-hidden="true">→</span>
        <span>execute</span>
      </div>
    </figure>
  );
}
