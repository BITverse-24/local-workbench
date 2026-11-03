export function filterOrdersByStatus(orders, status) {
  if (!Array.isArray(orders)) return [];
  return orders.filter(order => order.status === status);
}

export function calculateOrderTotal(items) {
  if (!Array.isArray(items)) return 0;
  return items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
}

export function applyDiscount(total, discountPercent) {
  if (total <= 0 || discountPercent <= 0) return total;
  if (discountPercent > 100) return 0;
  const discountAmount = (total * discountPercent) / 100;
  return total - discountAmount;
}

export function isEligibleForFreeShipping(total, threshold = 50) {
  return total >= threshold;
}

export function findOrderById(orders, id) {
  if (!Array.isArray(orders)) return null;
  return orders.find(order => order.id === id) || null;
}
