import { convertToModelMessages, type UIMessage } from "ai";
import { type NextRequest, NextResponse } from "next/server";

import { suggestFollowups } from "@/server/lib/agent-suggest";
import { rateLimit } from "@/server/lib/rate-limit";
import { getTenantId } from "@/server/lib/session";

export const runtime = "nodejs";

/**
 * Follow-up chips, generated OUT of the main chat stream. suggestFollowups is an
 * LLM call (~1-3s) that used to lose an 800ms race inside the response stream, so
 * chips almost never showed. The client now calls this once a turn settles — the
 * input is already re-enabled, and the chips pop in when ready. Best-effort:
 * returns [] on any error.
 */
export async function POST(request: NextRequest) {
  const tenantId = await getTenantId();
  if (!tenantId) {
    return NextResponse.json({ suggestions: [] });
  }
  const { ok } = await rateLimit(`agent-suggest:${tenantId}`, 30, 60_000);
  if (!ok) return NextResponse.json({ suggestions: [] });

  const body = (await request.json().catch(() => null)) as {
    messages?: UIMessage[];
  } | null;
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return NextResponse.json({ suggestions: [] });
  }
  try {
    const recent = body.messages
      .slice(-6)
      .map((m) => ({
        ...m,
        parts: m.parts.filter((p) => !p.type.startsWith("data-")),
      }))
      .filter((m) => m.parts.length > 0);
    const suggestions = await suggestFollowups(await convertToModelMessages(recent));
    return NextResponse.json({ suggestions });
  } catch {
    return NextResponse.json({ suggestions: [] });
  }
}
