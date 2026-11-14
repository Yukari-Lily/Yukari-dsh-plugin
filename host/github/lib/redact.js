/**
 * Token redaction for the Github component.
 *
 * Third-party error text (fetch implementations, git's stderr, GitHub response
 * bodies) can echo whatever it was given, so every message that may leave this
 * component goes through here first. Both the raw token and its URL-encoded
 * form are replaced: a request URL or a proxy error may carry either.
 * @module yukari-dsh-plugin/github/redact
 */

/**
 * Replace every occurrence of the secret in a message.
 * @param text - any value; only its string form is inspected.
 * @param token - the secret to hide; an empty or non-string value is a no-op.
 * @returns the text with the token replaced by `***`.
 */
export function redact(text, token) {
  const value = String(text ?? '')
  if (typeof token !== 'string' || token === '') return value
  const encoded = encodeURIComponent(token)
  return value.split(token).join('***').split(encoded).join('***')
}
