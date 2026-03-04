export interface SavedQuery {
  id: string;
  label: string;
  sql: string;
  chartType: string | null;
  order: number;
  createdAt: string;
}
