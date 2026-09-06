# פנקס עסקי - שרת

שרת שמחזיק את התנועות שלך במסד נתונים אמיתי, ומסתנכרן אוטומטית מול Gmail
כדי לשלוף קבלות וחשבוניות.

## מבנה הפרויקט
```
server.js           - נקודת הכניסה, מפעיל את השרת ואת המשימה המתוזמנת
routes/transactions.js - API להוספה/קריאה/מחיקה של תנועות
routes/gmail.js      - התחברות ל-Gmail ומשיכת קבלות
db/schema.sql        - מבנה הטבלאות
db/migrate.js        - סקריפט שמריץ את schema.sql על המסד שלך
.env.example         - רשימת המשתנים הסביבתיים הדרושים
```

## שלב 1: הרשמה ל-Railway
1. גלוש ל-https://railway.app והתחבר עם GitHub.
2. צור פרויקט חדש (New Project).

## שלב 2: הוספת מסד נתונים
1. בתוך הפרויקט, לחץ "New" > "Database" > "Add PostgreSQL".
2. Railway יוצר את המסד ומגדיר אוטומטית משתנה בשם `DATABASE_URL` -- אין
   צורך להעתיק סיסמאות בעצמך.

## שלב 3: העלאת הקוד
1. צור repository חדש וריק ב-GitHub (למשל בשם `finance-app`).
2. העלה אליו את כל הקבצים שבתיקייה הזו.
3. ב-Railway: "New" > "GitHub Repo" ובחר את ה-repository שיצרת.
4. Railway יזהה שזה פרויקט Node.js ויתקין את התלויות אוטומטית.

## שלב 4: הרצת המיגרציה (יצירת הטבלאות)
1. ב-Railway, לחץ על שירות השרת שלך > טאב "Variables" -- ודא ש-`DATABASE_URL`
   מופיע שם (הוא אמור להיות מקושר אוטומטית מהמסד שיצרת).
2. פתח את ה-Shell המובנה של Railway (או הרץ מקומית עם המשתנה הזה מוגדר):
   ```
   npm install
   npm run migrate
   ```
   זה יוצר את הטבלאות `transactions` ו-`oauth_tokens`.

## שלב 5: חיבור Gmail
1. גלוש ל-https://console.cloud.google.com, צור פרויקט חדש.
2. הפעל את "Gmail API" (APIs & Services > Library).
3. הגדר מסך הרשאה (OAuth consent screen) -- בחר "External", הוסף את עצמך
   כ-test user.
4. צור פרטי גישה: Credentials > Create Credentials > OAuth client ID >
   Web application.
   - תחת "Authorized redirect URIs" הוסף:
     `https://<your-railway-domain>/api/gmail/callback`
5. תעתיק את ה-Client ID וה-Client Secret, ותוסיף אותם כמשתני סביבה
   ב-Railway (טאב Variables):
   ```
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   GOOGLE_REDIRECT_URI=https://<your-railway-domain>/api/gmail/callback
   ```
6. גלוש בדפדפן ל-`https://<your-railway-domain>/api/gmail/auth`, אשר גישה
   עם חשבון הגוגל שלך. זה שומר טוקן בטוח במסד הנתונים כדי שהשרת יוכל
   להמשיך למשוך קבלות גם בלעדיך.

## שלב 6: בדיקה
- `GET https://<your-railway-domain>/api/transactions` -- אמור להחזיר
  רשימה ריקה (`[]`) בהתחלה.
- `POST https://<your-railway-domain>/api/gmail/sync` עם גוף `{"days": 30}`
  -- מריץ סנכרון מייל ידני ומחזיר כמה קבלות נמצאו ונוספו.
- אחרי זה, המשימה המתוזמנת (`server.js`) תריץ סנכרון אוטומטי כל יום
  ב-06:00 בלי שתצטרך לגעת בכלום.

## מה עדיין חסר (השלב הבא)
- חיבור בפועל לבנק (עדיין לא בקוד הזה -- זה השלב שאחרי).
- עדכון הפנקס (ה-HTML) כדי שיקרא מה-API הזה במקום מ-`window.storage`
  המקומי -- כרגע הם לא מחוברים זה לזה.

## חשוב לזכור
- הטוקן של Gmail נשמר במסד הנתונים שלך -- הוא לא חשוף לאף אחד חוץ ממך,
  אבל אל תשתף את ה-`DATABASE_URL` או את משתני הסביבה עם אף אחד.
- זהו שרת אישי לשימוש שלך בלבד (משתמש יחיד) -- אין בו הרשאות/כניסת
  משתמשים, כי אמרת שזה לצורך אישי כרגע.
