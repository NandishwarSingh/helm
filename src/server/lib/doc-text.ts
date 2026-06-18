import "server-only";

/** True if we can pull text from this attachment for embedding (else metadata-only). */
export function isExtractable(mime: string, filename: string): boolean {
  const name = filename.toLowerCase();
  return (
    mime === "application/pdf" ||
    mime.includes("word") ||
    mime.includes("spreadsheet") ||
    mime === "text/csv" ||
    mime.startsWith("text/") ||
    /\.(pdf|docx?|xlsx?|csv|txt|md)$/i.test(name)
  );
}

/**
 * Extract text from an attachment's bytes for embedding. Returns "" for anything
 * we can't parse (scanned/image PDFs, unknown types) so the caller falls back to
 * a metadata-only embedding. NEVER throws — a bad file must not break a scan.
 * The heavy parsers are dynamically imported so they only load when needed and
 * stay out of the client/edge bundle (serverExternalPackages in next.config).
 */
export async function extractDocText(
  mime: string,
  filename: string,
  bytes: Buffer,
): Promise<string> {
  const name = filename.toLowerCase();
  try {
    if (mime === "application/pdf" || name.endsWith(".pdf")) {
      const { getDocumentProxy, extractText } = await import("unpdf");
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      const { text } = await extractText(pdf, { mergePages: true });
      return text.trim();
    }
    if (mime.includes("word") || name.endsWith(".docx")) {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer: bytes });
      return result.value.trim();
    }
    if (
      mime.includes("spreadsheet") ||
      mime === "text/csv" ||
      /\.(xlsx?|csv)$/i.test(name)
    ) {
      const XLSX = await import("xlsx");
      const wb = XLSX.read(bytes, { type: "buffer" });
      return wb.SheetNames.map((sheet) =>
        XLSX.utils.sheet_to_csv(wb.Sheets[sheet]!),
      )
        .join("\n")
        .trim();
    }
    if (mime.startsWith("text/") || /\.(txt|md)$/i.test(name)) {
      return bytes.toString("utf-8").trim();
    }
  } catch {
    /* never block the pipeline on an unparseable file */
  }
  return "";
}

/** Coarse category bucket for the Documents UI. Mime-first, then extension
 *  (Gmail frequently sends application/octet-stream). */
export type DocCategory =
  | "pdf"
  | "image"
  | "doc"
  | "sheet"
  | "slide"
  | "archive"
  | "audio"
  | "video"
  | "other";

export function categorize(mime: string, filename: string): DocCategory {
  const name = filename.toLowerCase();
  if (mime === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg|bmp|heic)$/i.test(name))
    return "image";
  if (mime.startsWith("audio/") || /\.(mp3|wav|ogg|m4a|flac)$/i.test(name))
    return "audio";
  if (mime.startsWith("video/") || /\.(mp4|mov|webm|avi|mkv)$/i.test(name))
    return "video";
  if (mime.includes("spreadsheet") || mime === "text/csv" || /\.(xlsx?|csv|ods)$/i.test(name))
    return "sheet";
  if (mime.includes("presentation") || /\.(pptx?|key|odp)$/i.test(name)) return "slide";
  if (/(zip|rar|7z|tar|gzip|compressed)/.test(mime) || /\.(zip|rar|7z|tar|gz)$/i.test(name))
    return "archive";
  if (
    mime.includes("word") ||
    mime.includes("rtf") ||
    mime.startsWith("text/") ||
    /\.(docx?|rtf|odt|txt|md)$/i.test(name)
  )
    return "doc";
  return "other";
}
