export function toSlug(text) {
  if (typeof text !== "string") return "";
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function truncate(text, maxLength, suffix = "...") {
  if (typeof text !== "string") return "";
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - suffix.length) + suffix;
}

export function camelToKebab(str) {
  if (typeof str !== "string") return "";
  return str.replace(/([a-z0-9]|(?=[A-Z]))([A-Z])/g, "$1-$2").toLowerCase();
}

export function capitalizeWords(text) {
  if (typeof text !== "string") return "";
  return text.replace(/\b\w/g, char => char.toUpperCase());
}

export function renderTemplate(template, data) {
  if (typeof template !== "string" || !data || typeof data !== "object") return template || "";
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    return key in data ? String(data[key]) : "";
  });
}
