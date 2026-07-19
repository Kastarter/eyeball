import { SiteFooter, SiteHeader } from "./site-chrome";

interface LegalPageProps {
  children: React.ReactNode;
  title: string;
}

export function LegalPage({ children, title }: LegalPageProps) {
  return (
    <div className="legal-shell">
      <SiteHeader />
      <main className="legal-main" id="main">
        <div className="legal-card">
          <span className="draft-label">Draft Placeholder</span>
          <h1>{title}</h1>
          <p className="legal-card__lede">
            This route is reserved for launch. It is not a final legal policy.
          </p>
          <div className="legal-copy">{children}</div>
          <a className="text-link" href="/">
            Return to eyeball.dev
          </a>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
