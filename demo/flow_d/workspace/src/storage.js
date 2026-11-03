export const STORAGE_KEY = "fieldops.workOrders";

export function loadWorkOrders(storage, fallback) {
  const saved = storage.getItem(STORAGE_KEY);
  return saved === null ? fallback : JSON.parse(saved);
}

export function saveWorkOrders(storage, workOrders) {
  storage.setItem(STORAGE_KEY, JSON.stringify(workOrders));
}
