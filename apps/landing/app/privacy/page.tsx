import type { Metadata } from "next";
import { LegalPage } from "@/src/components/legal-page";

export const metadata: Metadata = {
  title: "Privacy Policy Draft",
  description: "Draft privacy-policy placeholder for eyeball.dev.",
  robots: { index: false, follow: true },
};

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy">
      <p>
        The final policy will describe what the hosted service collects, how
        end-user connection data is protected, retention choices, and how to
        request access or deletion.
      </p>
      <p>
        Until that review is complete, do not rely on this placeholder as a
        statement of production data handling.
      </p>
    </LegalPage>
  );
}
