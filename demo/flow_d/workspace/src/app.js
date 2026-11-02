// src/app.js
function filterWorkOrders(status, searchQuery) {
  const filtered = workOrders.filter(order => 
    order.status === status && 
    (order.description.toLowerCase().includes(searchQuery.toLowerCase()) || 
     order.title.toLowerCase().includes(searchQuery.toLowerCase()))
  );
  return filtered;
}
