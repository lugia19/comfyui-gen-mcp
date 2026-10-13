// JSON responses and request bodies, for every server: the Worker and the local ones (the MCPB and
// the agent). Web-platform Request and Response only.

/** A JSON response. *headers* add to (or override) the JSON content type. */
export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });
}

/** An error response: {error: message}. */
export const error = (status: number, message: string, headers: Record<string, string> = {}): Response => json({ error: message }, status, headers);

/** The request body as a JSON object, or {} if it isn't one. */
export async function bodyJson(req: Request): Promise<Record<string, any>> {
  try {
    const data = JSON.parse((await req.text()) || "{}");
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}
