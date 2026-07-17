import type { Metadata } from "next";
import { ScaffoldPage } from "@/src/components/pages/scaffold-page";
import { routeContent } from "@/src/lib/route-content";

export const metadata: Metadata = { title: "Voice Agents" };

export default function Page() {
  return <ScaffoldPage content={routeContent["voice-agents"]} />;
}
