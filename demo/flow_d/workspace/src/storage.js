// src/storage.js
function sanitizeData(data) {
  return data.filter(item => item && typeof item === 'object' && !isNaN(item.id));
}

function saveWorkOrders(orders) {
  const sanitized = sanitizeData(orders);
  // Save sanitized data
}
