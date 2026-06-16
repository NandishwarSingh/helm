import { Landing } from "@/app/_components/landing";
import { AppShell } from "@/app/_components/app-shell";
import { getTenantId } from "@/server/lib/session";

/**
 * Server-side fork: anonymous visitors (and crawlers) get the fully
 * server-rendered landing page; returning users with a session cookie get
 * the app shell, which verifies the Google connection client-side.
 */
export default async function Page() {
  const tenantId = await getTenantId();
  if (!tenantId) return <Landing />;
  return <AppShell />;
}
