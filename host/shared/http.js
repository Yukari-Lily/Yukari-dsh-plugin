/**
 * Shared HTTP plumbing for the component routes.
 *
 * Every subsystem answers a small JSON API over the same web server, so the
 * response writer, the bounded body reader, the connection guard and the error
 * shape live here instead of being copied into each `index.js`.
 * @module yukari-dsh-plugin/shared/http
 */

/** Request body ceilings, chosen by what an action has to carry. */
export const BODY_LIMITS = {
  small: 16 * 1024,
  normal: 64 * 1024,
  large: 128 * 1024,
}

/** Turn any thrown value into a message. */
export const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/**
 * Write one JSON response.
 * @param res - the response.
 * @param status - HTTP status.
 * @param value - JSON-serializable payload.
 */
export function sendJson(res, status, value) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}

/**
 * Read a JSON object body, refusing anything larger than `limit`.
 * @param req - the request.
 * @param limit - maximum accepted bytes.
 * @returns the parsed object; an empty body yields `{}`.
 */
export async function readJsonBody(req, limit = BODY_LIMITS.normal) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body is too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  let value
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('request body is not valid JSON')
  }
  // Action handlers expect an object; a JSON array or scalar is not one.
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/**
 * Wrap a route handler with the connection guard and one error boundary.
 *
 * The guard rejects requests that did not come from an authorised connection;
 * the boundary turns an uncaught failure into the same JSON error shape every
 * action already returns, and never writes a second header block.
 * @param ctx - plugin context carrying the `connection` service.
 * @param handler - `(req, res) => Promise<void>`.
 * @returns the guarded handler.
 */
export function guardRoute(ctx, handler) {
  return async (req, res) => {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection !== undefined && rejection !== null) {
      res.statusCode = rejection
      res.end()
      return
    }
    try {
      await handler(req, res)
    } catch (error) {
      if (res.headersSent) {
        res.end()
        return
      }
      // An explicit status wins; a thrown filesystem/pnpm/git failure carries a
      // code and is the host's problem, not the caller's. Everything we reject
      // ourselves is a plain Error and stays a 400 the panel can show verbatim.
      const explicit = Number.isInteger(error?.status) ? error.status : null
      const coded = typeof error?.code === 'string' && error.code !== ''
      sendJson(res, explicit ?? (coded ? 500 : 400), { ok: false, error: messageOf(error) })
    }
  }
}
