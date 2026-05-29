import crypto from "crypto";

export function uniqueSuffix(labels: crypto.BinaryLike[]): string {
  const hash = crypto.createHash("sha256");

  for (const label of labels) {
    hash.update(label);
  }

  const uniqueSuffix = hash.digest("hex").substring(0, 8);

  return uniqueSuffix;
}
