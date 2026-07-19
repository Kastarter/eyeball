import type { Metadata } from "next";
import { redirect } from "next/navigation";
import {
  AuthScreen,
  safeDashboardNextPath,
} from "@/src/components/auth/auth-screen";
import { loadCloudSession } from "@/src/lib/cloud-server";
import { isCloudMode } from "@/src/lib/runtime-config";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | readonly string[] | undefined>>;
}) {
  if (!isCloudMode()) redirect("/demo/overview");
  if ((await loadCloudSession()) !== undefined) redirect("/");
  const query = await searchParams;
  const requested = Array.isArray(query.next) ? query.next[0] : query.next;
  return (
    <AuthScreen kind="login" nextPath={safeDashboardNextPath(requested)} />
  );
}
