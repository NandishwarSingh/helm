import { type NextRequest, NextResponse } from "next/server";

import { putAttachment } from "@/server/lib/attachment-store";
import { extractDocText, isExtractable } from "@/server/lib/doc-text";
import { rateLimit } from "@/server/lib/rate-limit";
import { getOwnerId, getTenantId } from "@/server/lib/session";

// Parsers (unpdf/mammoth/xlsx) are native/server-only — never the edge runtime.
export const runtime = "nodejs";

// Mirrors the attachment scan cap; a buffered parse past this is refused.
const MAX_BYTES = 10 * 1024 * 1024;

/**
 * Upload-and-parse for the agent: the user drops a PDF/Word/Excel/CSV/text file,
 * we extract its text server-side and hand it back. The bytes are never stored —
 * the extracted text rides with the next chat turn as context. Session-gated and
 * rate-limited; only text-bearing types are accepted.
 */
export async function POST(request: NextRequest) {
  const tenantId = await getTenantId();
  if (!tenantId) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }
  const { ok, retryAfterMs } = await rateLimit(`agent-attach:${tenantId}`, 30, 60_000);
  if (!ok) {
    return NextResponse.json(
      { error: `Too many uploads. Try again in ${Math.ceil(retryAfterMs / 1000)}s.` },
      { status: 429 },
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid upload." }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file provided." }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: "File too large (max 10MB)." },
      { status: 413 },
    );
  }
  const name = file.name || "attachment";
  const mime = file.type || "application/octet-stream";
  if (!isExtractable(mime, name)) {
    return NextResponse.json(
      { error: "Unsupported file. Use a PDF, Word, Excel, text or CSV file." },
      { status: 415 },
    );
  }

  let text: string;
  let token = "";
  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    text = await extractDocText(mime, name, bytes);
    // Stash the bytes so a later "attach this & send it" can fold the real file
    // into the email's MIME. Owner-scoped; the token rides with the chat turn.
    const owner = await getOwnerId();
    if (owner) token = putAttachment(owner, name, mime, bytes);
  } catch {
    return NextResponse.json({ error: "Couldn't read that file." }, { status: 422 });
  }
  if (!text.trim()) {
    return NextResponse.json(
      { error: "No readable text in that file." },
      { status: 422 },
    );
  }
  return NextResponse.json({ name, mimeType: mime, text: text.slice(0, 8000), token });
}
