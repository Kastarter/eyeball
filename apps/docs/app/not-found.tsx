import Link from "next/link";
import { ApertureLogo } from "@/src/components/aperture-logo";

export default function NotFound() {
  return (
    <main className="not-found">
      <ApertureLogo size={42} watching />
      <p>404</p>
      <h1>This page slipped out of view.</h1>
      <span>The documentation route does not exist.</span>
      <Link href="/">Return to documentation</Link>
    </main>
  );
}
