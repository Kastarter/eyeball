import { redirect } from "next/navigation";

export default async function ProjectPage({
  params,
}: Readonly<{ params: Promise<{ project: string }> }>) {
  const { project } = await params;
  redirect(`/${encodeURIComponent(project)}/overview`);
}
