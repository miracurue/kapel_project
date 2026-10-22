'use strict';

/**
 * Локальное маскирование персональных данных (REQ-AID-007/018). Только регулярные выражения и словарь
 * имён: без сети и без моделей. ЭТО ЭВРИСТИКА: маскирование не гарантирует полного обезличивания —
 * об этом говорит интерфейс. Паттерны — review-required (владелец/юрист), не сертифицированы.
 *
 * detect(text) -> [{id, type, label, start, end, value}] без пересечений, по возрастанию start.
 * apply(text, matches, keepIds) -> текст, где найденное заменено метками, кроме id из keepIds.
 */

const LABELS = {
  fio: '[ФИО]',
  phone: '[ТЕЛЕФОН]',
  email: '[EMAIL]',
  snils: '[СНИЛС]',
  passport: '[ПАСПОРТ]',
  polis: '[ПОЛИС]',
  address: '[АДРЕС]',
  dob: '[ДАТА РОЖДЕНИЯ]',
};

const TYPE_TITLES = {
  fio: 'ФИО', phone: 'Телефон', email: 'E-mail', snils: 'СНИЛС', passport: 'Паспорт', polis: 'Полис', address: 'Адрес', dob: 'Дата рождения',
};

// Частые русские имена: нужны, чтобы «Иван Петров» / «Петров Иван» ловились без отчества, не трогая обычные слова.
const NAMES = (
  'Александр Александра Алексей Алёна Алена Алина Алиса Алла Анастасия Анатолий Андрей Анна Антон Антонина Арина Аркадий Арсений Артём Артем Артур '
  + 'Борис Вадим Валентин Валентина Валерий Валерия Варвара Василий Василиса Вера Вероника Виктор Виктория Виталий Владимир Владислав Влада Всеволод Вячеслав '
  + 'Галина Геннадий Георгий Глеб Григорий Гриша Давид Даниил Данил Дарья Денис Дмитрий Евгений Евгения Егор Екатерина Елена Елизавета Ефим '
  + 'Жанна Зинаида Злата Иван Игнат Игорь Илья Инна Ирина Карина Кирилл Клавдия Константин Кристина Ксения Лариса Лев Леонид Лидия Лилия Любовь Людмила '
  + 'Магомед Майя Макар Максим Маргарита Марина Мария Марк Матвей Михаил Милана Надежда Наталья Наталия Никита Николай Нина Оксана Олег Олеся Ольга '
  + 'Павел Пётр Петр Полина Платон Раиса Регина Роберт Роман Ростислав Руслан Светлана Святослав Семён Семен Сергей Софья София Станислав Степан Стефания '
  + 'Таисия Тамара Татьяна Тимофей Тимур Ульяна Фёдор Федор Филипп Эдуард Элина Эльвира Юлия Юрий Яков Ярослав Яна'
).split(/\s+/);
const NAME_RE = `(?:${NAMES.join('|')})`;

const UP = 'А-ЯЁ';
const LO = 'а-яё';
const CAP = `[${UP}][${LO}]+(?:-[${UP}][${LO}]+)?`; // слово с заглавной буквы (с дефисом)
const PATR = `[${UP}][${LO}]+(?:ович|евич|ьич|ич|овна|евна|ична|инична|кызы|оглы)(?:а|у|ем|е|ом|ой|ны|не|ной)?`;
const SURNAME_END = `[${UP}][${LO}]*(?:ов|ев|ёв|ин|ын|ова|ева|ёва|ина|ына|ский|ская|ского|скому|ским|цкий|цкая|ой|ых|ко|ук|юк|енко|ян|дзе|ий|ая|ова|овой|овой|ову|овым|ова|ина|ину|иной|ым|им|ого|ому)`;

const RULES = [
  // длины ограничены (RFC 5321: локальная часть <=64, домен <=255): иначе длинная цифровая/точечная строка даёт квадратичный разбор (ReDoS)
  { type: 'email', re: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/g },
  // СНИЛС: 000-000-000 00 | 000 000 000 00 | «СНИЛС 00000000000»
  { type: 'snils', re: /(?<![\d-])\d{3}[- ]\d{3}[- ]\d{3}[- ]\d{2}(?![\d])/g },
  { type: 'snils', re: /СНИЛС[:\s№N]*\d{11}(?!\d)/gi },
  // Полис ОМС: 16 цифр (в т.ч. группами по 4) либо «полис ... номер»
  { type: 'polis', re: /(?<![\d-])\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{4}(?!\d)/g },
  { type: 'polis', re: /(?<!\d)\d{16}(?!\d)/g },
  { type: 'polis', re: /полис\w*(?:\s+(?:ОМС|ДМС))?[:\s№N]*[A-Za-zА-Яа-я]{0,4}[\s-]?\d[\d\s-]{5,19}\d/gi },
  { type: 'polis', re: /(?:ОМС|ДМС)[:\s№N]*\d[\d\s-]{7,19}\d/g },
  // Паспорт: «паспорт 45 12 123456», «серия 4512 номер 123456», либо формат 00 00 000000 / 0000 000000
  { type: 'passport', re: /паспорт\w*[^\d\n]{0,25}\d{2}\s?\d{2}[\s№N-]*\d{6}(?!\d)/gi },
  { type: 'passport', re: /сери[яи][:\s]*\d{2}\s?\d{2}[,;\s]*(?:номер|№|N)[:\s]*\d{6}(?!\d)/gi },
  { type: 'passport', re: /(?<![\d-])\d{2} \d{2} \d{6}(?!\d)/g },
  { type: 'passport', re: /(?<![\d-])\d{4} \d{6}(?!\d)/g },
  // Телефоны
  { type: 'phone', re: /(?<![\d])(?:\+7|8|7)[\s\-]*\(?\d{3}\)?[\s\-]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}(?![\d])/g },
  { type: 'phone', re: /(?<![\d+])\(?9\d{2}\)?[\s\-]\d{3}[\s\-]\d{2}[\s\-]\d{2}(?![\d])/g },
  { type: 'phone', re: /(?<![\d.])\d{3}-\d{2}-\d{2}(?![\d])/g },
  // Дата рождения: с пояснением рядом
  { type: 'dob', re: /(?:дата\s+рождения|д\.\s?р\.|родил(?:ся|ась)|рожд\.?|г\.\s?р\.|дата\s+р\.)[:\s,-]*\d{1,2}[./]\d{1,2}[./]\d{2,4}(?:\s*г(?:ода|\.)?)?/gi },
  { type: 'dob', re: /\d{1,2}[./]\d{1,2}[./]\d{2,4}\s*(?:г(?:ода|\.)?\s*)?(?:г\.\s?р\.|рождения|\(р\.\))/gi },
  { type: 'dob', re: /\d{1,2}\s+(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+\d{4}\s*(?:года\s*)?(?:рождения|г\.\s?р\.)/gi },
  { type: 'dob', re: /\d{4}\s*(?:года|г\.)\s*рождения/gi },
  { type: 'dob', re: /(?:дата\s+рождения|родил(?:ся|ась))[:\s,-]*\d{1,2}\s+(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+\d{4}/gi },
  // Адреса
  { type: 'address', re: new RegExp(`(?:г\\.\\s?|город\\s+)${CAP},?\\s*(?:(?:ул\\.|улица|пр-т|пр\\.|проспект|пер\\.|переулок|б-р|бульвар|ш\\.|шоссе|наб\\.|набережная)\\s*[${UP}${LO}0-9 .\\-]+?,?\\s*)?(?:д\\.|дом)\\s*\\d+[${UP}${LO}]?(?:\\s*[,/]?\\s*(?:корп\\.|к\\.|стр\\.)\\s*\\d+)?(?:,?\\s*(?:кв\\.|квартира)\\s*\\d+)?`, 'g') },
  { type: 'address', re: new RegExp(`(?:ул\\.|улица|пр-т|пр\\.|проспект|пер\\.|переулок|б-р|бульвар|ш\\.|шоссе|наб\\.|набережная)\\s*[${UP}][${UP}${LO}0-9 .\\-]{1,40}?,?\\s*(?:д\\.|дом)\\s*\\d+[${UP}${LO}]?(?:\\s*[,/]?\\s*(?:корп\\.|к\\.|стр\\.)\\s*\\d+)?(?:,?\\s*(?:кв\\.|квартира)\\s*\\d+)?`, 'g') },
  { type: 'address', re: new RegExp(`(?:проживает|прописан[а]?|адрес[:\\s]+)[^\\n.]{0,10}(?:г\\.|город)\\s*${CAP}(?:,\\s*[^\\n.;]{3,60})?`, 'gi') },
  { type: 'address', re: /(?:кв\.|квартира)\s*\d+/gi },
  // ФИО: полное (с отчеством), инициалы, «Имя Фамилия» / «Фамилия Имя» по словарю имён
  { type: 'fio', re: new RegExp(`${CAP}\\s+${CAP}\\s+${PATR}`, 'g') },
  { type: 'fio', re: new RegExp(`${CAP}\\s+[${UP}]\\.\\s?[${UP}]\\.`, 'g') },
  { type: 'fio', re: new RegExp(`[${UP}]\\.\\s?[${UP}]\\.\\s?${CAP}`, 'g') },
  { type: 'fio', re: new RegExp(`${NAME_RE}\\s+${SURNAME_END}(?![${LO}])`, 'g') },
  { type: 'fio', re: new RegExp(`${SURNAME_END}(?![${LO}])\\s+${NAME_RE}(?![${LO}])`, 'g') },
  { type: 'fio', re: new RegExp(`(?:пациент(?:ка|а|у|ом|ке)?|больн(?:ой|ая|ого|ому))\\s+${CAP}(?!\\s+[${LO}])(?:\\s+[${UP}]\\.\\s?(?:[${UP}]\\.)?)?`, 'g'),
    skipLabel: true },
];

const PRIORITY = ['email', 'snils', 'polis', 'passport', 'phone', 'dob', 'address', 'fio'];

/** Найденные фрагменты без пересечений; при пересечении выигрывает более приоритетный тип, затем более длинный. */
function detect(text) {
  const src = String(text || '');
  const raw = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(src))) {
      if (m[0].length === 0) { rule.re.lastIndex++; continue; }
      let start = m.index;
      let value = m[0];
      if (rule.skipLabel) {
        // метка «пациент» остаётся, маскируется только имя
        const sub = value.slice(value.search(/\s/) + 1);
        start += value.length - sub.length;
        value = sub;
      }
      // «Имя Фамилия» ловит и шапки вроде «Анна Каренина» — это ожидаемо; обычные слова без заглавной не трогаем
      raw.push({ type: rule.type, start, end: start + value.length, value });
    }
  }
  raw.sort((a, b) => PRIORITY.indexOf(a.type) - PRIORITY.indexOf(b.type) || (b.end - b.start) - (a.end - a.start) || a.start - b.start);
  const taken = [];
  for (const r of raw) {
    if (!taken.some((t) => r.start < t.end && r.end > t.start)) taken.push(r);
  }
  taken.sort((a, b) => a.start - b.start);
  return taken.map((t, i) => ({ id: i, type: t.type, label: LABELS[t.type], title: TYPE_TITLES[t.type], start: t.start, end: t.end, value: t.value }));
}

/** Подставляет метки. keepIds — id замен, которые врач отключил (оставить как есть). */
function apply(text, matches, keepIds = []) {
  const keep = new Set((keepIds || []).map(Number));
  let out = '';
  let pos = 0;
  let count = 0;
  for (const m of matches) {
    out += text.slice(pos, m.start);
    if (keep.has(m.id)) out += text.slice(m.start, m.end);
    else { out += m.label; count++; }
    pos = m.end;
  }
  out += text.slice(pos);
  return { text: out, count };
}

/** Удобный путь «найти и заменить всё». */
function maskAll(text) {
  const matches = detect(text);
  const r = apply(String(text || ''), matches, []);
  return { text: r.text, count: r.count, matches };
}

/**
 * Сегменты для показа «до/после»: [{text, match?}], где у сегмента с match замена (match.id, label, kept).
 * limit — сколько символов исходного текста показать.
 */
function segments(text, matches, keepIds = [], limit = 20000) {
  const keep = new Set((keepIds || []).map(Number));
  const segs = [];
  let pos = 0;
  const cut = Math.min(text.length, limit);
  for (const m of matches) {
    if (m.start >= cut) break;
    if (m.start > pos) segs.push({ text: text.slice(pos, m.start) });
    segs.push({ text: text.slice(m.start, m.end), match: { id: m.id, label: m.label, title: m.title, kept: keep.has(m.id) } });
    pos = m.end;
  }
  if (pos < cut) segs.push({ text: text.slice(pos, cut) });
  return { segs, truncated: text.length > cut };
}

module.exports = { detect, apply, maskAll, segments, LABELS, TYPE_TITLES };
