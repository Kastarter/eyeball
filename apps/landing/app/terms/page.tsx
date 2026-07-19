import type { Metadata } from "next";
import { LegalPage } from "@/src/components/legal-page";

export const metadata: Metadata = {
  title: "Terms of Service Draft",
  description: "Draft terms-of-service placeholder for eyeball.dev.",
  robots: { index: false, follow: true },
};

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service">
      <p>
        The final terms will cover account responsibilities, acceptable use,
        service boundaries, provider connections, billing, and warranty terms.
      </p>
      <p>
        The repository license is also under final legal review. This route is
        deliberately marked draft until both reviews are complete.
      </p>
    </LegalPage>
  );
}
