import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthScreen } from "@/src/components/auth/auth-screen";
import { loadCloudSession } from "@/src/lib/cloud-server";
import { isCloudMode } from "@/src/lib/runtime-config";

export const metadata: Metadata = { title: "Create account" };

export default async function SignupPage() {
  if (!isCloudMode()) redirect("/demo/overview");
  if ((await loadCloudSession()) !== undefined) redirect("/");
  return <AuthScreen kind="signup" />;
}
