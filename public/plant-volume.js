'use strict';
(() => {
  const NS = 'http://www.w3.org/2000/svg';
  const KEY = 'clinical-compass-plant-prototype-volume-v1';
  const events = [];
  const leafStates = [];
  const flowerStates = [];
  const objects = [];
  const stemStates = [];
  const byId = (id) => document.getElementById(id);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let yaw = 20;
  const node = (tag, attrs, parent) => {
    const el = document.createElementNS(NS, tag);
    Object.entries(attrs).forEach(([key, value]) => el.setAttribute(key, value));
    parent.appendChild(el);
    return el;
  };
  const add = (a, b) => a.map((v, i) => v + b[i]);
  const mul = (a, s) => a.map((v) => v * s);
  const mix = (a, b, t) => add(mul(a, 1 - t), mul(b, t));
  // x/y/z positions are projected into SVG; each object is sorted by camera depth.
  const project = ([x, y, z]) => {
    const angle = (yaw * Math.PI) / 180;
    const horizontal = x * Math.cos(angle) + z * Math.sin(angle);
    const depth = z * Math.cos(angle) - x * Math.sin(angle);
    const scale = 850 / (850 - depth);
    return { x: 320 + horizontal * scale, y: 506 + (170 - y + depth * 0.27) * scale - 170, depth, scale };
  };
  const coord = (p) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
  const scene = byId('scene');
  const object = (kind, position, attrs = {}) => {
    const el = node('g', { 'data-kind': kind, ...attrs }, scene);
    const item = { kind, position, el, stage: 0 };
    objects.push(item);
    return item;
  };
  const stem = (a, control, b, width, initial = false) => {
    const item = object('stem', mix(a, b, 0.5));
    Object.assign(item, { a, control, b, width, stage: initial ? 1 : 0, initial });
    item.path = node('path', { class: `stem${initial ? ' grown' : ''}`, pathLength: 1 }, item.el);
    item.highlight = node('path', { fill: 'none', 'stroke-linecap': 'round', opacity: 0.3 }, item.el);
    stemStates.push(item);
    return item;
  };
  const leaf = (position, azimuth, size, variation) => {
    const item = object('leaf', position);
    const elevation = 0.48 + variation * 0.025;
    const direction = [Math.cos(azimuth) * 0.88, elevation, Math.sin(azimuth) * 0.88];
    const across = [-Math.sin(azimuth) * 0.7, 0.65, Math.cos(azimuth) * 0.7];
    Object.assign(item, { direction, across, size });
    item.body = node('g', { class: 'volume-leaf' }, item.el);
    item.left = node('path', { fill: 'url(#leaf-lit)' }, item.body);
    item.right = node('path', { fill: 'url(#leaf-shade)' }, item.body);
    item.vein = node('path', { class: 'volume-vein' }, item.body);
    leafStates.push(item);
    return item;
  };
  const flower = (position, azimuth) => {
    const item = object('flower', position);
    item.body = node('g', { class: 'volume-flower' }, item.el);
    item.face = node('g', {}, item.body);
    item.azimuth = azimuth;
    for (let p = 0; p < 5; p += 1) {
      node(
        'ellipse',
        { cx: 0, cy: -10, rx: 7.8, ry: 12, transform: `rotate(${p * 72})`, fill: 'url(#volume-petal)' },
        item.face,
      );
      node(
        'path',
        {
          d: 'M0 -3 Q-2 -10 0 -18',
          transform: `rotate(${p * 72})`,
          fill: 'none',
          stroke: '#fff2d9',
          'stroke-width': 0.7,
          opacity: 0.6,
        },
        item.face,
      );
    }
    node('circle', { r: 5.5, fill: '#b98a3a' }, item.face);
    node('circle', { cx: -1, cy: -1, r: 4, fill: '#e7bf61' }, item.face);
    for (let i = 0; i < 7; i += 1)
      node('circle', { cx: Math.cos(i * 2.4) * 3, cy: Math.sin(i * 2.4) * 3, r: 0.7, fill: '#fff0ba' }, item.face);
    flowerStates.push(item);
    return item;
  };
  stem([0, 0, 0], [-2, 12, 0], [0, 20, 0], 7, true);
  for (let branch = 0; branch < 12; branch += 1) {
    const height = 20 + branch * 27;
    // A spiral around the trunk alternates foreground and background shoots.
    const azimuth = ((branch * 137.508 + 25) * Math.PI) / 180;
    const length = 158 - Math.max(0, branch - 4) * 12;
    const base = [0, height, 0];
    const tip = [Math.cos(azimuth) * length, height + 49 + branch, Math.sin(azimuth) * length];
    const control = [tip[0] * 0.6, height + 5, tip[2] * 0.6];
    const trunk = stem(
      [0, height - 1, 0],
      [-3, height + 13, 0],
      [0, branch === 11 ? 383 : height + 27, 0],
      5.8 - branch * 0.25,
    );
    events.push(() => {
      trunk.stage = 1;
    });
    const twig = stem(base, control, tip, 3.1 - branch * 0.08);
    events.push(() => {
      twig.stage = 1;
    });
    const branchLeaves = [];
    for (let pair = 0; pair < 5; pair += 1) {
      const t = 0.22 + pair * 0.16;
      const attachment = add(add(mul(base, (1 - t) ** 2), mul(control, 2 * (1 - t) * t)), mul(tip, t * t));
      for (let edge = 0; edge < 2; edge += 1) {
        const apical = branch === 11 && pair === 0;
        const pos = apical ? [0, 350 + edge * 9, 0] : attachment;
        branchLeaves.push(
          leaf(
            pos,
            apical ? edge * Math.PI + 0.6 : azimuth + (edge ? 1 : -1) * 1.02,
            33 + ((branch * 7 + pair * 3 + edge * 5) % 12),
            pair,
          ),
        );
      }
    }
    for (let stage = 1; stage <= 3; stage += 1)
      branchLeaves.forEach((item) =>
        events.push(() => {
          item.stage = stage;
        }),
      );
    if (branch >= 5) {
      for (let f = 0; f < (branch >= 7 ? 2 : 1); f += 1) {
        const terminal = branch === 11 && f === 1;
        const pos = terminal ? [0, 386, 0] : add(mul(tip, 1 - f * 0.16), [0, 12 + f * height * 0.16, 0]);
        const pedicel = stem(
          terminal ? [0, 370, 0] : mix(control, tip, f ? 0.63 : 0.94),
          add(pos, [0, -6, 0]),
          pos,
          1.6,
        );
        const bloom = flower(pos, azimuth + f * 0.5);
        for (let stage = 1; stage <= 3; stage += 1)
          events.push(() => {
            pedicel.stage = 1;
            bloom.stage = stage;
          });
      }
    }
  }
  const render = () => {
    const sorted = objects.map((item) => ({ item, p: project(item.position) })).sort((a, b) => a.p.depth - b.p.depth);
    sorted.forEach(({ item, p }) => {
      scene.appendChild(item.el);
      item.el.dataset.depth = p.depth.toFixed(1);
      if (item.kind === 'stem') {
        const a = project(item.a),
          c = project(item.control),
          b = project(item.b);
        const d = `M${coord(a)} Q${coord(c)} ${coord(b)}`;
        item.path.setAttribute('d', d);
        item.path.setAttribute('stroke-width', item.width * p.scale);
        item.path.style.stroke = p.depth < -25 ? '#849678' : '#4d7041';
        item.path.classList.toggle('grown', item.stage > 0);
        item.highlight.setAttribute('d', d);
        item.highlight.setAttribute('stroke', '#c5d39a');
        item.highlight.setAttribute('stroke-width', Math.max(0.6, item.width * 0.22));
        item.highlight.setAttribute('visibility', item.stage ? 'visible' : 'hidden');
        return;
      }
      item.el.setAttribute('transform', `translate(${p.x} ${p.y})`);
      item.el.setAttribute('opacity', p.depth < -30 ? 0.8 : 1);
      item.body.style.transform = `scale(${[0, 0.25, 0.62, 1][item.stage]})`;
      if (item.kind === 'leaf') {
        const end = project(add(item.position, mul(item.direction, item.size)));
        const span = Math.max(1, Math.hypot(end.x - p.x, end.y - p.y));
        const normal = [-(end.y - p.y) / span, (end.x - p.x) / span];
        const point = (along, across, lift = 0) => {
          const v = project(
            add(add(add(item.position, mul(item.direction, along * item.size)), mul(item.across, across * item.size)), [
              0,
              lift,
              0,
            ]),
          );
          // A gently curled blade keeps some visible surface when viewed edge-on.
          const curl = across * item.size * 0.65 * p.scale;
          return `${(v.x - p.x + normal[0] * curl).toFixed(2)} ${(v.y - p.y + normal[1] * curl).toFixed(2)}`;
        };
        const tip = point(1, 0);
        const middle = point(0.5, 0, 3);
        item.left.setAttribute('d', `M0 0 C${point(0.12, -0.33)} ${point(0.75, -0.41)} ${tip} Q${middle} 0 0Z`);
        item.right.setAttribute('d', `M0 0 Q${middle} ${tip} C${point(0.74, 0.34)} ${point(0.15, 0.3)} 0 0Z`);
        item.vein.setAttribute('d', `M0 0 Q${middle} ${tip}`);
        item.left.setAttribute('fill', p.depth < -25 ? 'url(#leaf-back-lit)' : 'url(#leaf-lit)');
        item.right.setAttribute('fill', p.depth < -25 ? 'url(#leaf-back-shade)' : 'url(#leaf-shade)');
      } else {
        const angle = item.azimuth + (yaw * Math.PI) / 180;
        item.face.setAttribute(
          'transform',
          `rotate(${Math.sin(angle) * 22}) scale(${p.scale} ${p.scale * (0.64 + 0.3 * Math.abs(Math.sin(angle)))})`,
        );
      }
    });
  };
  byId('view-angle').addEventListener('input', (event) => {
    yaw = Number(event.target.value);
    byId('angle-value').textContent = `${yaw}°`;
    render();
  });
  let drag = null;
  byId('plant').addEventListener('pointerdown', (event) => {
    drag = { x: event.clientX, yaw };
    byId('plant').setPointerCapture(event.pointerId);
    byId('plant').classList.add('dragging');
  });
  byId('plant').addEventListener('pointermove', (event) => {
    if (!drag) return;
    yaw = Math.max(-90, Math.min(90, Math.round(drag.yaw + (event.clientX - drag.x) * 0.45)));
    byId('view-angle').value = yaw;
    byId('angle-value').textContent = `${yaw}°`;
    render();
  });
  const stopDrag = () => {
    drag = null;
    byId('plant').classList.remove('dragging');
  };
  byId('plant').addEventListener('pointerup', stopDrag);
  byId('plant').addEventListener('pointercancel', stopDrag);
  // Watering and persistence are attached below; geometry stays independent of progress.

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
    render();
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
    stemStates.forEach((item) => {
      item.stage = item.initial ? 1 : 0;
    });
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
