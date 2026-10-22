'use strict';
(() => {
  const NS = 'http://www.w3.org/2000/svg';
  const KEY = 'clinical-compass-plant-prototype-v1';
  const events = [];
  const leafStates = [];
  const flowerStates = [];
  const byId = (id) => document.getElementById(id);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const node = (tag, attrs, parent) => {
    const el = document.createElementNS(NS, tag);
    Object.entries(attrs).forEach(([key, value]) => el.setAttribute(key, value));
    parent.appendChild(el);
    return el;
  };
  const stem = (d, width) => node('path', { d, class: 'stem', pathLength: 1, 'stroke-width': width }, byId('stems'));
  // Fixed geometry: the same growth state always produces the same plant.
  stem('M320 508 Q319 498 322 488', 6).classList.add('grown');
  for (let branch = 0; branch < 12; branch += 1) {
    const side = branch % 2 === 0 ? -1 : 1;
    const baseY = 488 - branch * 27;
    const reach = 145 - Math.max(0, branch - 5) * 14;
    const rise = 50 + branch * 2;
    const trunkPath =
      branch === 11
        ? `M320 ${baseY + 2} Q313 158 320 125`
        : `M320 ${baseY + 2} Q${318 + side * 5} ${baseY - 14} 320 ${baseY - 27}`;
    const trunk = stem(trunkPath, 5.8 - branch * 0.25);
    events.push(() => trunk.classList.add('grown'));
    const twig = stem(
      `M320 ${baseY} Q${320 + side * reach * 0.55} ${baseY - 6} ${320 + side * reach} ${baseY - rise}`,
      3.1 - branch * 0.08,
    );
    events.push(() => twig.classList.add('grown'));
    const leaves = [];
    for (let pair = 0; pair < 5; pair += 1) {
      const t = 0.22 + pair * 0.16;
      const x = 320 + side * reach * (1.1 * t - 0.1 * t * t);
      const y = baseY - 12 * (1 - t) * t - rise * t * t;
      for (let edge = 0; edge < 2; edge += 1) {
        // The last shoot ends in a leafy crown rather than an exposed stem.
        const apical = branch === 11 && pair === 0;
        const angle = apical
          ? edge === 0
            ? -125
            : -53
          : side === 1
            ? edge === 0
              ? -68
              : 22
            : edge === 0
              ? -112
              : -202;
        const wrap = node(
          'g',
          {
            transform: `translate(${apical ? 318 : x} ${apical ? 151 + edge * 7 : y}) rotate(${angle - pair * side * 3})`,
          },
          byId('leaves'),
        );
        const flutter = node('g', { class: 'leaf-sway' }, wrap);
        flutter.style.animationDelay = `${-((branch * 10 + pair * 2 + edge) * 0.37).toFixed(2)}s`;
        flutter.style.animationDuration = `${2.6 + ((branch + pair + edge) % 4) * 0.35}s`;
        const body = node('g', { class: 'leaf-body' }, flutter);
        const size = 26 + ((branch * 7 + pair * 3 + edge * 5) % 13);
        node(
          'path',
          {
            d: `M0 0 C${size * 0.15} ${-size * 0.55} ${size * 0.77} ${-size * 0.57} ${size} 0 C${size * 0.64} ${size * 0.36} ${size * 0.18} ${size * 0.36} 0 0Z`,
            fill: 'url(#leaf)',
          },
          body,
        );
        node('path', { d: `M1 0 Q${size * 0.5} -3 ${size * 0.9} 0`, class: 'leaf-vein' }, body);
        const state = { body, stage: 0 };
        leaves.push(state);
        leafStates.push(state);
      }
    }
    for (let stage = 1; stage <= 3; stage += 1) {
      leaves.forEach((leaf) =>
        events.push(() => {
          leaf.stage = stage;
          leaf.body.style.transform = `scale(${[0, 0.32, 0.65, 1][stage]})`;
        }),
      );
    }
    // Flowers unlock after the plant has already developed five leafy branches.
    if (branch >= 5) {
      const count = branch >= 7 ? 2 : 1;
      for (let f = 0; f < count; f += 1) {
        const terminal = branch === 11 && f === 1;
        const x = terminal ? 320 : 320 + side * (reach - f * 26);
        const y = terminal ? 125 : baseY - rise - 7 - f * 9;
        const pedicel = stem(`M${terminal ? 318 : x - side * 7} ${y + 14} Q${x} ${y + 5} ${x} ${y}`, 1.8);
        const wrap = node('g', { transform: `translate(${x} ${y}) rotate(${branch * 13})` }, byId('flowers'));
        const nod = node('g', { class: 'flower-sway' }, wrap);
        nod.style.animationDelay = `${-(branch * 0.9 + f * 0.5).toFixed(2)}s`;
        const body = node('g', { class: 'flower-body' }, nod);
        for (let p = 0; p < 5; p += 1)
          node('ellipse', { cx: 0, cy: -9, rx: 7, ry: 11, transform: `rotate(${p * 72})`, fill: 'url(#petal)' }, body);
        node('circle', { r: 5, fill: '#d8ac52' }, body);
        node('circle', { cx: -1, cy: -1, r: 2, fill: '#f6dda0' }, body);
        const flower = { body, stage: 0 };
        flowerStates.push(flower);
        for (let stage = 1; stage <= 3; stage += 1)
          events.push(() => {
            pedicel.classList.add('grown');
            flower.stage = stage;
            body.style.transform = `scale(${[0, 0.18, 0.48, 1][stage]})`;
          });
      }
    }
  }
  const MAX_WATER = events.length * 5;
  let spent = 0;
  let shown = 0;
  let timer;
  let storageAvailable = true;
  try {
    const saved = Number(localStorage.getItem(KEY));
    if (Number.isFinite(saved) && saved >= 0) spent = Math.min(MAX_WATER, Math.floor(saved));
  } catch {
    storageAvailable = false;
  }
  const save = () => {
    try {
      localStorage.setItem(KEY, String(spent));
    } catch {
      storageAvailable = false;
    }
    if (!storageAvailable)
      byId('save-note').textContent = 'Хранилище недоступно: прогресс сохранится только до закрытия страницы.';
  };
  const update = () => {
    const progress = Math.floor((spent / MAX_WATER) * 100);
    const blooming = flowerStates.some((flower) => flower.stage > 0);
    byId('leaf-count').textContent = leafStates.filter((leaf) => leaf.stage > 0).length;
    byId('flower-count').textContent = flowerStates.filter((flower) => flower.stage === 3).length;
    byId('water-count').textContent = spent.toLocaleString('ru-RU');
    byId('percent').textContent = `${progress}%`;
    byId('growth-progress').value = progress;
    byId('stage-name').textContent =
      spent === MAX_WATER
        ? 'Ваш цветущий сад'
        : blooming
          ? 'Время расцветать'
          : progress >= 15
            ? 'Всё больше жизни'
            : 'Первый росток';
    byId('stage-description').textContent =
      spent === MAX_WATER
        ? 'Все 120 листьев выросли, все 12 цветов раскрылись. Можно начать новую историю.'
        : blooming
          ? 'Первые цветы уже здесь. Впереди ещё новые листья, ветви и бутоны.'
          : progress >= 15
            ? 'Куст обрастает листвой. Каждая порция воды помогает ему стать пышнее.'
            : 'Добавьте немного воды — и появятся первые листья.';
    byId('scene-caption').textContent =
      spent === MAX_WATER
        ? 'Сколько маленьких действий — и столько красоты'
        : blooming
          ? 'Каждый цветок — продолжение вашей заботы'
          : 'У каждого большого сада есть маленькое начало';
    byId('water-label').textContent = spent === MAX_WATER ? 'Растение полностью выросло' : 'Полить растение';
  };
  const advance = () => {
    const target = Math.floor(spent / 5);
    if (shown < target) {
      events[shown++]();
      update();
    }
    if (shown < target) timer = window.setTimeout(advance, Math.min(95, 1100 / Math.max(1, target - shown)));
    else {
      byId('water').disabled = spent === MAX_WATER;
      update();
    }
  };
  while (shown < Math.floor(spent / 5)) events[shown++]();
  update();
  byId('water').disabled = spent === MAX_WATER;
  if (!storageAvailable) save();
  byId('water').addEventListener('click', () => {
    const amount = Math.min(Number(byId('dose').value), MAX_WATER - spent);
    if (amount <= 0) return;
    spent += amount;
    save();
    byId('water').disabled = true;
    byId('feedback').textContent =
      `Добавлено ${amount} капель. ${spent === MAX_WATER ? 'Растение достигло полного роста!' : 'Новые шаги роста уже появляются.'}`;
    const rain = byId('rain');
    rain.classList.remove('pouring');
    void rain.getBoundingClientRect();
    rain.classList.add('pouring');
    if (reducedMotion.matches) while (shown < Math.floor(spent / 5)) events[shown++]();
    advance();
  });
  byId('reset').addEventListener('click', () => {
    window.clearTimeout(timer);
    spent = 0;
    shown = 0;
    document.querySelectorAll('.stem').forEach((el, i) => el.classList.toggle('grown', i === 0));
    [...leafStates, ...flowerStates].forEach((state) => {
      state.stage = 0;
      state.body.style.transform = 'scale(0)';
    });
    byId('rain').classList.remove('pouring');
    byId('water').disabled = false;
    byId('feedback').textContent = 'Новая история началась. Подарите ростку немного воды.';
    save();
    update();
  });
})();
