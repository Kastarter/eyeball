import Link from "next/link";
import type { MDXRemoteProps } from "next-mdx-remote/rsc";
import type {
  AnchorHTMLAttributes,
  ComponentProps,
  CSSProperties,
  HTMLAttributes,
  ReactNode,
  TableHTMLAttributes,
} from "react";
import { isValidElement } from "react";
import { reactNodeToText, slugifyHeading } from "../lib/markdown";
import { CopyButton } from "./copy-button";
import { Icon, type IconName } from "./icon";

type MdxComponents = NonNullable<MDXRemoteProps["components"]>;

function MdxLink({
  children,
  href = "",
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement>) {
  if (href.startsWith("/")) {
    const internalProps = props as Omit<ComponentProps<typeof Link>, "href">;
    return (
      <Link href={href} {...internalProps}>
        {children}
      </Link>
    );
  }

  const external = href.startsWith("http://") || href.startsWith("https://");
  const rel = external
    ? Array.from(new Set([props.rel, "noreferrer"].filter(Boolean))).join(" ")
    : props.rel;
  return (
    <a
      {...props}
      href={href}
      rel={rel}
      target={external ? "_blank" : props.target}
    >
      {children}
    </a>
  );
}

function createHeading(level: 2 | 3) {
  const Heading = ({
    children,
    ...props
  }: HTMLAttributes<HTMLHeadingElement>) => {
    const text = reactNodeToText(children);
    const id = slugifyHeading(text);
    const Tag = `h${level}` as "h2" | "h3";
    return (
      <Tag id={id} {...props}>
        <a
          aria-label={`Link to ${text}`}
          className="heading-anchor"
          href={`#${id}`}
        >
          {children}
          <span aria-hidden="true">#</span>
        </a>
      </Tag>
    );
  };
  Heading.displayName = `MdxHeading${level}`;
  return Heading;
}

function findLanguage(node: ReactNode): string | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const language = findLanguage(child);
      if (language) {
        return language;
      }
    }
  }

  if (isValidElement<{ className?: string; children?: ReactNode }>(node)) {
    const match = /(?:^|\s)language-([^\s]+)/.exec(node.props.className ?? "");
    return match?.[1] ?? findLanguage(node.props.children);
  }

  return undefined;
}

function languageLabel(language: string): string {
  const labels: Record<string, string> = {
    bash: "Bash",
    http: "HTTP",
    javascript: "JavaScript",
    json: "JSON",
    text: "Text",
    typescript: "TypeScript",
  };
  return labels[language] ?? language;
}

function CodeBlock({ children, ...props }: HTMLAttributes<HTMLPreElement>) {
  const code = reactNodeToText(children).replace(/\n$/, "");
  const language = findLanguage(children) ?? "text";
  return (
    <div className="code-frame" data-language={language}>
      <div className="code-frame__header">
        <span className="code-frame__tab">{languageLabel(language)}</span>
        <CopyButton code={code} />
      </div>
      <pre {...props}>{children}</pre>
    </div>
  );
}

function Table({ children, ...props }: TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="table-frame">
      <table {...props}>{children}</table>
    </div>
  );
}

interface CardProps {
  children?: ReactNode;
  href: string;
  icon?: string;
  title: string;
}

function Card({ children, href, icon = "chevron-right", title }: CardProps) {
  return (
    <Link className="mdx-card" href={href}>
      <span className="mdx-card__icon">
        <Icon name={icon as IconName} size={24} />
      </span>
      <span className="mdx-card__copy">
        <strong>{title}</strong>
        {children ? <span>{children}</span> : null}
      </span>
      <Icon className="mdx-card__arrow" name="chevron-right" size={16} />
    </Link>
  );
}

function CardGroup({
  children,
  cols = 2,
}: {
  children: ReactNode;
  cols?: number;
}) {
  return (
    <div
      className="mdx-card-group"
      style={{ "--card-columns": cols } as CSSProperties}
    >
      {children}
    </div>
  );
}

function Accordion({
  children,
  title,
}: {
  children: ReactNode;
  title: string;
}) {
  return (
    <details className="mdx-accordion">
      <summary>
        <span>{title}</span>
        <Icon name="chevron-right" size={16} />
      </summary>
      <div className="mdx-accordion__content">{children}</div>
    </details>
  );
}

type CalloutTone = "info" | "note" | "tip" | "warning";

function Callout({
  children,
  tone,
}: {
  children: ReactNode;
  tone: CalloutTone;
}) {
  const icon = tone === "warning" ? "warning" : tone === "tip" ? "tip" : "info";
  return (
    <aside className={`mdx-callout mdx-callout--${tone}`}>
      <span className="mdx-callout__icon">
        <Icon name={icon} size={16} />
      </span>
      <div>{children}</div>
    </aside>
  );
}

function Badge({
  children,
  color = "purple",
}: {
  children: ReactNode;
  color?: string;
}) {
  return <span className={`mdx-badge mdx-badge--${color}`}>{children}</span>;
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <figure className="mdx-frame">
      <div className="mdx-frame__chrome">
        <span />
        <span />
        <span />
      </div>
      <div className="mdx-frame__content">{children}</div>
    </figure>
  );
}

function Update({
  children,
  description,
  label,
}: {
  children: ReactNode;
  description: string;
  label: string;
}) {
  return (
    <section className="mdx-update">
      <div className="mdx-update__rail" aria-hidden="true">
        <span />
      </div>
      <div className="mdx-update__body">
        <div className="mdx-update__header">
          <time>{label}</time>
          <strong>{description}</strong>
        </div>
        <div>{children}</div>
      </div>
    </section>
  );
}

const H2 = createHeading(2);
const H3 = createHeading(3);

export const mdxComponents: MdxComponents = {
  a: MdxLink,
  h2: H2,
  h3: H3,
  pre: CodeBlock,
  table: Table,
  Accordion,
  Badge,
  Card,
  CardGroup,
  Frame,
  Info: ({ children }: { children: ReactNode }) => (
    <Callout tone="info">{children}</Callout>
  ),
  Note: ({ children }: { children: ReactNode }) => (
    <Callout tone="note">{children}</Callout>
  ),
  Tip: ({ children }: { children: ReactNode }) => (
    <Callout tone="tip">{children}</Callout>
  ),
  Update,
  Warning: ({ children }: { children: ReactNode }) => (
    <Callout tone="warning">{children}</Callout>
  ),
};
