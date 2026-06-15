import { type NextRequest, NextResponse } from "next/server";

import { clearSession } from "@/server/lib/session";

/** Signs the user out by clearing the session cookie, then returns home. */
export async function POST(request: NextRequest) {
  await clearSession();
  // 303 so the browser follows with a GET to the connect screen.
  return NextResponse.redirect(new URL("/", request.url), 303);
}
