// Result type for better error handling across the app
export type Result<T, E = string> = { success: true; data: T } | { success: false; error: E };

export function Ok<T>(data: T): Result<T, never> {
  return { success: true, data };
}

export function Err<E>(error: E): Result<never, E> {
  return { success: false, error };
}
