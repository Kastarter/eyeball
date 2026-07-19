import { cookies } from "next/headers";
import { executorKeyCookieName } from "./executor-key";

export async function isExecutorKeyConfigured(
  projectId: string,
): Promise<boolean> {
  return (await cookies()).has(executorKeyCookieName(projectId));
}
