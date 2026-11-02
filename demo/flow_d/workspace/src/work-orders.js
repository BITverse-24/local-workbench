export function filterWorkOrders(workOrders, { status = "all", query = "" } = {}) {
  const term = query.trim().toLowerCase();
  return workOrders.filter((order) => {
    const matchesQuery = !term || [order.id, order.title, order.site].some((value) => value.toLowerCase().includes(term));
    return matchesQuery;
  });
}

export function changeWorkOrderStatus(workOrders, id, status) {
  return workOrders.map((order) => order.id === id ? { ...order, status } : order);
}
