# תרחישי Make לתשלום ב-Grow (Sandbox)

התרחישים שהאתר מדבר איתם כש-`PAYMENT_PROVIDER=make` (ראו `src/lib/payments/make-provider.ts`):

| קובץ | מה הוא עושה | משתנה סביבה באתר |
|---|---|---|
| `1-grow-create-payment-link.blueprint.json` | יוצר קישור תשלום ב-Grow ומחזיר אותו לאתר (ייצוא של התרחיש החי, מודול Grow) | `MAKE_PAYMENT_WEBHOOK_URL`, `MAKE_PAYMENT_API_KEY` |
| `2-grow-verify-payment.blueprint.json` | אימות, מבנה ישן: מחזיר עסקה אחת בלבד (הראשונה). נשמר כגיבוי לחזרה לאחור | `MAKE_VERIFY_WEBHOOK_URL`, `MAKE_VERIFY_API_KEY` |
| (ללא קובץ, הקמה ידנית: ראו "תרחיש 2 v2" למטה) | אימות, מבנה v2: מחזיר את כל העסקאות של הקישור כמערך JSON, והאתר בוחר את העסקה ששולמה | אותם משתנים (מחליף את תרחיש 2 בכתובת ובמפתח בלבד) |

**ניקוי לפני Git:** הקבצים נשמרים בלי מזהי Webhook, מזהי Connection ושמות חשבון. אין בהם מפתחות, טוקנים או כתובות
Webhook. אחרי ייבוא בוחרים Webhook ו-Connection מחדש. לפני הוספת ייצוא חדש לריפו: למחוק את `parameters.hook`,
`parameters.__IMTCONN__`, `metadata.restore.parameters` ו-`metadata.setupValidation`.

## ייבוא (לכל אחד משני הקבצים)

1. ב-Make: **Scenarios** ← **Create a new scenario**.
2. בסרגל התחתון לוחצים **⋯** ← **Import Blueprint** ← בוחרים את הקובץ ← **Save**.
3. לוחצים על המודול הראשון (Webhooks) ← **Add** ← נותנים שם (למשל `caps-create` / `caps-verify`).
   - פותחים **Show advanced settings** ← **API Keys** ← **Add** ← מדביקים מפתח אקראי של 24 תווים לפחות.
     את אותו מפתח שמים באתר ב-`MAKE_PAYMENT_API_KEY` (תרחיש 1) או `MAKE_VERIFY_API_KEY` (תרחיש 2).
   - **Save**, ואז **Copy address to clipboard** ← זו הכתובת ל-`MAKE_PAYMENT_WEBHOOK_URL` / `MAKE_VERIFY_WEBHOOK_URL`.
4. בכל מודול Grow (Create Payment Link / Get Payment Link Info) בוחרים ב-**Connection** את החיבור ל-Grow Sandbox.
   (תרחיש 3 עדיין מבוסס מודול HTTP: שם מחליפים את `PASTE_GROW_PAGE_CODE` ב-pageCode של Grow Sandbox)
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

**תרחיש 2** מקבל: `reference, processId, processToken` (מזהי קישור התשלום שנשמרו בשרת). מחזיר אחד משני מבנים, והאתר תומך בשניהם:

- **v2 (מומלץ)**: `{"format":"v2", "reference", "processId", "grow": {"transactions": [{"statusCode", "sum", "transactionId", "paymentLinkProcessId"}]}}`.
  כל עסקה היא אובייקט אחד, כך שהסכום והמזהה תמיד שייכים לאותה עסקה. `paymentLinkProcessId` הוא מזהה הקישור כפי ש-Grow
  מדווח בעסקה עצמה, והאתר דורש שיהיה זהה למזהה שנשמר בשרת ביצירת הקישור (חובה בעסקה ששולמה ובעסקת החזר). האתר בוחר את
  העסקה ששולמה, מזהה חיוב מרובה והחזר, ודוחה תשובה לא תקינה. רק ארבעת השדות האלה עוברים: בלי טוקנים, שם, טלפון או כרטיס.
- **legacy**: `{"reference", "processId", "currency", "statusCode", "sum", "transactionId"}` של עסקה אחת.

`reference` ו-`processId` הם הד של מה שהאתר שלח, ומוודאים שהתשובה שייכת לבקשה. הקשירה לנתון של Grow עצמו היא
`paymentLinkProcessId` בכל עסקה. ב-Grow אין שדה מטבע בתשובה; הקישור נוצר בשקלים, ושדה `currency` (אם נשלח) חייב להיות ILS.

`statusCode` (Grow parameter-mapping): 2 שולם, 0 לא שולם, 9 נדחה, 4 בוטל לפני שידור, 6 החזר. רק 2 נחשב תשלום. ניסיון
שנדחה או בוטל **אינו** סוגר את הרכישה: הקישור נשאר פתוח, והרכישה נשארת ממתינה עד שמגיעה עסקה ששולמה. החזר (6) חוסם
הפעלה אוטומטית גם כשיש בקישור עסקה ששולמה.

**חריגות:** תשלום על רכישה שבוטלה (לא מופעל), יותר מעסקה אחת ששולמה (מופעל פעם אחת) ועסקת החזר (לא מופעל; חבילה שכבר
הופעלה מסומנת לבדיקה) נשמרים בטבלה `PaymentAnomaly`, ונשלחת התראה במייל ל-`PAYMENT_ALERT_EMAIL` (או לתיבת המערכת).
התראה שלא נשלחה מנוסה שוב בכל זיהוי חוזר; ניסיון תקופתי שאינו תלוי ב-Grow מתוכנן במשימה B.

## תרחיש 2 v2: הקמה ב-Make (מודולים מובנים, בלי נוסחאות)

כל השדות נבחרים בלחיצה מחלון המיפוי, בלי הקלדת שמות פנימיים. התרחיש הקיים (Verify Payment) לא משתנה.

1. **Scenarios** ← **Create a new scenario** ← **⋯** ← **Import Blueprint** ← `2-grow-verify-payment.blueprint.json` ← **Save**.
   שם התרחיש: `Hakapsula | Grow Sandbox - Verify Payment v2`.
2. **Webhooks (1)**: **Add** ← `Hakapsula Staging - Verify Payment v2` ← **Show advanced settings** ← **API Keys** ← **Add**
   (מפתח חדש של 24 תווים לפחות) ← **Save** ← **Copy address to clipboard**.
3. **Grow - Get Payment Link Info (2)**: ב-**Connection** בוחרים את החיבור ל-Grow Sandbox. השדות נשארים כמו שהם.
4. בין מודול Grow למודול **Webhook response** מוסיפים, לפי הסדר:
   - **Flow Control > Iterator**. Array: מחלון המיפוי של מודול 2 ← `Payment link transactions[]`.
   - **Flow Control > Iterator**. Array: מחלון המיפוי של ה-Iterator הראשון ← `transactions[]`.
   - **Flow Control > Array aggregator** (ההגדרה בסעיף 6).
   - **JSON > Create JSON** (ההגדרה בסעיף 5).
5. **Create JSON**: Data structure ← **Add** ← שם `caps_verify_transactions` ← **Generator** ← מדביקים את הדוגמה ← **Save**:
   ```
   {"transactions":[{"statusCode":"2","sum":"300","transactionId":"1","paymentLinkProcessId":"1"}]}
   ```
6. **Array aggregator**: Source module ← ה-**Iterator הראשון** (זה על `Payment link transactions[]`), כדי שכל העסקאות של כל
   התהליכים יתאספו לפלט אחד. Target structure type ← השדה `transactions` של Create JSON. ממפים בלחיצה מה-Iterator השני:
   `statusCode` ← Status Code, `sum` ← Sum, `transactionId` ← Transaction ID, `paymentLinkProcessId` ← Payment Link Process ID.
   חוזרים ל-**Create JSON**: `transactions` ← `Array[]` מה-Array aggregator.
7. **Webhook response**: Status `200`, Custom header `Content-Type` = `application/json`. ב-Body משאירים את
   `{{1.reference}}` ו-`{{1.processId}}` כפי שהם, ומחליפים את כל השאר כך שהגוף יהיה:
   `{"format":"v2","reference":"{{1.reference}}","processId":"{{1.processId}}","grow":` + הפלט של Create JSON (בלחיצה) + `}`
8. **Save** ← מדליקים (**ON**, Immediately).

**בדיקת תקינות ב-History של v2 אחרי ריצה:** ל-Array aggregator ול-Webhook response יש פלט **אחד** בלבד, ובגוף התשובה
מופיע `"grow":{"transactions":[...]}` עם ארבעת השדות בלבד. אם השדה `paymentLinkProcessId` שונה ממזהה הקישור, האתר ידחה את
התשובה (התשלום יישאר ממתין, בלי שינוי מצב) וצריך לבדוק איזה שדה נבחר.

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

## מסלול Payment Process: תשלום בתוך האתר (תרחישים 4-5)

דף התשלום של Payment Link (grow.link) אוסר הטמעה באתר אחר (`frame-ancestors https://grow.website`), גם ב-Sandbox וגם
ב-Production. הדרך הרשמית להציג את טופס התשלום של Grow בתוך האתר היא **createPaymentProcess** (Light API). האתר מוכן
לכך: הלקוח לוחץ "רכישה" פעם אחת, החלונית נפתחת מיד, וטופס Grow נטען בתוכה. אחרי התשלום Grow מחזיר את ה-iframe לדף
החזרה שלנו, האתר מאמת מול Grow, מפעיל את החבילה, סוגר את החלונית ומציג אישור.

**תנאי מוקדם:** הרשאה מ-Grow ל-createPaymentProcess, ו-**userId + pageCode של Sandbox** (מתקבלים מ-Grow; שונים מ-Production).
התרחישים הפעילים 1-3 לא משתנים. 4-5 הם תרחישים חדשים ונפרדים, והמעבר אליהם וממנו נעשה במשתני סביבה בלבד.

### הקמה (Staging בלבד)

1. **Import Blueprint** ← `4-grow-create-payment-process.blueprint.json` ← **Save**.
   - Webhooks (1): **Add** ← `Hakapsula Staging - Create Payment Process` ← API Keys ← **Add** (מפתח חדש, 24+ תווים) ← Save ← Copy address.
   - HTTP (2): להחליף `PASTE_GROW_PAGE_CODE` ו-`PASTE_GROW_USER_ID` בערכי ה-Sandbox מ-Grow.
   - שמירה והדלקה (ON, Immediately).
2. **Import Blueprint** ← `5-grow-verify-payment-process.blueprint.json` ← **Save**.
   - Webhooks (1): **Add** ← `Hakapsula Staging - Verify Payment Process` ← מפתח API חדש ← Copy address.
   - HTTP (2): להחליף `PASTE_GROW_PAGE_CODE`.
   - שמירה והדלקה.
3. ב-Render (caps-staging) ← Environment:
   ```
   MAKE_PROCESS_WEBHOOK_URL=<כתובת תרחיש 4>
   MAKE_PROCESS_API_KEY=<המפתח של תרחיש 4>
   MAKE_PROCESS_VERIFY_WEBHOOK_URL=<כתובת תרחיש 5>
   MAKE_PROCESS_VERIFY_API_KEY=<המפתח של תרחיש 5>
   MAKE_PAYMENT_CHECKOUT_HOSTS=sandbox.grow.link,sandbox.meshulam.co.il
   MAKE_PAYMENT_FLOW=process
   ```
   הגדרה חלקית של `MAKE_PROCESS_*` חוסמת את ספק התשלום כולו (כשל סגור). חזרה למסלול הקישורים: `MAKE_PAYMENT_FLOW=link`
   (או למחוק אותו). תשלומים שנוצרו בכל מסלול ממשיכים להתאמת בתרחיש של המסלול שלהם, כל עוד ארבעת המשתנים מוגדרים.
4. Manual Deploy (או Save, rebuild and deploy) ורכישת Sandbox אחת.

### מה בודקים ברכישה הראשונה
- בלוג של Render: `purchase timing ... framing=headers_allow+probe` (דף התשלום התיר הטמעה) ו-`outcome=checkout`.
  אם מופיע `headers_forbid` - Grow אוסר הטמעה גם בדף הזה: החלונית תציע חלון נפרד, ויש לבקש מ-Grow אישור דומיין.
  אחרי שהטמעה עובדת אפשר להוסיף `CHECKOUT_EMBEDDABLE_HOSTS=sandbox.meshulam.co.il` כדי לדלג על הבדיקה.
- ב-Make History של תרחיש 5: התשובה מכילה `"flow":"process"` ו-`"grow":{...,"transactions":[...]}`. האתר קושר כל עסקה
  לתהליך לפי `processId` של העסקה, ואם אין - לפי `processId` שבתשובת Grow עצמה. שניהם חייבים להיות התהליך שנשמר בשרת.
  אם Grow לא מחזיר `processId` באף רמה, האימות נכשל בבטחה (התשלום נשאר ממתין, בלי זיכוי) - לשלוח צילום של התשובה.
- בלוג: `notify make-grow outcome=PROCESSED finalize=PACKAGE_ACTIVATED`.

### החוזה
- **תרחיש 4** מקבל את כל השדות של תרחיש 1, ובנוסף `flow` (`"process"`) ו-`cancelUrl`. מחזיר `{"url","processId","processToken"}`;
  כשל ← HTTP 502.
- **תרחיש 5** מקבל `reference, processId, processToken`. מחזיר `{"format":"v2","flow":"process","reference","processId","grow":<data של Grow>}`.
  האתר דוחה תשובה בלי `"flow":"process"`, מבנה legacy, ותהליך או עסקה של תהליך אחר.

התראת השרת (notifyUrl), approveTransaction (תרחיש 3, שעדיין לא נבדק בפועל), השוואת הסכום, שיוך כל עסקה לרכישה אחת
וזיכוי חד-פעמי זהים בשני המסלולים.

**פרטיות:** תרחיש 5 מעביר לאתר את data של Grow כפי שהוא (ייתכנו בו שם המשלם וארבע ספרות אחרונות). האתר קורא רק
statusCode, sum, transactionId ו-processId, לא שומר את התשובה ולא רושם אותה בלוג.
