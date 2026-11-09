/**
 * Zero-dependency helper utilities injected into the QuickJS sandbox global scope.
 * Provides tabular data wrangling, RFC 4180 CSV parsing, statistics, math rounding,
 * line-based text operations, and assertion primitives without model token overhead.
 */
export const SANDBOX_PRELUDE_CODE = `
// --- CSV & Tabular Parsing & Serialization ---
var COMMON_FIELD_ALIASES = {
  current_stock: ["stock", "currentstock", "quantityonhand", "qtyonhand", "stockonhand", "onhand", "totalstock"],
  revenue: ["sales", "salesamount", "orderamount", "amount", "totalsales", "totalrevenue"],
  reorder_threshold: ["threshold", "reorderthreshold", "minstock", "minlevel"],
  unit_cost: ["cost", "unitcost", "price", "unitprice", "unit_price", "rate"],
  unit_price: ["price", "unitprice", "unit_cost", "cost", "unitcost", "rate"],
  order_id: ["orderid", "id"]
};

function createRowProxy(rawObj) {
  if (typeof Proxy === "undefined" || !rawObj || typeof rawObj !== "object" || rawObj.__isRowProxy) return rawObj;
  return new Proxy(rawObj, {
    get: function(target, prop) {
      if (prop === "__isRowProxy") return true;
      if (typeof prop !== "string") return target[prop];
      if (prop in target) return target[prop];
      var clean = prop.toLowerCase().replace(/[\\s_-]/g, "");
      for (var k in target) {
        if (k.toLowerCase().replace(/[\\s_-]/g, "") === clean) {
          return target[k];
        }
      }
      for (var canonical in COMMON_FIELD_ALIASES) {
        var allAliases = [canonical].concat(COMMON_FIELD_ALIASES[canonical]).map(function(s) { return s.toLowerCase().replace(/[\\s_-]/g, ""); });
        if (allAliases.indexOf(clean) !== -1) {
          for (var targetKey in target) {
            var targetClean = targetKey.toLowerCase().replace(/[\\s_-]/g, "");
            if (allAliases.indexOf(targetClean) !== -1) {
              return target[targetKey];
            }
          }
        }
      }
      if (clean === "revenue" || clean === "amount" || clean === "sales" || clean === "total" || clean === "totalsales" || clean === "totalrevenue") {
        var qty = rawObj.quantity !== undefined ? rawObj.quantity : (rawObj.qty !== undefined ? rawObj.qty : rawObj.units);
        var price = rawObj.unit_price !== undefined ? rawObj.unit_price : (rawObj.unitprice !== undefined ? rawObj.unitprice : (rawObj.price !== undefined ? rawObj.price : (rawObj.unit_cost !== undefined ? rawObj.unit_cost : rawObj.cost)));
        if (qty !== undefined && price !== undefined) {
          return Number(qty) * Number(price);
        }
      }
      if (clean === "price" || clean === "unitprice" || clean === "unitcost" || clean === "cost") {
        var rev = rawObj.revenue !== undefined ? rawObj.revenue : (rawObj.amount !== undefined ? rawObj.amount : (rawObj.sales !== undefined ? rawObj.sales : rawObj.total));
        var qty2 = rawObj.quantity !== undefined ? rawObj.quantity : (rawObj.qty !== undefined ? rawObj.qty : rawObj.units);
        if (rev !== undefined && qty2) {
          return Number(rev) / Number(qty2);
        }
      }
      if (clean === "deficit") {
        var thresh = rawObj.reorder_threshold !== undefined ? rawObj.reorder_threshold : (rawObj.threshold !== undefined ? rawObj.threshold : rawObj.min_stock);
        var stk = rawObj.current_stock !== undefined ? rawObj.current_stock : (rawObj.stock !== undefined ? rawObj.stock : rawObj.total_stock);
        if (thresh !== undefined && stk !== undefined) {
          return Math.max(0, Number(thresh) - Number(stk));
        }
      }
      var matches = [];
      for (var k in target) {
        var kClean = k.toLowerCase().replace(/[\\s_-]/g, "");
        if (kClean.indexOf(clean) !== -1 || clean.indexOf(kClean) !== -1) {
          matches.push(k);
        }
      }
      if (matches.length === 1) {
        return target[matches[0]];
      }
      return undefined;
    },
    has: function(target, prop) {
      if (typeof prop !== "string") return prop in target;
      if (prop in target) return true;
      var clean = prop.toLowerCase().replace(/[\\s_-]/g, "");
      for (var k in target) {
        if (k.toLowerCase().replace(/[\\s_-]/g, "") === clean) return true;
      }
      return false;
    },
    ownKeys: function(target) {
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor: function(target, prop) {
      return Object.getOwnPropertyDescriptor(target, prop) || {
        configurable: true,
        enumerable: true,
        value: this.get(target, prop)
      };
    }
  });
}

function parseCSV(text, options) {
  if (text == null) return [];
  if (typeof text === "object" && typeof text.content === "string") {
    text = text.content;
  }
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
    result.push(createRowProxy(obj));
  }
  return result;
}

function toCSV(rows, options) {
  if (!Array.isArray(rows) || rows.length === 0) return "";
  var opts = options || {};
  var delimiter = opts.delimiter || ",";

  function escapeVal(val) {
    if (val == null) return "";
    var str = String(val);
    if (str.includes(delimiter) || str.includes('"') || str.includes("\\n") || str.includes("\\r")) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  if (Array.isArray(rows[0])) {
    return rows.map(function(r) {
      return Array.isArray(r) ? r.map(escapeVal).join(delimiter) : escapeVal(r);
    }).join("\\n");
  }

  var columns = opts.columns || Object.keys(rows[0]);
  var headerLine = columns.map(escapeVal).join(delimiter);
  var dataLines = rows.map(function(r) {
    return columns.map(function(c) { return escapeVal(r[c]); }).join(delimiter);
  });
  return [headerLine].concat(dataLines).join("\\n");
}

function join(left, right, onKeyOrFn, options) {
  if (!Array.isArray(left) || !Array.isArray(right)) return [];
  var opts = options || {};
  var rightKeyFn;
  if (typeof onKeyOrFn === "function") {
    rightKeyFn = opts.rightKey || onKeyOrFn;
  } else if (typeof onKeyOrFn === "string") {
    var key = onKeyOrFn;
    onKeyOrFn = function(item) { return item != null ? item[key] : undefined; };
    rightKeyFn = opts.rightKey ? (typeof opts.rightKey === "function" ? opts.rightKey : function(item) { return item != null ? item[opts.rightKey] : undefined; }) : onKeyOrFn;
  } else {
    return [];
  }

  var rightMap = new Map();
  for (var j = 0; j < right.length; j++) {
    var rItem = right[j];
    var rKey = String(rightKeyFn(rItem));
    if (!rightMap.has(rKey)) rightMap.set(rKey, rItem);
  }

  var result = [];
  for (var i = 0; i < left.length; i++) {
    var lItem = left[i];
    var lKey = String(onKeyOrFn(lItem));
    var match = rightMap.get(lKey);
    if (match) {
      var merged = {};
      for (var mk in match) merged[mk] = match[mk];
      for (var lk in lItem) merged[lk] = lItem[lk];
      result.push(createRowProxy(merged));
    } else if (opts.how === "left" || opts.how === "outer") {
      result.push(lItem);
    }
  }
  return result;
}

// --- Tabular & Array Aggregations ---
function groupBy(array, keyOrFn) {
  if (!Array.isArray(array)) return {};
  var fn = typeof keyOrFn === "function" ? keyOrFn : function(item) { return item != null ? item[keyOrFn] : undefined; };
  var groups = {};
  for (var i = 0; i < array.length; i++) {
    var item = array[i];
    var key = String(fn(item));
    if (!groups[key]) {
      var arr = [];
      Object.defineProperty(arr, "key", { value: key, writable: true, configurable: true, enumerable: false });
      groups[key] = arr;
    }
    groups[key].push(item);
  }

  for (var k in groups) {
    var grp = groups[k];
    if (grp.length > 0 && typeof grp[0] === "object" && grp[0] !== null) {
      var first = grp[0];
      for (var prop in first) {
        if (!(prop in grp)) {
          (function(arr, p) {
            Object.defineProperty(arr, p, {
              get: function() { return this[0] ? this[0][p] : undefined; },
              set: function(v) { if (this[0]) this[0][p] = v; },
              enumerable: false,
              configurable: true
            });
          })(grp, prop);
        }
      }
    }
  }

  Object.defineProperty(groups, "map", {
    enumerable: false,
    configurable: true,
    writable: true,
    value: function(cb) {
      var self = this;
      return Object.keys(self).map(function(k, idx) {
        return cb(self[k], k, idx);
      });
    }
  });

  Object.defineProperty(groups, "forEach", {
    enumerable: false,
    configurable: true,
    writable: true,
    value: function(cb) {
      var self = this;
      Object.keys(self).forEach(function(k, idx) {
        cb(self[k], k, idx);
      });
    }
  });

  Object.defineProperty(groups, "filter", {
    enumerable: false,
    configurable: true,
    writable: true,
    value: function(cb) {
      var self = this;
      var filtered = {};
      Object.keys(self).forEach(function(k, idx) {
        if (cb(self[k], k, idx)) {
          filtered[k] = self[k];
        }
      });
      return filtered;
    }
  });

  Object.defineProperty(groups, "values", {
    enumerable: false,
    configurable: true,
    writable: true,
    value: function() {
      var self = this;
      return Object.keys(self).map(function(k) { return self[k]; });
    }
  });

  Object.defineProperty(groups, "entries", {
    enumerable: false,
    configurable: true,
    writable: true,
    value: function() {
      var self = this;
      return Object.keys(self).map(function(k) { return [k, self[k]]; });
    }
  });

  Object.defineProperty(groups, "keys", {
    enumerable: false,
    configurable: true,
    writable: true,
    value: function() {
      return Object.keys(this);
    }
  });

  return groups;
}

function countBy(array, keyOrFn) {
  if (!Array.isArray(array)) return {};
  var fn = typeof keyOrFn === "function" ? keyOrFn : function(item) { return item != null ? item[keyOrFn] : undefined; };
  var counts = {};
  for (var i = 0; i < array.length; i++) {
    var item = array[i];
    var key = String(fn(item));
    counts[key] = (counts[key] || 0) + 1;
  }
  Object.defineProperty(counts, "entries", { enumerable: false, configurable: true, writable: true, value: function() { var self = this; return Object.keys(self).map(function(k) { return [k, self[k]]; }); } });
  Object.defineProperty(counts, "values", { enumerable: false, configurable: true, writable: true, value: function() { var self = this; return Object.keys(self).map(function(k) { return self[k]; }); } });
  Object.defineProperty(counts, "keys", { enumerable: false, configurable: true, writable: true, value: function() { return Object.keys(this); } });
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

try {
  if (typeof Array !== "undefined" && Array.prototype) {
    if (!Array.prototype.unique) Array.prototype.unique = function(k) { return unique(this, k); };
    if (!Array.prototype.distinct) Array.prototype.distinct = function(k) { return unique(this, k); };
    if (!Array.prototype.sortBy) Array.prototype.sortBy = function(k, d) { return sortBy(this, k, d); };
    if (!Array.prototype.groupBy) Array.prototype.groupBy = function(k) { return groupBy(this, k); };
    if (!Array.prototype.sum) Array.prototype.sum = function(k) { return sum(this, k); };
    if (!Array.prototype.avg) Array.prototype.avg = function(k) { return avg(this, k); };
    if (!Array.prototype.min) Array.prototype.min = function(k) { return min(this, k); };
    if (!Array.prototype.max) Array.prototype.max = function(k) { return max(this, k); };
  }
} catch (e) {}

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

// --- File and Module Compatibility Shims ---
if (typeof readText === "undefined") {
  var readText = function(path, opts) {
    if (typeof tools !== "undefined" && tools.readFile) {
      return tools.readFile(path, opts).then(function(res) {
        return typeof res === "object" && res !== null && typeof res.content === "string" ? res.content : String(res != null ? res : "");
      });
    }
    if (typeof readTextSync !== "undefined") {
      try { return Promise.resolve(readTextSync(path)); } catch (e) {}
    }
    return Promise.reject(new Error("readText not available in this environment"));
  };
}

if (typeof readTable === "undefined") {
  var readTable = function(path, opts) {
    return readText(path, opts).then(function(txt) {
      return parseCSV(txt, opts);
    });
  };
}

if (typeof readJson === "undefined") {
  var readJson = function(path) {
    return readText(path).then(function(txt) {
      return JSON.parse(txt);
    });
  };
}

var fs = {
  promises: {
    readFile: function(path, enc) {
      if (typeof readTextSync !== "undefined") {
        try { return Promise.resolve(readTextSync(path)); } catch (e) {}
      }
      if (typeof readText !== "undefined") return readText(path);
      if (typeof tools !== "undefined" && tools.readFile) return tools.readFile(path).then(function(r) { return typeof r === "object" && r !== null && typeof r.content === "string" ? r.content : r; });
      return Promise.reject(new Error("File reading not supported in this context"));
    }
  },
  readFileSync: function(path, enc) {
    if (typeof readTextSync !== "undefined") return readTextSync(path);
    if (typeof readText !== "undefined") return readText(path);
    return "";
  }
};
var csv = {
  parse: function(text, opts) {
    return parseCSV(text, opts);
  },
  stringify: function(rows, opts) {
    return toCSV(rows, opts);
  }
};
var readFileSync = function(path, enc) {
  return fs.readFileSync(path, enc);
};
var readFile = function(path, enc) {
  return fs.promises.readFile(path, enc);
};
var parse = function(text, opts) {
  return parseCSV(text, opts);
};
var stringify = function(rows, opts) {
  return toCSV(rows, opts);
};
try {
  var _origObjKeys = Object.keys;
  Object.keys = function(obj) {
    if (obj instanceof Map) return Array.from(obj.keys());
    return _origObjKeys(obj);
  };
  var _origObjValues = Object.values;
  Object.values = function(obj) {
    if (obj instanceof Map) return Array.from(obj.values());
    return _origObjValues(obj);
  };
  var _origObjEntries = Object.entries;
  Object.entries = function(obj) {
    if (obj instanceof Map) return Array.from(obj.entries());
    return _origObjEntries(obj);
  };
} catch (e) {}
try {
  if (typeof tools !== "undefined") {
    tools.readText = tools.readText || function(path, opts) { return readText(path, opts); };
    tools.readTable = tools.readTable || function(path, opts) { return readTable(path, opts); };
    tools.readJson = tools.readJson || function(path) { return readJson(path); };
    tools.text = tools.text || function(val) { return typeof text === "function" ? text(val) : val; };
    tools.readFile = tools.readFile || function(path, opts) {
      return readText(path, opts).then(function(txt) {
        return {
          content: txt,
          toString: function() { return txt; },
          valueOf: function() { return txt; }
        };
      });
    };
    tools["import"] = function(mod) {
      if (mod === "fs") return Promise.resolve(fs);
      if (mod === "csv" || mod === "csv-parse" || mod === "csv-stringify") return Promise.resolve(csv);
      if (mod === "work_exec" || mod === "work-exec") return Promise.resolve({ readTable: readTable, readJson: readJson, readText: readText, readTextSync: readTextSync, toCSV: toCSV, parseCSV: parseCSV, emitDeliverable: emitDeliverable, text: text, sum: sum, avg: avg, min: min, max: max, round: round, groupBy: groupBy, join: join });
      return Promise.resolve({});
    };
  }
} catch (e) {}
`;
