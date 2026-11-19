// The URL carries only this digest. Only its creator has the key needed
// to attach a JPEG after the link has already been copied.
export async function previewId(key) {
  const bytes = new TextEncoder().encode("mobicat-preview/" + key);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
}
