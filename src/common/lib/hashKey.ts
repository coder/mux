import xxhash from "xxhash-wasm";

let xxhasher: Awaited<ReturnType<typeof xxhash>> | null = null;

/**
 * Generate a 64-bit hash key for caching/deduplication.
 * Prefers SHA-256 (truncated to 64 bits) when crypto.subtle is available,
 * falls back to xxhash64 in insecure contexts (e.g., HTTP dev servers).
 */
export async function hashKey(input: string): Promise<string> {
  // crypto.subtle is only available in secure contexts (HTTPS/localhost)
  if (crypto.subtle) {
    const data = new TextEncoder().encode(input);
    const hash = await crypto.subtle.digest("SHA-256", data);
    // Take first 8 bytes (64 bits) as hex
    return Array.from(new Uint8Array(hash).slice(0, 8))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  // Fallback to xxhash64 for dev environments
  xxhasher ??= await xxhash();
  return xxhasher.h64(input).toString(16);
}
