import type { Metadata } from "next";
import { DesignGallery } from "@/src/components/pages/design-gallery";

export const metadata: Metadata = { title: "Design system" };

export default function Page() {
  return <DesignGallery />;
}
