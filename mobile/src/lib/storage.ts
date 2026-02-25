import { Platform } from "react-native";

/**
 * Platform-aware key-value storage.
 *
 * On native (iOS/Android), delegates to expo-secure-store for encrypted storage.
 * On web, falls back to localStorage (sufficient for dev/testing; not "secure"
 * in the native sense, but the web platform has no equivalent secure enclave).
 */

type WebStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

function getWebStorage(): WebStorage {
  const webStorage = (globalThis as { localStorage?: WebStorage }).localStorage;
  if (!webStorage) {
    throw new Error("localStorage is unavailable on this platform");
  }
  return webStorage;
}

async function getSecureStore() {
  // Dynamic import so the native module is never loaded on web
  const mod = await import("expo-secure-store");
  return mod;
}

export async function getItem(key: string): Promise<string | null> {
  if (Platform.OS === "web") {
    return getWebStorage().getItem(key);
  }
  const SecureStore = await getSecureStore();
  return SecureStore.getItemAsync(key);
}

export async function setItem(key: string, value: string): Promise<void> {
  if (Platform.OS === "web") {
    getWebStorage().setItem(key, value);
    return;
  }
  const SecureStore = await getSecureStore();
  await SecureStore.setItemAsync(key, value);
}

export async function deleteItem(key: string): Promise<void> {
  if (Platform.OS === "web") {
    getWebStorage().removeItem(key);
    return;
  }
  const SecureStore = await getSecureStore();
  await SecureStore.deleteItemAsync(key);
}
