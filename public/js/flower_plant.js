'use strict';
// Рисунок цветка по числу шагов роста. Геометрия фиксирована (как в прототипе plant-demo): одно и то же число шагов
// всегда даёт одно и то же растение. Цвета и движение задаются в flower.css, inline-стилей в разметке нет (CSP).
(() => {
  const NS = 'http://www.w3.org/2000/svg';
  const reduced = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let counter = 0;

  function node(tag, attrs, parent) {
    const el = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
    parent.appendChild(el);
    return el;
  }

  function mount(container, label) {
    const id = `fl${(counter += 1)}`;
    const svg = node(
      'svg',
      { viewBox: '0 0 640 650', class: 'fl-plant', role: 'img', 'aria-label': label || '' },
      container,
    );
    const defs = node('defs', {}, svg);
    const leafGrad = node('linearGradient', { id: `${id}-leaf`, x1: 0, y1: 1, x2: 1, y2: 0 }, defs);
    node('stop', { offset: 0, class: 'fl-leaf-a' }, leafGrad);
    node('stop', { offset: 1, class: 'fl-leaf-b' }, leafGrad);
    for (const color of ['pink', 'lilac']) {
      const petalGrad = node('linearGradient', { id: `${id}-petal-${color}`, x2: 0, y2: 1 }, defs);
      node('stop', { offset: 0, class: `fl-petal-${color}-a` }, petalGrad);
      node('stop', { offset: 1, class: `fl-petal-${color}-b` }, petalGrad);
    }
    node('circle', { cx: 320, cy: 310, r: 245, class: 'fl-halo' }, svg);
    node('ellipse', { cx: 320, cy: 550, rx: 150, ry: 24, class: 'fl-shadow' }, svg);
    node('ellipse', { cx: 320, cy: 520, rx: 134, ry: 37, class: 'fl-water' }, svg);
    const ripple = node('ellipse', { cx: 320, cy: 520, rx: 118, ry: 27, class: 'fl-ripple' }, svg);
    for (const [cx, cy, rx, ry] of [
      [193, 515, 28, 15],
      [229, 548, 35, 18],
      [292, 559, 34, 17],
      [361, 556, 33, 17],
      [416, 540, 32, 18],
      [449, 514, 25, 15],
      [407, 491, 30, 13],
      [239, 490, 31, 13],
    ]) {
      node('ellipse', { cx, cy, rx, ry, class: 'fl-pebble' }, svg);
      node('ellipse', { cx: cx - 5, cy: cy - 4, rx: rx * 0.45, ry: ry * 0.25, class: 'fl-pebble-light' }, svg);
    }
    // One shared wind transform keeps every stem, leaf and blossom connected (plant-demo).
    const canopy = node('g', { class: 'fl-canopy' }, svg);
    const stems = node('g', {}, canopy);
    const leavesG = node('g', {}, canopy);
    const flowersG = node('g', {}, canopy);
    const rain = node('g', { class: 'fl-rain', 'aria-hidden': 'true' }, svg);
    node('path', { d: 'M286 367 q-13 20 0 20 q13 0 0-20' }, rain);
    node('path', { d: 'M320 348 q-13 20 0 20 q13 0 0-20' }, rain);
    node('path', { d: 'M354 373 q-13 20 0 20 q13 0 0-20' }, rain);

    const events = [];
    const leafStates = [];
    const flowerStates = [];
    const stemEls = [];
    const stem = (d, width) => {
      const el = node('path', { d, class: 'fl-stem', pathLength: 1, 'stroke-width': width }, stems);
      stemEls.push(el);
      return el;
    };
    stem('M320 508 Q319 498 322 488', 6).classList.add('grown');
    for (let branch = 0; branch < 12; branch += 1) {
      const side = branch % 2 === 0 ? -1 : 1;
      const baseY = 488 - branch * 27;
      const reach = 145 - Math.max(0, branch - 5) * 14;
      const rise = 50 + branch * 2;
      const trunk = stem(
        branch === 11
          ? `M320 ${baseY + 2} Q313 158 320 125`
          : `M320 ${baseY + 2} Q${318 + side * 5} ${baseY - 14} 320 ${baseY - 27}`,
        5.8 - branch * 0.25,
      );
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
            leavesG,
          );
          const flutter = node('g', { class: 'fl-leaf-sway' }, wrap);
          flutter.style.animationDelay = `${-((branch * 10 + pair * 2 + edge) * 0.37).toFixed(2)}s`;
          flutter.style.animationDuration = `${2.6 + ((branch + pair + edge) % 4) * 0.35}s`;
          const body = node('g', { class: 'fl-leaf-body' }, flutter);
          const size = 26 + ((branch * 7 + pair * 3 + edge * 5) % 13);
          node(
            'path',
            {
              d: `M0 0 C${size * 0.15} ${-size * 0.55} ${size * 0.77} ${-size * 0.57} ${size} 0 C${size * 0.64} ${size * 0.36} ${size * 0.18} ${size * 0.36} 0 0Z`,
              fill: `url(#${id}-leaf)`,
            },
            body,
          );
          node('path', { d: `M1 0 Q${size * 0.5} -3 ${size * 0.9} 0`, class: 'fl-vein' }, body);
          const state = { body };
          leaves.push(state);
          leafStates.push(state);
        }
      }
      for (let stage = 1; stage <= 3; stage += 1)
        leaves.forEach((leaf) =>
          events.push(() => (leaf.body.style.transform = `scale(${[0, 0.32, 0.65, 1][stage]})`)),
        );
      // Цветы открываются, когда уже выросло пять ветвей с листьями.
      if (branch >= 5) {
        const count = branch >= 7 ? 2 : 1;
        for (let f = 0; f < count; f += 1) {
          const terminal = branch === 11 && f === 1;
          const x = terminal ? 320 : 320 + side * (reach - f * 26);
          const y = terminal ? 125 : baseY - rise - 7 - f * 9;
          const pedicel = stem(`M${terminal ? 318 : x - side * 7} ${y + 14} Q${x} ${y + 5} ${x} ${y}`, 1.8);
          const wrap = node('g', { transform: `translate(${x} ${y}) rotate(${branch * 13})` }, flowersG);
          const nod = node('g', { class: 'fl-flower-sway' }, wrap);
          nod.style.animationDelay = `${-(branch * 0.9 + f * 0.5).toFixed(2)}s`;
          const body = node('g', { class: 'fl-flower-body' }, nod);
          for (let p = 0; p < 5; p += 1)
            node(
              'ellipse',
              {
                cx: 0,
                cy: -9,
                rx: 7,
                ry: 11,
                transform: `rotate(${p * 72})`,
                fill: `url(#${id}-petal-${(branch + f) % 2 ? 'pink' : 'lilac'})`,
              },
              body,
            );
          node('circle', { r: 5, class: 'fl-core' }, body);
          node('circle', { cx: -1, cy: -1, r: 2, class: 'fl-core-hi' }, body);
          const flower = { body };
          flowerStates.push(flower);
          for (let stage = 1; stage <= 3; stage += 1)
            events.push(() => {
              pedicel.classList.add('grown');
              body.style.transform = `scale(${[0, 0.18, 0.48, 1][stage]})`;
            });
        }
      }
    }

    let shown = 0;
    let timer = 0;
    const apply = (to) => {
      if (to < shown) {
        stemEls.forEach((el, i) => el.classList.toggle('grown', i === 0));
        [...leafStates, ...flowerStates].forEach((s) => (s.body.style.transform = 'scale(0)'));
        shown = 0;
      }
      while (shown < to) events[shown++]();
    };
    return {
      max: events.length,
      svg,
      label: (text) => svg.setAttribute('aria-label', text),
      /** Показать нужное число шагов; animate — по шагу за раз, при reduced motion сразу. */
      set(steps, animate) {
        window.clearTimeout(timer);
        const target = Math.max(0, Math.min(events.length, Math.floor(steps)));
        if (!animate || reduced() || target <= shown) return apply(target);
        const tick = () => {
          apply(shown + 1);
          if (shown < target) timer = window.setTimeout(tick, Math.min(95, 1100 / Math.max(1, target - shown)));
        };
        return tick();
      },
      pour() {
        if (reduced()) return;
        rain.classList.remove('pouring');
        ripple.classList.remove('pouring');
        void rain.getBoundingClientRect();
        rain.classList.add('pouring');
        ripple.classList.add('pouring');
      },
    };
  }

  window.FlowerPlant = { mount };
})();
