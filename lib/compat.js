/**
 * Remove resource-bound replay handles from a serialized Responses request.
 * This is intentionally not a recursive ID scrubber: nested IDs, call_id,
 * file_id, encrypted reasoning, text, arguments and tool outputs are content.
 *
 * The caller must send full history. Dropping a reference cannot hydrate it.
 * @param {string} text
 * @returns {string | undefined} New JSON, or undefined for byte-for-byte passthrough.
 */
export function relayResponsesCompatPatch(text) {
  if (typeof text !== 'string') return undefined
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return undefined
  }
  if (body === null || typeof body !== 'object' || !Array.isArray(body.input)) return undefined

  let changed = false
  if (Object.hasOwn(body, 'previous_response_id')) {
    delete body.previous_response_id
    changed = true
  }
  const input = []
  for (const item of body.input) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      input.push(item)
      continue
    }
    if (item.type === 'item_reference') {
      changed = true
      continue
    }
    if (typeof item.id === 'string') {
      const copy = { ...item }
      delete copy.id
      input.push(copy)
      changed = true
    } else {
      input.push(item)
    }
  }
  if (!changed) return undefined
  body.input = input
  return JSON.stringify(body)
}
