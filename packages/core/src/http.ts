// JSON responses and request bodies, for every server: the Worker and the local ones (the MCPB and
// the agent). Web-platform Request and Response only.

/** A JSON response. *headers* add to (or override) the JSON content type. */
export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });
}

/** An error response: {error: message}. */
export const error = (status: number, message: string, headers: Record<string, string> = {}): Response => json({ error: message }, status, headers);

/** Cookie *name*'s value in a Cookie header, or null. */
export function readCookie(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const p = part.trim();
    const eq = p.indexOf("=");
    if ((eq < 0 ? p : p.slice(0, eq)) === name) return eq < 0 ? "" : p.slice(eq + 1);
  }
  return null;
}

/** The request body as a JSON object, or {} if it isn't one. */
export async function bodyJson(req: Request): Promise<Record<string, any>> {
  try {
    const data = JSON.parse((await req.text()) || "{}");
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}
