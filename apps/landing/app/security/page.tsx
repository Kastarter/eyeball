import type { Metadata } from "next";
import { LegalPage } from "@/src/components/legal-page";

export const metadata: Metadata = {
  title: "Security",
  description: "Security disclosure information for eyeball.dev.",
};

export default function SecurityPage() {
  return (
    <LegalPage title="Security">
      <p>
        Eyeball treats credentials, user isolation, execution policy, and audit
        records as explicit system boundaries. The repository documents the
        current threat model and supported deployment assumptions.
      </p>
      <p>
        A public vulnerability-reporting channel will be published before the
        hosted service launches. Until then, do not include secrets or personal
        data in an unverified report channel.
      </p>
    </LegalPage>
  );
}
