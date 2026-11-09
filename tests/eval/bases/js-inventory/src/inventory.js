export function getLowStockItems(inventory, threshold = 5) {
  if (!Array.isArray(inventory)) return [];
  return inventory.filter(item => item.quantity <= threshold);
}

export function adjustStock(item, delta) {
  if (!item || typeof item.quantity !== "number") throw new Error("Invalid item");
  const newQty = item.quantity + delta;
  if (newQty < 0) throw new Error("Insufficient stock");
  return { ...item, quantity: newQty };
}

export function totalInventoryValue(inventory) {
  if (!Array.isArray(inventory)) return 0;
  return inventory.reduce((total, item) => total + ((item.cost || 0) * (item.quantity || 0)), 0);
}

export function categorizeInventory(inventory) {
  if (!Array.isArray(inventory)) return {};
  const map = {};
  for (const item of inventory) {
    const category = item.category || "uncategorized";
    if (!map[category]) map[category] = [];
    map[category].push(item);
  }
  return map;
}

export function restockNeeds(inventory, targetLevel = 20) {
  if (!Array.isArray(inventory)) return [];
  return inventory
    .filter(item => item.quantity < targetLevel)
    .map(item => ({ sku: item.sku, needed: targetLevel - item.quantity }));
}
