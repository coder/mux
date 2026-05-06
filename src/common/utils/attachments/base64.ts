const MAX_ATTACHMENT_BASE64_CHARS = 15_000_000;

export function isValidBase64AttachmentData(data: string): boolean {
  if (data.length > MAX_ATTACHMENT_BASE64_CHARS) {
    return false;
  }

  return /^[A-Za-z0-9+/]*={0,2}$/.test(data);
}
