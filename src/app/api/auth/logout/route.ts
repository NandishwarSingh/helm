import { NextResponse } from "next/server";

import { env } from "@/env";
import { clearSession } from "@/server/lib/session";

/** Signs the user out by clearing the session cookie, then returns home. */
export async function POST() {
  await clearSession();
  // 303 so the browser follows with a GET to the connect screen. Redirect to the
  // canonical site URL, not request.url — behind nginx the latter resolves to the
  // internal proxy host (localhost:3002), which would leak into the browser.
  return NextResponse.redirect(new URL("/", env.NEXT_PUBLIC_SITE_URL), 303);
}
