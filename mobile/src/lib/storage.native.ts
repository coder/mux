/**
 * Native platform key-value storage.
 *
 * Delegates to expo-secure-store for encrypted storage on iOS and Android.
 */
import * as SecureStore from "expo-secure-store";

export async function getItem(key: string): Promise<string | null> {
  return SecureStore.getItemAsync(key);
}

export async function setItem(key: string, value: string): Promise<void> {
  await SecureStore.setItemAsync(key, value);
}

export async function deleteItem(key: string): Promise<void> {
  await SecureStore.deleteItemAsync(key);
}
