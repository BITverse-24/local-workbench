const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "../..");
const BASES_DIR = path.join(ROOT, "tests/eval/bases");
const TASKS_DIR = path.join(ROOT, "tests/eval/tasks");

fs.mkdirSync(TASKS_DIR, { recursive: true });

const CANDIDATE_MUTATIONS = [
  // --- js-orders (5 mutations) ---
  {
    id: "js-orders-filter-op",
    base: "js-orders",
    file: "src/orders.js",
    mutation: "inverted_filter",
    prompt: "filterOrdersByStatus is returning the wrong orders. Fix the condition in src/orders.js so tests pass.",
    original: "return orders.filter(order => order.status === status);",
    mutated: "return orders.filter(order => order.status !== status);",
    expectChangedFiles: ["src/orders.js"],
    oracle: "node --test test/orders.test.js"
  },
  {
    id: "js-orders-total-math",
    base: "js-orders",
    file: "src/orders.js",
    mutation: "wrong_math_operator",
    prompt: "calculateOrderTotal is giving incorrect sums. Fix the arithmetic in src/orders.js so tests pass.",
    original: "return items.reduce((sum, item) => sum + (item.price * item.quantity), 0);",
    mutated: "return items.reduce((sum, item) => sum + (item.price + item.quantity), 0);",
    expectChangedFiles: ["src/orders.js"],
    oracle: "node --test test/orders.test.js"
  },
  {
    id: "js-orders-discount-sub",
    base: "js-orders",
    file: "src/orders.js",
    mutation: "wrong_operator",
    prompt: "applyDiscount is increasing order total instead of discounting it. Fix src/orders.js so tests pass.",
    original: "return total - discountAmount;",
    mutated: "return total + discountAmount;",
    expectChangedFiles: ["src/orders.js"],
    oracle: "node --test test/orders.test.js"
  },
  {
    id: "js-orders-shipping-bound",
    base: "js-orders",
    file: "src/orders.js",
    mutation: "off_by_one",
    prompt: "Orders exactly at the free shipping threshold are denied free shipping. Fix the boundary comparison in src/orders.js so tests pass.",
    original: "return total >= threshold;",
    mutated: "return total > threshold;",
    expectChangedFiles: ["src/orders.js"],
    oracle: "node --test test/orders.test.js"
  },
  {
    id: "js-orders-find-empty",
    base: "js-orders",
    file: "src/orders.js",
    mutation: "wrong_fallback",
    prompt: "findOrderById returns undefined instead of null when an order is not found. Fix src/orders.js so tests pass.",
    original: "return orders.find(order => order.id === id) || null;",
    mutated: "return orders.find(order => order.id === id);",
    expectChangedFiles: ["src/orders.js"],
    oracle: "node --test test/orders.test.js"
  },

  // --- js-calculator (5 mutations) ---
  {
    id: "js-calc-mean-sum",
    base: "js-calculator",
    file: "src/math.js",
    mutation: "wrong_operator",
    prompt: "calculateMean returns incorrect averages. Fix the calculation in src/math.js so tests pass.",
    original: "const sum = numbers.reduce((acc, n) => acc + n, 0);",
    mutated: "const sum = numbers.reduce((acc, n) => acc * n, 1);",
    expectChangedFiles: ["src/math.js"],
    oracle: "node --test test/math.test.js"
  },
  {
    id: "js-calc-median-even",
    base: "js-calculator",
    file: "src/math.js",
    mutation: "wrong_math_operator",
    prompt: "calculateMedian returns the sum instead of average of midpoints for even arrays. Fix src/math.js so tests pass.",
    original: "return (sorted[mid - 1] + sorted[mid]) / 2;",
    mutated: "return (sorted[mid - 1] + sorted[mid]);",
    expectChangedFiles: ["src/math.js"],
    oracle: "node --test test/math.test.js"
  },
  {
    id: "js-calc-clamp-bound",
    base: "js-calculator",
    file: "src/math.js",
    mutation: "swapped_arguments",
    prompt: "clamp is not keeping values bounded properly. Fix src/math.js so tests pass.",
    original: "return Math.min(Math.max(value, min), max);",
    mutated: "return Math.max(Math.min(value, min), max);",
    expectChangedFiles: ["src/math.js"],
    oracle: "node --test test/math.test.js"
  },
  {
    id: "js-calc-factorial-base",
    base: "js-calculator",
    file: "src/math.js",
    mutation: "wrong_base_case",
    prompt: "factorial of 0 returns 0 instead of 1. Fix the base case in src/math.js so tests pass.",
    original: "if (n === 0 || n === 1) return 1;",
    mutated: "if (n === 1) return 1; if (n === 0) return 0;",
    expectChangedFiles: ["src/math.js"],
    oracle: "node --test test/math.test.js"
  },
  {
    id: "js-calc-stddev-sqrt",
    base: "js-calculator",
    file: "src/math.js",
    mutation: "missing_operation",
    prompt: "standardDeviation returns variance instead of standard deviation. Fix src/math.js so tests pass.",
    original: "return Math.sqrt(variance);",
    mutated: "return variance;",
    expectChangedFiles: ["src/math.js"],
    oracle: "node --test test/math.test.js"
  },

  // --- js-inventory (5 mutations) ---
  {
    id: "js-inv-lowstock-bound",
    base: "js-inventory",
    file: "src/inventory.js",
    mutation: "off_by_one",
    prompt: "getLowStockItems misses items exactly at the threshold. Fix the comparison in src/inventory.js so tests pass.",
    original: "return inventory.filter(item => item.quantity <= threshold);",
    mutated: "return inventory.filter(item => item.quantity < threshold);",
    expectChangedFiles: ["src/inventory.js"],
    oracle: "node --test test/inventory.test.js"
  },
  {
    id: "js-inv-adjust-stock",
    base: "js-inventory",
    file: "src/inventory.js",
    mutation: "wrong_operator",
    prompt: "adjustStock subtracts delta instead of adding it. Fix src/inventory.js so tests pass.",
    original: "const newQty = item.quantity + delta;",
    mutated: "const newQty = item.quantity - delta;",
    expectChangedFiles: ["src/inventory.js"],
    oracle: "node --test test/inventory.test.js"
  },
  {
    id: "js-inv-value-math",
    base: "js-inventory",
    file: "src/inventory.js",
    mutation: "wrong_operator",
    prompt: "totalInventoryValue adds cost and quantity instead of multiplying. Fix src/inventory.js so tests pass.",
    original: "return inventory.reduce((total, item) => total + ((item.cost || 0) * (item.quantity || 0)), 0);",
    mutated: "return inventory.reduce((total, item) => total + ((item.cost || 0) + (item.quantity || 0)), 0);",
    expectChangedFiles: ["src/inventory.js"],
    oracle: "node --test test/inventory.test.js"
  },
  {
    id: "js-inv-categorize-key",
    base: "js-inventory",
    file: "src/inventory.js",
    mutation: "wrong_property",
    prompt: "categorizeInventory groups items incorrectly. Fix the grouping property in src/inventory.js so tests pass.",
    original: "const category = item.category || \"uncategorized\";",
    mutated: "const category = item.type || \"uncategorized\";",
    expectChangedFiles: ["src/inventory.js"],
    oracle: "node --test test/inventory.test.js"
  },
  {
    id: "js-inv-restock-diff",
    base: "js-inventory",
    file: "src/inventory.js",
    mutation: "swapped_operands",
    prompt: "restockNeeds calculates negative needed quantities. Fix the subtraction order in src/inventory.js so tests pass.",
    original: ".map(item => ({ sku: item.sku, needed: targetLevel - item.quantity }));",
    mutated: ".map(item => ({ sku: item.sku, needed: item.quantity - targetLevel }));",
    expectChangedFiles: ["src/inventory.js"],
    oracle: "node --test test/inventory.test.js"
  },

  // --- js-strings (5 mutations) ---
  {
    id: "js-str-slug-lower",
    base: "js-strings",
    file: "src/formatter.js",
    mutation: "missing_case_conversion",
    prompt: "toSlug retains uppercase letters. Fix src/formatter.js so it lowercases the text and tests pass.",
    original: "return text\n    .toLowerCase()",
    mutated: "return text",
    expectChangedFiles: ["src/formatter.js"],
    oracle: "node --test test/formatter.test.js"
  },
  {
    id: "js-str-truncate-bound",
    base: "js-strings",
    file: "src/formatter.js",
    mutation: "wrong_operator",
    prompt: "truncate inverts the length condition and cuts short strings. Fix src/formatter.js so tests pass.",
    original: "if (text.length <= maxLength) return text;",
    mutated: "if (text.length > maxLength) return text;",
    expectChangedFiles: ["src/formatter.js"],
    oracle: "node --test test/formatter.test.js"
  },
  {
    id: "js-str-kebab-dash",
    base: "js-strings",
    file: "src/formatter.js",
    mutation: "wrong_delimiter",
    prompt: "camelToKebab separates words with underscores instead of dashes. Fix src/formatter.js so tests pass.",
    original: "return str.replace(/([a-z0-9]|(?=[A-Z]))([A-Z])/g, \"$1-$2\").toLowerCase();",
    mutated: "return str.replace(/([a-z0-9]|(?=[A-Z]))([A-Z])/g, \"$1_$2\").toLowerCase();",
    expectChangedFiles: ["src/formatter.js"],
    oracle: "node --test test/formatter.test.js"
  },
  {
    id: "js-str-capitalize-case",
    base: "js-strings",
    file: "src/formatter.js",
    mutation: "wrong_case",
    prompt: "capitalizeWords lowercases words instead of capitalizing. Fix src/formatter.js so tests pass.",
    original: "return text.replace(/\\b\\w/g, char => char.toUpperCase());",
    mutated: "return text.replace(/\\b\\w/g, char => char.toLowerCase());",
    expectChangedFiles: ["src/formatter.js"],
    oracle: "node --test test/formatter.test.js"
  },
  {
    id: "js-str-template-key",
    base: "js-strings",
    file: "src/formatter.js",
    mutation: "wrong_return",
    prompt: "renderTemplate returns empty string instead of rendered template. Fix src/formatter.js so tests pass.",
    original: "return template.replace(/\\{\\{(\\w+)\\}\\}/g, (_, key) => {\n    return key in data ? String(data[key]) : \"\";\n  });",
    mutated: "return \"\";",
    expectChangedFiles: ["src/formatter.js"],
    oracle: "node --test test/formatter.test.js"
  },

  // --- py-pricing (5 mutations) ---
  {
    id: "py-pricing-subtotal-math",
    base: "py-pricing",
    file: "pricing.py",
    mutation: "wrong_operator",
    prompt: "calculate_subtotal is adding price and quantity instead of multiplying. Fix pricing.py so tests pass.",
    original: "return sum(float(item.get(\"price\", 0)) * int(item.get(\"quantity\", 0)) for item in items)",
    mutated: "return sum(float(item.get(\"price\", 0)) + int(item.get(\"quantity\", 0)) for item in items)",
    expectChangedFiles: ["pricing.py"],
    oracle: "python3 -B -m unittest test_pricing.py"
  },
  {
    id: "py-pricing-vol-tier",
    base: "py-pricing",
    file: "pricing.py",
    mutation: "wrong_rate",
    prompt: "apply_volume_discount gives 30% discount at 100+ items instead of 20%. Fix the rate in pricing.py so tests pass.",
    original: "return subtotal * 0.80  # 20% discount",
    mutated: "return subtotal * 0.70  # 30% discount",
    expectChangedFiles: ["pricing.py"],
    oracle: "python3 -B -m unittest test_pricing.py"
  },
  {
    id: "py-pricing-tax-negative",
    base: "py-pricing",
    file: "pricing.py",
    mutation: "missing_check",
    prompt: "calculate_tax returns negative tax on negative amounts instead of 0.0. Fix pricing.py so tests pass.",
    original: "if amount < 0 or rate < 0:\n        return 0.0",
    mutated: "if rate < 0:\n        return 0.0",
    expectChangedFiles: ["pricing.py"],
    oracle: "python3 -B -m unittest test_pricing.py"
  },
  {
    id: "py-pricing-invoice-total",
    base: "py-pricing",
    file: "pricing.py",
    mutation: "wrong_operator",
    prompt: "calculate_final_invoice subtracts tax instead of adding it. Fix pricing.py so tests pass.",
    original: "return round(discounted + tax, 2)",
    mutated: "return round(discounted - tax, 2)",
    expectChangedFiles: ["pricing.py"],
    oracle: "python3 -B -m unittest test_pricing.py"
  },
  {
    id: "py-pricing-exempt-check",
    base: "py-pricing",
    file: "pricing.py",
    mutation: "inverted_condition",
    prompt: "is_tax_exempt inverts the tax exemption status. Fix pricing.py so tests pass.",
    original: "return bool(customer_record.get(\"tax_exempt\", False))",
    mutated: "return not bool(customer_record.get(\"tax_exempt\", False))",
    expectChangedFiles: ["pricing.py"],
    oracle: "python3 -B -m unittest test_pricing.py"
  },

  // --- py-validator (5 mutations) ---
  {
    id: "py-val-email-regex",
    base: "py-validator",
    file: "validator.py",
    mutation: "inverted_return",
    prompt: "is_valid_email returns False for valid emails. Fix validator.py so tests pass.",
    original: "return bool(re.match(pattern, email))",
    mutated: "return not bool(re.match(pattern, email))",
    expectChangedFiles: ["validator.py"],
    oracle: "python3 -B -m unittest test_validator.py"
  },
  {
    id: "py-val-port-bool",
    base: "py-validator",
    file: "validator.py",
    mutation: "missing_type_check",
    prompt: "is_valid_port treats boolean True as port 1. Disallow booleans in validator.py so tests pass.",
    original: "if not isinstance(port, int) or isinstance(port, bool):",
    mutated: "if not isinstance(port, int):",
    expectChangedFiles: ["validator.py"],
    oracle: "python3 -B -m unittest test_validator.py"
  },
  {
    id: "py-val-sanitize-strip",
    base: "py-validator",
    file: "validator.py",
    mutation: "missing_sanitize",
    prompt: "sanitize_username leaves punctuation in usernames. Fix validator.py so tests pass.",
    original: "cleaned = re.sub(r\"[^a-zA-Z0-9_-]\", \"\", username.strip())",
    mutated: "cleaned = username.strip()",
    expectChangedFiles: ["validator.py"],
    oracle: "python3 -B -m unittest test_validator.py"
  },
  {
    id: "py-val-pwd-length",
    base: "py-validator",
    file: "validator.py",
    mutation: "off_by_one",
    prompt: "validate_password_strength requires 12 characters instead of 8. Fix validator.py so tests pass.",
    original: "if not isinstance(password, str) or len(password) < 8:",
    mutated: "if not isinstance(password, str) or len(password) < 12:",
    expectChangedFiles: ["validator.py"],
    oracle: "python3 -B -m unittest test_validator.py"
  },
  {
    id: "py-val-bool-flag",
    base: "py-validator",
    file: "validator.py",
    mutation: "inverted_lookup",
    prompt: "parse_boolean_flag returns True for 'off'. Fix validator.py so tests pass.",
    original: "if normalized in (\"false\", \"0\", \"no\", \"off\"):\n            return False",
    mutated: "if normalized in (\"false\", \"0\", \"no\", \"off\"):\n            return True",
    expectChangedFiles: ["validator.py"],
    oracle: "python3 -B -m unittest test_validator.py"
  },

  // --- py-stats (5 mutations) ---
  {
    id: "py-stats-ma-window",
    base: "py-stats",
    file: "stats.py",
    mutation: "off_by_one",
    prompt: "moving_average computes one fewer window than expected. Fix the range boundary in stats.py so tests pass.",
    original: "for i in range(len(values) - window_size + 1):",
    mutated: "for i in range(len(values) - window_size):",
    expectChangedFiles: ["stats.py"],
    oracle: "python3 -B -m unittest test_stats.py"
  },
  {
    id: "py-stats-outliers-factor",
    base: "py-stats",
    file: "stats.py",
    mutation: "wrong_bound",
    prompt: "find_outliers_iqr miscalculates the upper bound. Fix stats.py so tests pass.",
    original: "upper_bound = q3 + (factor * iqr)",
    mutated: "upper_bound = q3 - (factor * iqr)",
    expectChangedFiles: ["stats.py"],
    oracle: "python3 -B -m unittest test_stats.py"
  },
  {
    id: "py-stats-range-diff",
    base: "py-stats",
    file: "stats.py",
    mutation: "wrong_operator",
    prompt: "calculate_range returns sum instead of difference. Fix stats.py so tests pass.",
    original: "return max(values) - min(values)",
    mutated: "return max(values) + min(values)",
    expectChangedFiles: ["stats.py"],
    oracle: "python3 -B -m unittest test_stats.py"
  },
  {
    id: "py-stats-norm-equal",
    base: "py-stats",
    file: "stats.py",
    mutation: "missing_zero_check",
    prompt: "normalize_min_max causes ZeroDivisionError when all elements are identical. Fix stats.py so tests pass.",
    original: "if min_val == max_val:\n        return [0.0 for _ in values]",
    mutated: "# omitted zero check\n    pass",
    expectChangedFiles: ["stats.py"],
    oracle: "python3 -B -m unittest test_stats.py"
  },
  {
    id: "py-stats-cumsum-reset",
    base: "py-stats",
    file: "stats.py",
    mutation: "missing_accumulation",
    prompt: "cumulative_sum returns each item instead of running total. Fix stats.py so tests pass.",
    original: "running += val\n        result.append(running)",
    mutated: "running = val\n        result.append(running)",
    expectChangedFiles: ["stats.py"],
    oracle: "python3 -B -m unittest test_stats.py"
  },

  // --- py-queue (5 mutations) ---
  {
    id: "py-queue-sort-order",
    base: "py-queue",
    file: "task_queue.py",
    mutation: "inverted_order",
    prompt: "PriorityTaskQueue pops lowest priority tasks first. Fix sort order in task_queue.py so tests pass.",
    original: "self._tasks.sort(key=lambda x: x[\"priority\"], reverse=True)",
    mutated: "self._tasks.sort(key=lambda x: x[\"priority\"], reverse=False)",
    expectChangedFiles: ["task_queue.py"],
    oracle: "python3 -B -m unittest test_task_queue.py"
  },
  {
    id: "py-queue-complete-status",
    base: "py-queue",
    file: "task_queue.py",
    mutation: "wrong_return",
    prompt: "complete returns False even when task is found. Fix task_queue.py so tests pass.",
    original: "task[\"status\"] = \"completed\"\n                return True",
    mutated: "task[\"status\"] = \"completed\"\n                return False",
    expectChangedFiles: ["task_queue.py"],
    oracle: "python3 -B -m unittest test_task_queue.py"
  },
  {
    id: "py-queue-retry-bound",
    base: "py-queue",
    file: "task_queue.py",
    mutation: "off_by_one",
    prompt: "fail dead-letters tasks earlier than max_retries. Fix task_queue.py comparison so tests pass.",
    original: "if task[\"attempts\"] >= max_retries:",
    mutated: "if task[\"attempts\"] > max_retries:",
    expectChangedFiles: ["task_queue.py"],
    oracle: "python3 -B -m unittest test_task_queue.py"
  },
  {
    id: "py-queue-empty-return",
    base: "py-queue",
    file: "task_queue.py",
    mutation: "wrong_fallback",
    prompt: "pop on an empty queue raises error instead of returning None. Fix task_queue.py so tests pass.",
    original: "return None",
    mutated: "raise IndexError(\"empty queue\")",
    expectChangedFiles: ["task_queue.py"],
    oracle: "python3 -B -m unittest test_task_queue.py"
  },
  {
    id: "py-queue-validate-id",
    base: "py-queue",
    file: "task_queue.py",
    mutation: "missing_validation",
    prompt: "push allows empty string task_ids. Reject empty task_ids with ValueError in task_queue.py so tests pass.",
    original: "if not isinstance(task_id, str) or not task_id:\n            raise ValueError(\"task_id must be a non-empty string\")",
    mutated: "if not isinstance(task_id, str):\n            raise ValueError(\"task_id must be a string\")",
    expectChangedFiles: ["task_queue.py"],
    oracle: "python3 -B -m unittest test_task_queue.py"
  }
];

function runTest(cwd, cmd) {
  try {
    execSync(cmd, { cwd, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function main() {
  console.log(`Validating ${CANDIDATE_MUTATIONS.length} candidate mutations...`);
  let validated = 0;
  const passedMutations = [];

  for (const item of CANDIDATE_MUTATIONS) {
    const baseDir = path.join(BASES_DIR, item.base);
    const targetFile = path.join(baseDir, item.file);

    if (!fs.existsSync(targetFile)) {
      console.error(`[FAIL] ${item.id}: target file not found ${targetFile}`);
      continue;
    }

    const originalContent = fs.readFileSync(targetFile, "utf8");
    if (!originalContent.includes(item.original)) {
      console.error(`[FAIL] ${item.id}: original snippet not found in ${item.file}`);
      continue;
    }

    // Step 1: Base test must pass
    if (!runTest(baseDir, item.oracle)) {
      console.error(`[FAIL] ${item.id}: base test failed before mutation!`);
      continue;
    }

    // Step 2: Apply mutation -> test must fail
    const mutatedContent = originalContent.replace(item.original, item.mutated);
    fs.writeFileSync(targetFile, mutatedContent, "utf8");

    const failedAsExpected = !runTest(baseDir, item.oracle);

    // Step 3: Revert mutation -> test must pass
    fs.writeFileSync(targetFile, originalContent, "utf8");
    const passedAfterRevert = runTest(baseDir, item.oracle);

    if (failedAsExpected && passedAfterRevert) {
      validated++;
      passedMutations.push(item);
      const taskSpec = {
        id: item.id,
        base: item.base,
        mutation: item.mutation,
        prompt: item.prompt,
        expectChangedFiles: item.expectChangedFiles,
        preserveExports: true,
        oracle: { command: item.oracle, mustPass: true }
      };
      fs.writeFileSync(path.join(TASKS_DIR, `${item.id}.json`), JSON.stringify(taskSpec, null, 2), "utf8");
      console.log(`[PASS] ${item.id} validated and written`);
    } else {
      console.error(`[FAIL] ${item.id}: mutation failed validation (failedAsExpected=${failedAsExpected}, passedAfterRevert=${passedAfterRevert})`);
    }
  }

  // Save the manifest of mutations for the eval runner
  fs.writeFileSync(path.join(TASKS_DIR, "manifest.json"), JSON.stringify(passedMutations, null, 2), "utf8");
  console.log(`\nSuccessfully validated and generated ${validated}/${CANDIDATE_MUTATIONS.length} tasks in ${TASKS_DIR}`);
}

main();
