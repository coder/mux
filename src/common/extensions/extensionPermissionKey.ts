const EXTENSION_PERMISSION_KEY_SEPARATOR = "\0";

export function extensionPermissionKey(rootId: string, extensionId: string): string {
  return `${rootId}${EXTENSION_PERMISSION_KEY_SEPARATOR}${extensionId}`;
}

export function extensionIdFromPermissionKey(key: string): string {
  const separatorIndex = key.lastIndexOf(EXTENSION_PERMISSION_KEY_SEPARATOR);
  return separatorIndex === -1 ? key : key.slice(separatorIndex + 1);
}

export function rootIdFromPermissionKey(key: string): string | null {
  const separatorIndex = key.lastIndexOf(EXTENSION_PERMISSION_KEY_SEPARATOR);
  return separatorIndex === -1 ? null : key.slice(0, separatorIndex);
}
