import { AsyncLocalStorage } from "node:async_hooks";

/**
 * מדידת זמנים לכל שלב בבקשת תשלום (למשל: אימות משתמש, מסד נתונים, Make, בדיקת הטמעה).
 *
 * מה נרשם: שמות שלבים קבועים מהקוד ומשך במילישניות בלבד. אין כאן מזהי לקוח, סכומים, כתובות, מפתחות או תוכן
 * תשובות. שם שלב שאינו תואם לתבנית נזרק בשקט, כך שגם טעות בקוד לא תכניס ללוג ערך דינמי.
 *
 * הקוד העמוק (למשל ספק Make) קורא ל-timeStep בלי לקבל אובייקט מדידה כפרמטר: ההקשר עובר דרך AsyncLocalStorage.
 * מחוץ להקשר מדידה (בדיקות, webhook, כל קריאה אחרת) timeStep פשוט מריץ את הפעולה.
 */

const STEP_NAME = /^[a-z][a-z0-9_.]{0,39}$/;
const MAX_STEPS = 32;

export interface TimingStep {
  name: string;
  ms: number;
}

export class TimingRecorder {
  private readonly started: number;
  private readonly steps = new Map<string, number>();

  constructor(private readonly now: () => number = () => performance.now()) {
    this.started = now();
  }

  /** מוסיף משך לשלב (שלב שחוזר על עצמו מצטבר). שם לא תקין או חריגה ממספר השלבים - מתעלמים */
  add(name: string, ms: number): void {
    if (!STEP_NAME.test(name) || !Number.isFinite(ms) || ms < 0) return;
    if (!this.steps.has(name) && this.steps.size >= MAX_STEPS) return;
    this.steps.set(name, (this.steps.get(name) ?? 0) + ms);
  }

  /** מריץ פעולה ורושם את משכה, גם כשהיא נכשלת */
  async step<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const t0 = this.now();
    try {
      return await fn();
    } finally {
      this.add(name, this.now() - t0);
    }
  }

  /** מריץ את fn כשההקשר הזה פעיל, כדי ש-timeStep בקוד עמוק ירשום אליו */
  run<T>(fn: () => Promise<T>): Promise<T> {
    return storage.run(this, fn);
  }

  totalMs(): number {
    return this.now() - this.started;
  }

  list(): TimingStep[] {
    return [...this.steps].map(([name, ms]) => ({ name, ms }));
  }

  /** ערך לכותרת Server-Timing (תקן W3C): "name;dur=12.3, ..., total;dur=456.7". נראה ב-DevTools של הדפדפן */
  serverTimingHeader(): string {
    return [...this.list(), { name: "total", ms: this.totalMs() }]
      .map((s) => `${s.name};dur=${s.ms.toFixed(1)}`)
      .join(", ");
  }

  /** שורת לוג אחת: "total=456ms auth=12ms make.http=300ms ..." (מספרים שלמים, בלי שום ערך מהבקשה) */
  logFields(): string {
    return [`total=${Math.round(this.totalMs())}ms`, ...this.list().map((s) => `${s.name}=${Math.round(s.ms)}ms`)].join(" ");
  }
}

const storage = new AsyncLocalStorage<TimingRecorder>();

/** מודד שלב בהקשר המדידה הפעיל (אם יש). בלי הקשר - רק מריץ */
export function timeStep<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const recorder = storage.getStore();
  return recorder ? recorder.step(name, fn) : fn();
}
