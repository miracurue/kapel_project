'use strict';
// Методики самопомощи: готовые интерактивные страницы (public/techniques/<slug>.html). Они сразу доступны всем
// пациентам без назначения, а специалисты видят их во вкладке «Методики», чтобы знать, что есть у пациента, и рекомендовать.
// Картинки — фото из public/journal-img (источники, как и у Журнала, требуют подтверждения перед публикацией).
// suits/caution — для ИИ-помощника пациента (src/ai/patientSelfTools.js): когда предлагать и что оговорить.
// Тексты карточек — демо-описания, review-required: формулировки «для чего» утверждает клинический владелец.
const esc = (s) =>
  String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const TECHNIQUES = [
  {
    slug: 'grounding-54321',
    suits: 'Острая тревога, паника, чувство «улетаю в мысли», сильное волнение прямо сейчас.',
    caution: 'Нет особых ограничений: не требует дыхательных задержек и физического напряжения.',
    image: '/journal-img/walk-forest.jpg',
    title: 'Заземление 5-4-3-2-1',
    purpose:
      'Когда накрывает тревога: вернуться из мыслей в «здесь и сейчас», опираясь на то, что видно, слышно и чувствуется.',
    when: 'Острая тревога',
    minutes: '5 мин',
    kind: 'Пошаговое упражнение',
    icon: 'eye',
    tone: 'jade',
  },
  {
    slug: 'breathing-box',
    suits: 'Нужно быстро успокоиться, сердцебиение, напряжение перед событием.',
    caution:
      'Если от задержек дыхания кружится голова или становится тревожнее, перейти на обычное спокойное дыхание; при болезнях сердца и лёгких — сначала спросить врача.',
    image: '/journal-img/pier.jpg',
    title: 'Дыхание по квадрату',
    purpose: 'Выровнять дыхание и успокоиться: вдох, пауза, выдох, пауза по четыре счёта, точка показывает ритм.',
    when: 'Быстро успокоиться',
    minutes: '2–5 мин',
    kind: 'Дыхательная практика',
    icon: 'flower-lotus',
    tone: 'water',
  },
  {
    slug: 'breathing-478',
    suits: 'Трудно уснуть из-за напряжения, вечерняя тревога, напряжение в течение дня.',
    caution:
      'Длинная задержка дыхания: при головокружении остановиться; при болезнях сердца и лёгких — сначала спросить врача. Не делать за рулём.',
    image: '/journal-img/stars.jpg',
    title: 'Дыхание «4-7-8»',
    purpose: 'Замедлить сердцебиение и снять напряжение перед сном: короткий вдох, долгая пауза, медленный выдох.',
    when: 'Перед сном и при напряжении',
    minutes: '2–3 мин',
    kind: 'Дыхательная практика',
    icon: 'moon',
    tone: 'lilac',
  },
  {
    slug: 'pmr',
    suits: 'Телесное напряжение: зажатые плечи, челюсть, трудно расслабиться вечером.',
    caution:
      'Не напрягать мышцы до боли; при травмах, болях в мышцах и суставах пропускать больное место или спросить врача.',
    image: '/journal-img/yoga.jpg',
    title: 'Мышечная релаксация',
    purpose: 'Научиться замечать и отпускать мышечное напряжение: семь групп мышц, сильно напрячь и расслабить.',
    when: 'Телесное напряжение',
    minutes: '2–10 мин',
    kind: 'Телесная практика',
    icon: 'heartbeat',
    tone: 'honey',
  },
  {
    slug: 'activation',
    suits: 'Нет сил что-то начать, подавленность, избегание дел; не для острой тревоги и паники.',
    caution: 'Не подходит как первая помощь при сильной панике: сначала дыхание или заземление.',
    image: '/journal-img/sunrise.jpg',
    title: 'Активация поведения',
    purpose:
      'Сдвинуть тревогу с места маленьким действием: список любимого, одно простое дело и договор с собой о времени.',
    when: 'Нет сил что-то начать',
    minutes: '10 мин',
    kind: 'Работа по шагам',
    icon: 'sparkle',
    tone: 'sage',
  },
];

const bySlug = (slug) => TECHNIQUES.find((x) => x.slug === slug) || null;

const icon = (name) =>
  `<svg class="i" aria-hidden="true" focusable="false"><use href="/icons.svg#i-${esc(name)}"/></svg>`;

// Капелька с цифрой: пустой элемент, flower.js (только у пациента) наполняет его числом или галочкой «сегодня уже получено».
const badge = (x) =>
  `<span class="drop-badge" data-flower-badge="technique" data-flower-key="technique:${esc(x.slug)}:{day}"></span>`;

function card(x) {
  return `<a class="tcard tcard--photo tone-${esc(x.tone)}" href="/methods/${esc(x.slug)}" data-technique="${esc(x.slug)}"><span class="tcard-pic"><img src="${esc(x.image)}" alt="" loading="lazy" decoding="async"><span class="tcard-ico">${icon(x.icon)}</span></span><span class="tcard-body"><span class="tcard-kind">${esc(x.kind)} · ${esc(x.minutes)}</span><h3>${esc(x.title)}</h3><p>${esc(x.purpose)}</p><span class="tcard-foot"><span class="tcard-when">${esc(x.when)}</span><span class="tcard-go">Открыть${icon('arrow-square-out')}</span>${badge(x)}</span></span></a>`;
}

// Раздел с карточками методик: одинаков у пациента и у специалиста; lead — пояснение под заголовком.
function section(lead, { compact = false } = {}) {
  const head = compact
    ? ''
    : `<div class="tech-head"><h2 id="techniques-title">Методики для самопомощи</h2><p>${esc(lead)}</p></div>`;
  return `<section class="tech-section" id="techniques" aria-label="Методики для самопомощи">${head}<div class="tech-grid tech-grid--photo">${TECHNIQUES.map(card).join('')}</div><p class="muted small">Это упражнения для самопомощи, а не лечение и не замена врача. Содержание — демо, требует проверки специалистом.</p></section>`;
}

// Страница одной методики: заголовок и само упражнение прямо на странице (public/techniques.js, без рамки).
// Капельки пациент получает, когда упражнение пройдено до конца: событие «technique:complete» ловит public/js/flower.js.
function page(x, back, patient = false) {
  const hint = patient
    ? `<p class="tech-reward-hint">${icon('sparkle')}Пройдите упражнение до конца, и цветок получит капельки.${badge(x)}</p>`
    : '';
  return `<section class="tech-page"><p class="pt-back"><a class="btn sm" href="${esc(back)}">${icon('arrow-left')}К методикам</a></p><h1>${esc(x.title)}</h1><p class="sub">${esc(x.purpose)}</p>${hint}<div class="tech-app" data-technique-app="${esc(x.slug)}"><noscript><p class="muted">Для упражнения нужен включённый JavaScript.</p></noscript></div></section>`;
}

module.exports = { TECHNIQUES, bySlug, section, page, card, esc };
