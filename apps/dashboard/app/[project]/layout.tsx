import type { ReactNode } from "react";
import { AppShell } from "@/src/components/shell/app-shell";

export default async function ProjectLayout({
  children,
  params,
}: Readonly<{
  children: ReactNode;
  params: Promise<{ project: string }>;
}>) {
  const { project } = await params;
  return <AppShell project={project}>{children}</AppShell>;
}
