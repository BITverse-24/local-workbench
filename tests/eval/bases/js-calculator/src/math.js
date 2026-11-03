export function calculateMean(numbers) {
  if (!Array.isArray(numbers) || numbers.length === 0) return 0;
  const sum = numbers.reduce((acc, n) => acc + n, 0);
  return sum / numbers.length;
}

export function calculateMedian(numbers) {
  if (!Array.isArray(numbers) || numbers.length === 0) return 0;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

export function clamp(value, min, max) {
  if (min > max) {
    throw new Error("min cannot exceed max");
  }
  return Math.min(Math.max(value, min), max);
}

export function standardDeviation(numbers) {
  if (!Array.isArray(numbers) || numbers.length < 2) return 0;
  const mean = calculateMean(numbers);
  const variance = numbers.reduce((acc, n) => acc + Math.pow(n - mean, 2), 0) / numbers.length;
  return Math.sqrt(variance);
}

export function factorial(n) {
  if (n < 0) throw new Error("negative numbers not supported");
  if (n === 0 || n === 1) return 1;
  let result = 1;
  for (let i = 2; i <= n; i++) {
    result *= i;
  }
  return result;
}
