import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * Get the storage key for runtime preferences for a project
 * Format: "runtime:{projectPath}"
 */
const getRuntimeKey = (projectPath: string): string => `runtime:${projectPath}`;

/**
 * Load saved runtime preference for a project
 * Returns runtime string ("ssh <host>") or null if not set
 */
export async function loadRuntimePreference(projectPath: string): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(getRuntimeKey(projectPath));
  } catch (error) {
    console.error("Failed to load runtime preference:", error);
    return null;
  }
}

/**
 * Save runtime preference for a project
 * @param projectPath - Project path
 * @param runtime - Runtime string ("ssh <host>" or "local")
 */
export async function saveRuntimePreference(projectPath: string, runtime: string): Promise<void> {
  try {
    await AsyncStorage.setItem(getRuntimeKey(projectPath), runtime);
  } catch (error) {
    console.error("Failed to save runtime preference:", error);
  }
}

/**
 * Clear runtime preference for a project
 */
export async function clearRuntimePreference(projectPath: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(getRuntimeKey(projectPath));
  } catch (error) {
    console.error("Failed to clear runtime preference:", error);
  }
}
