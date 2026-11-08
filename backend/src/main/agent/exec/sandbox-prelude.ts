/**
 * Zero-dependency helper utilities injected into the QuickJS sandbox global scope.
 * Provides tabular data wrangling, RFC 4180 CSV parsing, statistics, math rounding,
 * line-based text operations, and assertion primitives without model token overhead.
 */
export const SANDBOX_PRELUDE_CODE = `
// --- CSV & Tabular Parsing & Serialization ---
function parseCSV(text, options) {
  if (text == null) return [];
  var opts = options || {};
  var str = String(text);
  var delimiter = opts.delimiter || (str.indexOf("\\t") !== -1 && str.indexOf(",") === -1 ? "\\t" : ",");
  var autoTypes = opts.autoTypes !== false;
  var hasHeader = opts.hasHeader !== false;

  var rows = [];
  var currentRow = [];
  var currentVal = "";
  var inQuotes = false;

  for (var i = 0; i < str.length; i++) {
    var c = str[i];
    var next = str[i + 1];

    if (inQuotes) {
      if (c === '"') {
        if (next === '"') {
          currentVal += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        currentVal += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === delimiter) {
        currentRow.push(currentVal.trim());
        currentVal = "";
      } else if (c === "\\r") {
        if (next === "\\n") i++;
        currentRow.push(currentVal.trim());
        rows.push(currentRow);
        currentRow = [];
        currentVal = "";
      } else if (c === "\\n") {
        currentRow.push(currentVal.trim());
        rows.push(currentRow);
        currentRow = [];
        currentVal = "";
      } else {
        currentVal += c;
      }
    }
  }
  if (currentVal || currentRow.length > 0) {
    currentRow.push(currentVal.trim());
    rows.push(currentRow);
  }

  var cleanRows = rows.filter(function(r) {
    return r.length > 1 || (r.length === 1 && r[0] !== "");
  });
  if (cleanRows.length === 0) return [];

  function castVal(v) {
    if (!autoTypes || typeof v !== "string") return v;
    var trimmed = v.trim();
    if (trimmed === "") return "";
    var lower = trimmed.toLowerCase();
    if (lower === "true") return true;
    if (lower === "false") return false;
    if (lower === "null") return null;
    if (!isNaN(trimmed) && !isNaN(parseFloat(trimmed))) return Number(trimmed);
    return v;
  }

  if (!hasHeader) {
    return cleanRows.map(function(r) { return r.map(castVal); });
  }

  var headers = cleanRows[0].map(function(h) { return String(h).trim(); });
  var result = [];
  for (var rowIdx = 1; rowIdx < cleanRows.length; rowIdx++) {
    var row = cleanRows[rowIdx];
    var obj = {};
    for (var colIdx = 0; colIdx < headers.length; colIdx++) {
      var header = headers[colIdx] || ("col_" + (colIdx + 1));
      obj[header] = castVal(row[colIdx] !== undefined ? row[colIdx] : "");
    }
    result.push(obj);
  }
  return result;
}

function toCSV(rows, options) {
  if (!Array.isArray(rows) || rows.length === 0) return "";
  var opts = options || {};
  var delimiter = opts.delimiter || ",";
  var columns = opts.columns || Object.keys(rows[0]);

  function escapeVal(val) {
    if (val == null) return "";
    var str = String(val);
    if (str.includes(delimiter) || str.includes('"') || str.includes("\\n") || str.includes("\\r")) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  var headerLine = columns.map(escapeVal).join(delimiter);
  var dataLines = rows.map(function(r) {
    return columns.map(function(c) { return escapeVal(r[c]); }).join(delimiter);
  });
  return [headerLine].concat(dataLines).join("\\n");
}

// --- Tabular & Array Aggregations ---
function groupBy(array, keyOrFn) {
  if (!Array.isArray(array)) return {};
  var fn = typeof keyOrFn === "function" ? keyOrFn : function(item) { return item != null ? item[keyOrFn] : undefined; };
  var groups = {};
  for (var i = 0; i < array.length; i++) {
    var item = array[i];
    var key = String(fn(item));
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }
  return groups;
}

function countBy(array, keyOrFn) {
  if (!Array.isArray(array)) return {};
  var fn = typeof keyOrFn === "function" ? keyOrFn : function(item) { return item != null ? item[keyOrFn] : undefined; };
  var counts = {};
  for (var i = 0; i < array.length; i++) {
    var key = String(fn(array[i]));
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function _resolveNum(item, keyOrFn) {
  if (keyOrFn === undefined) return typeof item === "number" ? item : Number(item);
  var val = typeof keyOrFn === "function" ? keyOrFn(item) : (item != null ? item[keyOrFn] : undefined);
  return typeof val === "number" ? val : Number(val);
}

function sum(array, keyOrFn) {
  if (!Array.isArray(array) || array.length === 0) return 0;
  var total = 0;
  for (var i = 0; i < array.length; i++) {
    var num = _resolveNum(array[i], keyOrFn);
    if (!isNaN(num)) total += num;
  }
  return total;
}

function avg(array, keyOrFn) {
  if (!Array.isArray(array) || array.length === 0) return 0;
  var total = 0;
  var count = 0;
  for (var i = 0; i < array.length; i++) {
    var num = _resolveNum(array[i], keyOrFn);
    if (!isNaN(num)) {
      total += num;
      count++;
    }
  }
  return count > 0 ? total / count : 0;
}
var mean = avg;

function median(array, keyOrFn) {
  if (!Array.isArray(array) || array.length === 0) return 0;
  var numbers = [];
  for (var i = 0; i < array.length; i++) {
    var num = _resolveNum(array[i], keyOrFn);
    if (!isNaN(num)) numbers.push(num);
  }
  if (numbers.length === 0) return 0;
  numbers.sort(function(a, b) { return a - b; });
  var mid = Math.floor(numbers.length / 2);
  return numbers.length % 2 !== 0 ? numbers[mid] : (numbers[mid - 1] + numbers[mid]) / 2;
}

function min(array, keyOrFn) {
  if (!Array.isArray(array) || array.length === 0) return undefined;
  var m = undefined;
  for (var i = 0; i < array.length; i++) {
    var num = _resolveNum(array[i], keyOrFn);
    if (!isNaN(num)) {
      if (m === undefined || num < m) m = num;
    }
  }
  return m;
}

function max(array, keyOrFn) {
  if (!Array.isArray(array) || array.length === 0) return undefined;
  var m = undefined;
  for (var i = 0; i < array.length; i++) {
    var num = _resolveNum(array[i], keyOrFn);
    if (!isNaN(num)) {
      if (m === undefined || num > m) m = num;
    }
  }
  return m;
}

function sortBy(array, keyOrFn, direction) {
  if (!Array.isArray(array)) return [];
  var dir = direction === "desc" ? -1 : 1;
  var fn = typeof keyOrFn === "function" ? keyOrFn : function(item) { return item != null ? item[keyOrFn] : undefined; };
  return array.slice().sort(function(a, b) {
    var va = fn(a);
    var vb = fn(b);
    if (va === vb) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
    return String(va).localeCompare(String(vb)) * dir;
  });
}

function unique(array, keyOrFn) {
  if (!Array.isArray(array)) return [];
  if (!keyOrFn) return Array.from(new Set(array));
  var fn = typeof keyOrFn === "function" ? keyOrFn : function(item) { return item != null ? item[keyOrFn] : undefined; };
  var seen = new Set();
  var res = [];
  for (var i = 0; i < array.length; i++) {
    var item = array[i];
    var key = fn(item);
    if (!seen.has(key)) {
      seen.add(key);
      res.push(item);
    }
  }
  return res;
}
var distinct = unique;

function pivot(array, rowKey, colKey, valKey, aggFn) {
  if (!Array.isArray(array)) return [];
  var agg = aggFn || function(vals) { return sum(vals); };
  var rowMap = {};
  var allCols = new Set();

  for (var i = 0; i < array.length; i++) {
    var item = array[i];
    var r = String(item[rowKey]);
    var c = String(item[colKey]);
    var v = item[valKey];
    allCols.add(c);
    if (!rowMap[r]) rowMap[r] = {};
    if (!rowMap[r][c]) rowMap[r][c] = [];
    if (v !== undefined) rowMap[r][c].push(v);
  }

  var cols = Array.from(allCols).sort();
  var result = [];
  var rows = Object.keys(rowMap);
  for (var rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    var rName = rows[rowIdx];
    var rowObj = {};
    rowObj[rowKey] = rName;
    for (var colIdx = 0; colIdx < cols.length; colIdx++) {
      var cName = cols[colIdx];
      var vals = rowMap[rName][cName] || [];
      rowObj[cName] = vals.length > 0 ? agg(vals) : 0;
    }
    result.push(rowObj);
  }
  return result;
}

// --- Math & Numerical Operations ---
function round(num, decimals) {
  var d = decimals !== undefined ? Number(decimals) : 2;
  var factor = Math.pow(10, d);
  return Math.round((Number(num) + Number.EPSILON) * factor) / factor;
}

function approxEqual(a, b, tolerance) {
  var tol = tolerance !== undefined ? Number(tolerance) : 0.001;
  return Math.abs(Number(a) - Number(b)) <= tol;
}

function pctDiff(a, b) {
  var na = Number(a);
  var nb = Number(b);
  if (na === 0) return nb === 0 ? 0 : 100;
  return round(((nb - na) / Math.abs(na)) * 100, 2);
}

// --- Text & Line-Based Operations ---
function lines(text, options) {
  if (text == null) return [];
  var opts = options || {};
  var list = String(text).split(/\\r?\\n/);
  if (opts.trim !== false) list = list.map(function(l) { return l.trim(); });
  if (opts.skipEmpty) list = list.filter(function(l) { return l.length > 0; });
  return list;
}

function grep(textOrLines, pattern) {
  var list = Array.isArray(textOrLines) ? textOrLines : lines(textOrLines);
  var re = typeof pattern === "string" ? new RegExp(pattern, "i") : pattern;
  return list.filter(function(l) { return re.test(l); });
}

// --- Assertion Helpers (Verification / Test Scripts) ---
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "Assertion failed");
}
function assertEqual(a, b, msg) {
  if (a !== b) throw new Error((msg ? msg + ": " : "") + "Expected " + JSON.stringify(b) + ", received " + JSON.stringify(a));
}
function assertApprox(a, b, tol, msg) {
  if (!approxEqual(a, b, tol)) {
    throw new Error((msg ? msg + ": " : "") + "Value " + a + " differs from " + b + " by more than tolerance " + (tol || 0.001));
  }
}

// --- Formatter & Summary Helpers ---
function preview(val, maxItems) {
  var limit = maxItems || 5;
  if (Array.isArray(val)) {
    if (val.length === 0) return "[] (empty array)";
    var sample = val.slice(0, limit);
    return "Array(" + val.length + " items):\\n" + JSON.stringify(sample, null, 2) + (val.length > limit ? "\\n... and " + (val.length - limit) + " more items" : "");
  }
  if (val && typeof val === "object") {
    var keys = Object.keys(val);
    return "Object(" + keys.length + " keys: " + keys.slice(0, 10).join(", ") + "):\\n" + JSON.stringify(val, null, 2);
  }
  return String(val);
}
`;
