/** בדיקת ספרת ביקורת של מספר זהות ישראלי (עד 9 ספרות, משלימים באפסים מובילים) */
export function isValidIsraeliId(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 5 || digits.length > 9) return false;
  const padded = digits.padStart(9, "0");
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let n = Number(padded[i]) * ((i % 2) + 1);
    if (n > 9) n -= 9;
    sum += n;
  }
  return sum % 10 === 0;
}

/** מספר טלפון ישראלי (נייד או קווי), עם או בלי קידומת 972 */
export function isValidIsraeliPhone(value: string): boolean {
  const digits = value.replace(/\D/g, "").replace(/^972/, "0");
  return /^0\d{8,9}$/.test(digits);
}
