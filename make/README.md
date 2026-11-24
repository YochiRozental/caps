# תרחישי Make לתשלום ב-Grow (Sandbox)

שני תרחישים שהאתר מדבר איתם כש-`PAYMENT_PROVIDER=make` (ראו `src/lib/payments/make-provider.ts`):

| קובץ | מה הוא עושה | משתנה סביבה באתר |
|---|---|---|
| `1-grow-create-payment-link.blueprint.json` | יוצר קישור תשלום ב-Grow ומחזיר אותו לאתר | `MAKE_PAYMENT_WEBHOOK_URL`, `MAKE_PAYMENT_API_KEY` |
| `2-grow-verify-payment.blueprint.json` | בודק ב-Grow אם התשלום עבר | `MAKE_VERIFY_WEBHOOK_URL`, `MAKE_VERIFY_API_KEY` |

## ייבוא (לכל אחד משני הקבצים)

1. ב-Make: **Scenarios** ← **Create a new scenario**.
2. בסרגל התחתון לוחצים **⋯** ← **Import Blueprint** ← בוחרים את הקובץ ← **Save**.
3. לוחצים על המודול הראשון (Webhooks) ← **Add** ← נותנים שם (למשל `caps-create` / `caps-verify`).
   - פותחים **Show advanced settings** ← **API Keys** ← **Add** ← מדביקים מפתח אקראי של 24 תווים לפחות.
     את אותו מפתח שמים באתר ב-`MAKE_PAYMENT_API_KEY` (תרחיש 1) או `MAKE_VERIFY_API_KEY` (תרחיש 2).
   - **Save**, ואז **Copy address to clipboard** ← זו הכתובת ל-`MAKE_PAYMENT_WEBHOOK_URL` / `MAKE_VERIFY_WEBHOOK_URL`.
4. לוחצים על מודול ה-HTTP ומחליפים:
   - `PASTE_GROW_PAGE_CODE` ← ה-pageCode של Grow Sandbox
   - `PASTE_GROW_USER_ID` ← ה-userId של Grow Sandbox (רק בתרחיש 1)
5. שומרים, ומדליקים את התרחיש (מתג **ON** / Immediately).

## משתני סביבה ב-Staging

```
PAYMENT_PROVIDER=make
PAYMENT_ENVIRONMENT=sandbox
MAKE_VERIFICATION_CONFIRMED=true
MAKE_PACKAGE_PING_ENABLED=false
MAKE_PAYMENT_WEBHOOK_URL=<כתובת ה-webhook של תרחיש 1>
MAKE_PAYMENT_API_KEY=<המפתח של תרחיש 1>
MAKE_VERIFY_WEBHOOK_URL=<כתובת ה-webhook של תרחיש 2>
MAKE_VERIFY_API_KEY=<המפתח של תרחיש 2>
MAKE_PAYMENT_RETURN_BASE_URL=https://<כתובת אתר ה-Staging>
MAKE_PAYMENT_CHECKOUT_HOSTS=sandbox.meshulam.co.il,sandbox.grow.link
```

שער ה-Staging חייב להיות פעיל (`STAGING_GATE_ENABLED=true` וכו') - בלעדיו ספק Make חסום.

## החוזה (מה האתר שולח ומה הוא מצפה לקבל)

**תרחיש 1** מקבל: `reference, idempotencyKey, amount (שקלים, "500.00"), currency, description, purpose, fullName, phone, email, returnUrl, notifyUrl`
ומחזיר: `{"url", "processId", "processToken"}`. כשל ב-Grow ← HTTP 502.

**תרחיש 2** מקבל: `reference, processId, processToken`
ומחזיר: `{"reference", "processId", "currency", "statusCode", "sum", "transactionId"}`.
`statusCode`: 2 שולם, 9 נדחה, 4 בוטל, 0/ריק עדיין לא שולם. אם יש בתהליך עסקה ששולמה - מוחזרים הסכום ומזהה העסקה שלה.

## התראת שרת (notifyUrl): הפעלת חבילה גם כשהלקוח סגר את הדפדפן

האתר שולח לתרחיש 1 שדה נוסף, `notifyUrl`: כתובת חתומה באתר (`/api/payments/webhook/make-grow?ref=...&sig=...`).
תרחיש 1 מעביר אותה ל-Grow, ו-Grow שולח אליה התראה מיד אחרי תשלום. האתר בודק את החתימה, מאמת מחדש דרך תרחיש 2, ומזכה פעם אחת.

**שינוי נדרש בתרחיש 1 הקיים (שדה אחד):** במודול ה-HTTP, ב-Fields, להוסיף שדה:
- Key: `notifyUrl` · Value: `notifyUrl` מהמודול הראשון (`{{1.notifyUrl}}`) · Field type: text

אם ה-Webhook של תרחיש 1 נוצר עם מבנה נתונים קבוע (Data structure), יש להוסיף לו גם את השדה `notifyUrl`
(או ללחוץ **Redetermine data structure** ולבצע רכישת ניסיון אחת).

## תרחיש 3 (אופציונלי): approveTransaction

`3-grow-approve-transaction.blueprint.json`. לפי Grow: האישור לא משנה את סטטוס העסקה, ובלעדיו Grow שולח את ההתראה
שוב עד 5 פעמים ועשוי לפנות לעסק. האתר שולח לתרחיש את נתוני ההתראה כפי שהתקבלו (+`reference`), והתרחיש קורא
ל-`approveTransaction` עם ה-pageCode. ייבוא כמו בתרחישים 1-2 (מפתח API חדש), ואז באתר:

```
MAKE_APPROVE_WEBHOOK_URL=<כתובת ה-webhook של תרחיש 3>
MAKE_APPROVE_API_KEY=<המפתח של תרחיש 3>
```

בלי המשתנים האלה האתר פשוט מדלג על האישור. הפעלת החבילה לא תלויה בו.
