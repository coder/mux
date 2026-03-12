/**
 * Convert a Date to a UTC "YYYY-MM-DD" string.
 *
 * Used across the analytics module for date bucketing, date-range
 * filters, and daily aggregation keys.
 */
export function toUtcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}
