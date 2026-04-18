/**
 * Calculate a monthly installment estimate.
 * Default: 12 months, 0% interest (promotional zero-down).
 *
 * Formula (when interestRate > 0): standard amortization.
 *   M = P * r / (1 - (1 + r)^-n)
 * where r is monthly rate (annual / 12) and n is months.
 *
 * @param price        Total price (EGP)
 * @param months       Number of monthly installments (default 12)
 * @param interestRate Annual interest rate as decimal, e.g. 0.18 for 18% APR (default 0)
 * @returns            Monthly installment rounded to nearest EGP, or 0 for invalid input
 */
export function calculateInstallment(
  price: number,
  months: number = 12,
  interestRate: number = 0,
): number {
  if (!Number.isFinite(price) || price <= 0) return 0;
  if (!Number.isFinite(months) || months <= 0) return 0;

  if (interestRate === 0) {
    return Math.round(price / months);
  }

  const r = interestRate / 12;
  const monthly = (price * r) / (1 - Math.pow(1 + r, -months));
  return Math.round(monthly);
}
