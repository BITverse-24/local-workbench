import { starterWorkOrders } from "./seed.js";
import { loadWorkOrders, saveWorkOrders } from "./storage.js";
import { changeWorkOrderStatus, filterWorkOrders } from "./work-orders.js";

const list = document.querySelector("#work-order-list");
const search = document.querySelector("#search");
const statusFilter = document.querySelector("#status-filter");
const count = document.querySelector("#result-count");
const emptyState = document.querySelector("#empty-state");

let workOrders = loadWorkOrders(window.localStorage, starterWorkOrders);

function makeText(tag, className, value) {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = value;
  return element;
}

function renderOrder(order) {
  const card = document.createElement("article");
  card.className = "order-card";

  const primary = document.createElement("div");
  primary.className = "order-primary";
  primary.append(makeText("span", "order-icon", "▤"));
  const details = document.createElement("div");
  details.append(makeText("div", "order-id", order.id), makeText("div", "order-title", order.title));
  primary.append(details);

  const site = makeText("div", "order-site", order.site);
  const priority = makeText("div", `priority priority-${order.priority.toLowerCase()}`, order.priority);
  const status = document.createElement("select");
  status.className = "order-status";
  status.dataset.orderId = order.id;
  status.setAttribute("aria-label", `Status for ${order.id}`);
  for (const value of ["open", "in-progress", "closed"]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value === "in-progress" ? "In progress" : value[0].toUpperCase() + value.slice(1);
    option.selected = value === order.status;
    status.append(option);
  }
  status.dataset.status = order.status;
  card.append(primary, site, priority, status);
  return card;
}

function render() {
  const visibleOrders = filterWorkOrders(workOrders, { status: statusFilter.value, query: search.value });
  list.replaceChildren(...visibleOrders.map(renderOrder));
  count.textContent = `Showing ${visibleOrders.length} of ${workOrders.length} work orders`;
  emptyState.hidden = visibleOrders.length > 0;
}

search.addEventListener("input", render);
statusFilter.addEventListener("change", render);
list.addEventListener("change", (event) => {
  const control = event.target.closest("select[data-order-id]");
  if (!control) return;
  workOrders = changeWorkOrderStatus(workOrders, control.dataset.orderId, control.value);
  saveWorkOrders(window.localStorage, workOrders);
  render();
});

render();
