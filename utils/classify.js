const BUSINESS_KEYWORDS = [
  'מע"מ', 'מעמ', 'מס הכנסה', 'ביטוח לאומי', 'חשבונית', 'עוסק מורשה',
  'שכר עובד', 'מקדמת מס', 'ניכוי מס', 'עמלת קנ', 'המרת קנ',
  'מקס איט פיננ', 'ל.מאסטרקרד', 'הו"ק לחיסכון',
];

const HOME_KEYWORDS = [
  'ארנונה', 'חשמל', 'חברת חשמל', 'מים', 'תאגיד מים', 'גז', 'שכר דירה',
  'משכנתא', 'ועד בית', 'סופר', 'סופרמרקט', 'שופרסל', 'רמי לוי', 'ויקטורי',
  'מכולת', 'קופת חולים', 'בית ספר', 'גן ילדים', 'צהרון', 'עירייה',
  'משרד הפנים', 'משרד התחבורה', 'ביטוח בריאות', 'ביטוח דירה', 'ביטוח רכב',
  'דלק', 'פנגו', 'חניה',
];

function classifyText(text) {
  if (!text) return '';
  const lower = text.toLowerCase();
  if (BUSINESS_KEYWORDS.some((k) => lower.includes(k.toLowerCase()))) return 'עסק';
  if (HOME_KEYWORDS.some((k) => lower.includes(k.toLowerCase()))) return 'בית';
  return '';
}

function classifyTransaction({ category, note, subject }) {
  return (
    classifyText(category) ||
    classifyText(note) ||
    classifyText(subject) ||
    ''
  );
}

module.exports = { classifyText, classifyTransaction };
