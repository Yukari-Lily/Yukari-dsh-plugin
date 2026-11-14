/**
 * Shared HTTP plumbing for the component routes.
 *
 * Every subsystem answers a small JSON API over the same web server, so the
 * response writer, the bounded body reader, the connection guard, the error
 * shape and the download headers live here instead of being copied into each
 * `index.js`.
 * @module yukari-dsh-plugin/shared/http
 */
import { pipeline } from 'node:stream/promises'

/** Request body ceilings, chosen by what an action has to carry. */
export const BODY_LIMITS = {
  small: 16 * 1024,
  normal: 64 * 1024,
  large: 128 * 1024,
}

/** Turn any thrown value into a message. */
export const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/**
 * Build a failure the panel can translate.
 *
 * The message stays the authoritative text (logs, curl, tool output); `code` is
 * the stable identity the panel maps to its own wording, and `params` are the
 * values that wording needs. Keeping them apart means a reworded message never
 * breaks the translation, and a missing translation still reads correctly.
 * @param message - Chinese text used when no translation exists.
 * @param code - stable identifier, e.g. `proxy-port-busy`.
 * @param params - optional placeholder values for the panel's wording.
 * @param status - optional HTTP status; defaults to the guard's 400.
 */
export function appError(message, code, params, status) {
  const error = new Error(message)
  if (typeof code === 'string' && code !== '') error.appCode = code
  if (params !== undefined && params !== null) error.params = params
  if (Number.isInteger(status)) error.status = status
  return error
}

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
      // `appCode` 是我们自己给的稳定标识，`code` 是 Node 的 errno（EACCES 等）；
      // 面板靠前者翻译，后者只用来判定 500，两者不能混用。
      const appCode = typeof error?.appCode === 'string' && error.appCode !== '' ? error.appCode : null
      const params = error?.params !== null && typeof error?.params === 'object' && !Array.isArray(error.params) ? error.params : null
      sendJson(res, explicit ?? (coded ? 500 : 400), {
        ok: false,
        error: messageOf(error),
        ...(appCode === null ? {} : { code: appCode }),
        ...(params === null ? {} : { params }),
      })
    }
  }
}

/**
 * `content-disposition` with an ASCII fallback name and an RFC 5987 name.
 *
 * Only `filename=` percent-encodes a non-ASCII name into `%E6%8A%A5...`, which
 * the browser then saves literally; only `filename*=` leaves older clients
 * without a name. Both are needed.
 * @param name - the file name to offer.
 * @returns the header value.
 */
export function attachmentHeader(name) {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

/**
 * Pipe one stream into a response until it is written or the client leaves.
 *
 * `pipeline` destroys both ends on failure, so neither a handle nor the handler
 * is left hanging; the explicit `close` listener stops the source immediately
 * when the client cancels before `pipeline` notices.
 * @param stream - the source stream.
 * @param response - the HTTP response.
 */
export async function streamToResponse(stream, response) {
  const abort = () => { if (!response.writableFinished) stream.destroy() }
  response.on('close', abort)
  try {
    await pipeline(stream, response)
  } catch (error) {
    // A client that cancels early leaves nobody to write an error envelope to,
    // and this is not a server fault.
    if (!response.destroyed && !response.writableEnded) throw error
  } finally {
    response.off('close', abort)
  }
}
