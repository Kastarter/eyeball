import type { Metadata } from "next";
import { FilesScreen } from "@/src/components/files/files-screen";

export const metadata: Metadata = { title: "Files" };

export default async function Page({
  params,
}: {
  params: Promise<{ project: string }>;
}) {
  const { project } = await params;
  return <FilesScreen project={project} />;
}
