'use strict';
// Методики самопомощи прямо на странице приложения (раньше — отдельные html в рамке): дыхание по квадрату и «4-7-8»,
// мышечная релаксация, заземление 5-4-3-2-1, активация поведения. Разметка — в дизайне приложения (public/techniques.css).
// Упражнение считается пройденным, когда оно дошло до конца: тогда страница сообщает об этом событием
// «technique:complete», а public/js/flower.js (только у пациента) начисляет капельки, раз в день на методику.
// Ответы в заземлении и активации остаются в браузере и никуда не отправляются.
(() => {
  const root = document.querySelector('[data-technique-app]');
  if (!root) return;
  const slug = root.dataset.techniqueApp;
  const patient = Boolean(document.querySelector('[data-flower-counter]'));
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const esc = (v) =>
    String(v ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  const $ = (selector, scope = root) => scope.querySelector(selector);
  const complete = () => window.dispatchEvent(new CustomEvent('technique:complete', { detail: { slug } }));
  const reward = patient ? '<p class="tx-reward" role="status" aria-live="polite" data-technique-feedback></p>' : '';
  const plural = (n, one, few, many) =>
    n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? few : many;

  // Часы упражнения: пауза и продолжение без сдвига, в конце вызывается onFinish.
  function timeline(total, onFrame, onFinish) {
    let running = false,
      start = 0,
      elapsed = 0,
      raf = 0;
    const tick = (now) => {
      if (!running) return;
      const e = elapsed + now - start;
      if (e >= total) {
        running = false;
        elapsed = total;
        onFrame(total);
        onFinish();
        return;
      }
      onFrame(e);
      raf = requestAnimationFrame(tick);
    };
    return {
      get running() {
        return running;
      },
      get started() {
        return running || elapsed > 0;
      },
      get finished() {
        return elapsed >= total;
      },
      play() {
        if (elapsed >= total) elapsed = 0;
        running = true;
        start = performance.now();
        raf = requestAnimationFrame(tick);
      },
      pause() {
        if (!running) return;
        running = false;
        elapsed += performance.now() - start;
        cancelAnimationFrame(raf);
      },
      reset() {
        running = false;
        cancelAnimationFrame(raf);
        elapsed = 0;
      },
    };
  }

  const ease = (f) => (calm ? 1 : f * f * (3 - 2 * f));

  // ---------- дыхание: круг растёт на вдохе и сжимается на выдохе ----------
  function breathing(cfg) {
    const cycleMs = cfg.phases.reduce((sum, p) => sum + p.ms, 0);
    const total = cycleMs * cfg.cycles;
    const CORNERS = [
      [10, 290],
      [10, 10],
      [290, 10],
      [290, 290],
      [10, 290],
    ];
    const RING = 2 * Math.PI * 140;
    const track =
      cfg.visual === 'square'
        ? '<rect class="tx-track" x="10" y="10" width="280" height="280" rx="28"/><circle class="tx-dot" data-dot cx="10" cy="290" r="10"/>'
        : `<circle class="tx-track" cx="150" cy="150" r="140"/><circle class="tx-ring" data-ring cx="150" cy="150" r="140" stroke-dasharray="${RING}" stroke-dashoffset="${RING}"/>`;
    root.innerHTML = `<div class="tx tx--cols">
      <div class="tx-stage">
        <svg viewBox="0 0 300 300" aria-hidden="true" focusable="false">
          <defs><radialGradient id="tx-orb" cx="35%" cy="30%" r="75%"><stop offset="0" class="tx-orb-a"/><stop offset=".55" class="tx-orb-b"/><stop offset="1" class="tx-orb-c"/></radialGradient></defs>
          ${track}
          <circle data-orb cx="150" cy="150" r="60" fill="url(#tx-orb)" opacity=".9"/>
        </svg>
        <div class="tx-orb-label" aria-hidden="true"><span class="tx-orb-name" data-name></span><span class="tx-orb-count" data-count></span></div>
      </div>
      <div class="tx-side">
        <p class="tx-phase" data-phase aria-live="polite">Готовы начать</p>
        <p class="tx-cue" data-cue>${esc(cfg.idleCue)}</p>
        <div class="tx-done" data-done hidden><strong>Упражнение пройдено</strong><p>${esc(cfg.doneText)}</p>${reward}</div>
        <div class="tx-cycles" data-cycles></div>
        <div class="tx-progress" aria-hidden="true"><div data-bar></div></div>
        <div class="tx-actions"><button type="button" class="btn primary" data-toggle>Начать</button><button type="button" class="btn" data-reset>Сначала</button></div>
        <ul class="tx-tips">${cfg.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
      </div>
    </div>`;
    const orb = $('[data-orb]'),
      dot = $('[data-dot]'),
      ring = $('[data-ring]'),
      nameEl = $('[data-name]'),
      countEl = $('[data-count]'),
      phaseEl = $('[data-phase]'),
      cueEl = $('[data-cue]'),
      doneEl = $('[data-done]'),
      cyclesEl = $('[data-cycles]'),
      bar = $('[data-bar]'),
      toggle = $('[data-toggle]');
    const set = (el, text) => {
      if (el.textContent !== text) el.textContent = text;
    };
    function paintCycles(done, now) {
      cyclesEl.innerHTML =
        Array.from(
          { length: cfg.cycles },
          (_, i) => `<i class="${i < done ? 'is-done' : i === done && now ? 'is-now' : ''}"></i>`,
        ).join('') + `<span>${done >= cfg.cycles ? 'Все циклы пройдены' : `Цикл ${done + 1} из ${cfg.cycles}`}</span>`;
    }
    let shownCycle = -1;
    function frame(e) {
      const finished = e >= total;
      const inCycle = finished ? cycleMs : e % cycleMs;
      const cycle = finished ? cfg.cycles : Math.floor(e / cycleMs);
      let at = 0,
        index = 0;
      for (; index < cfg.phases.length - 1 && inCycle >= at + cfg.phases[index].ms; index += 1)
        at += cfg.phases[index].ms;
      const phase = cfg.phases[index];
      const f = Math.min(1, (inCycle - at) / phase.ms);
      const scale = phase.from + (phase.to - phase.from) * ease(f);
      orb.setAttribute('r', String((100 * scale).toFixed(1)));
      if (dot) {
        const [x0, y0] = CORNERS[index];
        const [x1, y1] = CORNERS[index + 1];
        dot.setAttribute('cx', String(x0 + (x1 - x0) * f));
        dot.setAttribute('cy', String(y0 + (y1 - y0) * f));
      }
      if (ring) ring.setAttribute('stroke-dashoffset', String(RING * (1 - inCycle / cycleMs)));
      set(nameEl, phase.name);
      set(countEl, String(Math.max(1, Math.ceil((phase.ms * (1 - f)) / 1000))));
      set(phaseEl, phase.name);
      set(cueEl, phase.cue);
      bar.style.width = `${(Math.min(e, total) / total) * 100}%`;
      if (cycle !== shownCycle) {
        shownCycle = cycle;
        paintCycles(cycle, true);
      }
    }
    function finish() {
      nameEl.textContent = '';
      countEl.textContent = '';
      set(phaseEl, 'Готово');
      cueEl.hidden = true;
      doneEl.hidden = false;
      toggle.textContent = 'Ещё раз';
      paintCycles(cfg.cycles, false);
      bar.style.width = '100%';
      complete();
    }
    function blank() {
      nameEl.textContent = '';
      countEl.textContent = '';
      orb.setAttribute('r', String(100 * cfg.phases[0].from));
      if (dot) {
        dot.setAttribute('cx', '10');
        dot.setAttribute('cy', '290');
      }
      if (ring) ring.setAttribute('stroke-dashoffset', String(RING));
      set(phaseEl, 'Готовы начать');
      cueEl.hidden = false;
      set(cueEl, cfg.idleCue);
      doneEl.hidden = true;
      toggle.textContent = 'Начать';
      bar.style.width = '0%';
      shownCycle = -1;
      paintCycles(0, false);
    }
    const clock = timeline(total, frame, finish);
    toggle.addEventListener('click', () => {
      if (clock.running) {
        clock.pause();
        toggle.textContent = 'Продолжить';
        return;
      }
      if (clock.finished) blank();
      shownCycle = -1;
      cueEl.hidden = false;
      doneEl.hidden = true;
      toggle.textContent = 'Пауза';
      clock.play();
    });
    $('[data-reset]').addEventListener('click', () => {
      clock.reset();
      blank();
    });
    blank();
  }

  // ---------- мышечная релаксация: семь групп мышц, напряжение и расслабление ----------
  function pmr() {
    const TENSE = 7000,
      RELAX = 10000,
      CYCLE = TENSE + RELAX;
    const GROUPS = [
      {
        key: 'legs',
        name: 'Ноги',
        tense: 'Сильно прижмите стопы к полу, пятки чуть приподнимите. Держите напряжение: чувствуйте бёдра и икры.',
        relax: 'Резко отпустите. По ногам разливаются тепло и тяжесть: ноги стали тёплыми и тяжёлыми.',
      },
      {
        key: 'belly',
        name: 'Живот',
        tense: 'Втяните и напрягите живот, как будто ждёте лёгкого толчка. Дышите свободно, но живот твёрдый.',
        relax: 'Отпустите живот. Он стал мягким и тёплым, дыхание в него само стало глубже.',
      },
      {
        key: 'chest',
        name: 'Грудь',
        tense: 'Сделайте глубокий вдох и напрягите мышцы груди, расширив её. Держите напряжение.',
        relax: 'Медленно выдохните и расслабьте грудь. Грудная клетка опускается тяжело и мягко.',
      },
      {
        key: 'hands',
        name: 'Руки',
        tense: 'Сильно-сильно сожмите кулаки. Чувствуйте напряжение в пальцах, кистях и предплечьях.',
        relax: 'Разожмите кулаки. Ладони стали тёплыми и расслабленными, пальцы тяжело лежат.',
      },
      {
        key: 'shoulders',
        name: 'Плечи',
        tense: 'Поднимите плечи вверх, к ушам. Это любимое место тревоги: заметьте, как там напряжённо.',
        relax: 'Плечи резко падают вниз. Отпустите их совсем: пусть лежат тяжело и далеко от ушей.',
      },
      {
        key: 'neck',
        name: 'Шея',
        tense: 'Мягко, без боли, прижмите голову назад, к спинке стула или стене. Напрягите заднюю поверхность шеи.',
        relax: 'Перестаньте давить. Шея стала длинной, тёплой и мягкой.',
      },
      {
        key: 'face',
        name: 'Лицо',
        tense: 'Сильно зажмурьте глаза, наморщите лоб, сожмите челюсти. Всё лицо напряжено, держите.',
        relax: 'Отпустите лицо. Лоб разгладился, челюсти разошлись, веки тяжёлые и приятные.',
      },
    ];
    const total = GROUPS.length * CYCLE;
    const idleCue =
      'Сядьте или лягте удобно. Семь групп мышц: по семь секунд напряжения и десять секунд расслабления, около двух минут.';
    root.innerHTML = `<div class="tx tx--cols">
      <div class="tx-figure">
        <svg viewBox="0 0 300 330" role="img" aria-label="Силуэт человека с подсвеченной группой мышц">
          <circle class="tx-halo" data-halo cx="150" cy="165" r="150"/>
          <circle class="tx-part" data-g="face" cx="150" cy="64" r="27"/>
          <rect class="tx-part" data-g="neck" x="141" y="92" width="18" height="18" rx="6"/>
          <circle class="tx-part" data-g="shoulders" cx="112" cy="124" r="15"/><circle class="tx-part" data-g="shoulders" cx="188" cy="124" r="15"/>
          <rect class="tx-part" data-g="chest" x="121" y="112" width="58" height="52" rx="16"/>
          <rect class="tx-part" data-g="belly" x="124" y="166" width="52" height="46" rx="14"/>
          <rect class="tx-part" data-g="hands" x="92" y="136" width="15" height="58" rx="7"/><rect class="tx-part" data-g="hands" x="193" y="136" width="15" height="58" rx="7"/>
          <circle class="tx-part" data-g="hands" cx="99" cy="206" r="12"/><circle class="tx-part" data-g="hands" cx="201" cy="206" r="12"/>
          <rect class="tx-part" data-g="legs" x="125" y="214" width="21" height="82" rx="10"/><rect class="tx-part" data-g="legs" x="154" y="214" width="21" height="82" rx="10"/>
          <ellipse class="tx-part" data-g="legs" cx="135" cy="302" rx="16" ry="7"/><ellipse class="tx-part" data-g="legs" cx="165" cy="302" rx="16" ry="7"/>
        </svg>
      </div>
      <div class="tx-side">
        <p class="tx-phase" data-phase aria-live="polite">Готовы начать</p>
        <p class="tx-cue" data-cue>${esc(idleCue)}</p>
        <div class="tx-done" data-done hidden><strong>Упражнение пройдено</strong><p>Всё тело отпущено: тепло, тяжесть, покой. Побудьте в этом ощущении ещё немного: теперь вы умеете к нему возвращаться.</p>${reward}</div>
        <div class="tx-progress" aria-hidden="true"><div data-bar></div></div>
        <ul class="tx-groups" data-groups>${GROUPS.map((g) => `<li>${esc(g.name)}</li>`).join('')}</ul>
        <div class="tx-actions"><button type="button" class="btn primary" data-toggle>Начать</button><button type="button" class="btn" data-reset>Сначала</button><span class="tx-orb-count" data-count aria-hidden="true"></span></div>
        <p class="tx-note">Дышите спокойно, не задерживайте дыхание надолго. После каждого расслабления задержитесь в ощущении разницы. Если больно, напрягайте слабее.</p>
      </div>
    </div>`;
    const parts = [...root.querySelectorAll('.tx-part')],
      halo = $('[data-halo]'),
      phaseEl = $('[data-phase]'),
      cueEl = $('[data-cue]'),
      doneEl = $('[data-done]'),
      bar = $('[data-bar]'),
      countEl = $('[data-count]'),
      items = [...$('[data-groups]').children],
      toggle = $('[data-toggle]');
    const set = (el, text) => {
      if (el.textContent !== text) el.textContent = text;
    };
    const paintParts = (key, cls) =>
      parts.forEach((p) => {
        p.classList.remove('is-tense', 'is-relax');
        if (key && p.dataset.g === key) p.classList.add(cls);
      });
    function frame(e) {
      const index = Math.min(GROUPS.length - 1, Math.floor(e / CYCLE));
      const inCycle = e - index * CYCLE;
      const tense = inCycle < TENSE;
      const g = GROUPS[index];
      paintParts(g.key, tense ? 'is-tense' : 'is-relax');
      phaseEl.classList.toggle('is-tense', tense);
      set(phaseEl, `${tense ? 'Напрягаем' : 'Расслабляем'}: ${g.name.toLowerCase()}`);
      set(cueEl, tense ? g.tense : g.relax);
      set(countEl, String(Math.ceil((tense ? TENSE - inCycle : RELAX - inCycle) / 1000)));
      bar.style.width = `${(Math.min(e, total) / total) * 100}%`;
      items.forEach((li, i) => {
        li.classList.toggle('is-done', i < index);
        li.classList.toggle('is-now', i === index);
      });
    }
    function finish() {
      parts.forEach((p) => {
        p.classList.remove('is-tense');
        p.classList.add('is-relax');
      });
      halo.classList.add('is-on');
      phaseEl.classList.remove('is-tense');
      set(phaseEl, 'Готово');
      cueEl.hidden = true;
      doneEl.hidden = false;
      countEl.textContent = '';
      bar.style.width = '100%';
      items.forEach((li) => {
        li.classList.remove('is-now');
        li.classList.add('is-done');
      });
      toggle.textContent = 'Ещё раз';
      complete();
    }
    function blank() {
      paintParts(null);
      halo.classList.remove('is-on');
      phaseEl.classList.remove('is-tense');
      set(phaseEl, 'Готовы начать');
      cueEl.hidden = false;
      set(cueEl, idleCue);
      doneEl.hidden = true;
      countEl.textContent = '';
      bar.style.width = '0%';
      items.forEach((li) => li.classList.remove('is-done', 'is-now'));
      toggle.textContent = 'Начать';
    }
    const clock = timeline(total, frame, finish);
    toggle.addEventListener('click', () => {
      if (clock.running) {
        clock.pause();
        toggle.textContent = 'Продолжить';
        return;
      }
      if (clock.finished) blank();
      cueEl.hidden = false;
      doneEl.hidden = true;
      toggle.textContent = 'Пауза';
      clock.play();
    });
    $('[data-reset]').addEventListener('click', () => {
      clock.reset();
      blank();
    });
    blank();
  }

  // ---------- пошаговые упражнения ----------
  const stepsBar = (count, now) =>
    `<div class="tx-steps" aria-hidden="true">${Array.from({ length: count }, (_, i) => `<i class="${i < now ? 'is-done' : i === now ? 'is-now' : ''}"></i>`).join('')}</div>`;
  const view = (html) => {
    root.innerHTML = `<div class="tx tx-wiz">${html}</div>`;
  };
  const quiet =
    '<p class="tx-note">Если тревога возвращается часто и мешает жить, это повод обратиться к врачу. Упражнение помогает, но не заменяет лечение.</p>';

  function grounding() {
    const STEPS = [
      {
        need: 5,
        noun: 'предмет',
        title: 'Пять предметов',
        text: 'Оглянитесь вокруг. Медленно, спокойно найдите пять любых предметов рядом с вами. Каждый называйте про себя и записывайте сюда.',
        example: 'Например: лампа, кружка, растение, куртка, замок на двери.',
      },
      {
        need: 4,
        noun: 'звук',
        title: 'Четыре звука',
        text: 'Теперь послушайте. Не ищите ничего особенного: звуки уже вокруг. Найдите четыре разных, ближних или дальних.',
        example: 'Например: гул компьютера, шаги за стеной, своё дыхание, чей-то голос.',
      },
      {
        need: 3,
        noun: 'ощущение',
        title: 'Три ощущения тела',
        text: 'Перенесите внимание на тело. Заметьте три ощущения: как одежда касается кожи, где стоят ноги, к чему прикасается спина.',
        example: 'Например: спина прислонена к спинке стула, ступни стоят на полу, кольцо давит на палец.',
      },
      {
        need: 2,
        noun: 'запах',
        title: 'Два запаха',
        text: 'Сделайте спокойный вдох и попробуйте найти два запаха. Если сначала ничего не чувствуется, это нормально: подышите помедленнее.',
        example: 'Например: кофе, духи, бумага, свежий воздух из окна.',
      },
      {
        need: 1,
        noun: 'вкус',
        title: 'Один вкус',
        text: 'И последнее. Обратите внимание на рот и язык. Какой там привкус? Один, и можно выдохнуть: упражнение почти закончено.',
        example: 'Например: привкус чая, зубной пасты или просто нейтральный.',
      },
    ];
    let current = 0,
      answers = [];
    function intro() {
      view(`<h2 class="tx-title">Заземление</h2>
        <p class="tx-lead">Короткое упражнение на пять шагов. Оно помогает выйти из тревожной головы и вернуться в «здесь и сейчас».</p>
        <p class="tx-example">Никуда спешить не нужно. Пишите просто, как есть: описывая обычный мир вокруг, вы возвращаетесь в момент «сейчас», и тревога постепенно отступает.</p>
        <div class="tx-actions"><button type="button" class="btn primary" data-begin>Начнём</button></div>`);
      $('[data-begin]').addEventListener('click', () => {
        current = 0;
        answers = [];
        step();
      });
    }
    function step() {
      const s = STEPS[current];
      const saved = answers[current] || [];
      view(`${stepsBar(STEPS.length, current)}
        <h2 class="tx-title"><span class="tx-num">${s.need}</span>${esc(s.title)}</h2>
        <p class="tx-lead">${esc(s.text)}</p>
        <p class="tx-example">${esc(s.example)}</p>
        <div class="tx-fields">${Array.from({ length: s.need }, (_, i) => `<input type="text" data-i="${i}" placeholder="${esc(s.noun)} ${i + 1}" aria-label="${esc(s.noun)} ${i + 1}" autocomplete="off" value="${esc(saved[i] || '')}" class="${saved[i] ? 'is-filled' : ''}">`).join('')}</div>
        <p class="tx-count" data-count></p>
        <div class="tx-actions">${current > 0 ? '<button type="button" class="btn" data-back>Назад</button>' : ''}<button type="button" class="btn primary" data-next disabled>${current === STEPS.length - 1 ? 'Завершить' : 'Дальше'}</button></div>`);
      const inputs = [...root.querySelectorAll('input')];
      const next = $('[data-next]');
      const update = () => {
        const filled = inputs.filter((input) => input.value.trim()).length;
        inputs.forEach((input) => input.classList.toggle('is-filled', Boolean(input.value.trim())));
        const count = $('[data-count]');
        count.classList.toggle('is-complete', filled === s.need);
        count.textContent =
          filled === s.need ? `Отлично, все ${s.need}! Идём дальше.` : `Замечено ${filled} из ${s.need}`;
        next.disabled = filled === 0;
      };
      const keep = () => {
        answers[current] = inputs.map((input) => input.value.trim());
      };
      inputs.forEach((input, i) => {
        input.addEventListener('input', update);
        input.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          if (inputs[i + 1]) inputs[i + 1].focus();
          else if (!next.disabled) next.click();
        });
      });
      $('[data-back]')?.addEventListener('click', () => {
        keep();
        current -= 1;
        step();
      });
      next.addEventListener('click', () => {
        keep();
        if (current === STEPS.length - 1) finish();
        else {
          current += 1;
          step();
        }
      });
      update();
      inputs[0].focus({ preventScroll: true });
    }
    function finish() {
      const groups = STEPS.map((s, i) => ({ s, list: (answers[i] || []).filter(Boolean) })).filter(
        (g) => g.list.length,
      );
      view(`<h2 class="tx-title">Вы справились</h2>
        <p class="tx-lead">Вы назвали то, что действительно есть вокруг вас, а это и есть момент «сейчас». Тревога живёт в мыслях о будущем, а вы вернулись туда, где вы в безопасности.</p>
        <div class="tx-summary">${groups.map((g) => `<div class="tx-summary-row"><b>${esc(g.s.title)}:</b><span class="tx-chips">${g.list.map((x) => `<span class="tx-chip">${esc(x)}</span>`).join('')}</span></div>`).join('')}</div>
        <div class="tx-done"><strong>Упражнение пройдено</strong>${reward}</div>
        <div class="tx-actions"><button type="button" class="btn" data-again>Пройти ещё раз</button></div>${quiet}`);
      $('[data-again]').addEventListener('click', intro);
      complete();
    }
    intro();
  }

  function activation() {
    const COUNT = 4;
    let state;
    const fresh = () => {
      state = { magic: ['', '', ''], items: [], chosen: -1, today: '', soon: '' };
    };
    function intro() {
      view(`<h2 class="tx-title">Активация поведения</h2>
        <p class="tx-lead">Эмоции, мысли и поведение связаны в одну цепь. Иногда самый надёжный способ сдвинуть тревогу с места — начать с маленького действия.</p>
        <p class="tx-example">Четыре спокойных шага: помечтаем, соберём список того, что вам нравится, выберем одно простое дело и договоримся с собой, когда оно случится.</p>
        <div class="tx-actions"><button type="button" class="btn primary" data-begin>Начнём</button></div>`);
      $('[data-begin]').addEventListener('click', () => {
        fresh();
        magic();
      });
    }
    const nav = (back, nextLabel = 'Дальше', disabled = true) =>
      `<div class="tx-actions">${back ? '<button type="button" class="btn" data-back>Назад</button>' : ''}<button type="button" class="btn primary" data-next ${disabled ? 'disabled' : ''}>${nextLabel}</button></div>`;
    function magic() {
      const prompts = ['Прямо сейчас я позволил(а) бы себе…', 'Чаще и больше я бы…', 'Моя жизнь в целом стала бы…'];
      view(`${stepsBar(COUNT, 0)}
        <h2 class="tx-title">Если бы волшебство сработало</h2>
        <p class="tx-lead">Представьте: тревога ушла настолько, что больше не мешает жить. Не нужно придумывать грандиозное: пишите первое простое, что приходит в голову.</p>
        <p class="tx-example">Например: «позвонила бы подруге и поговорила не про работу», «пошла бы вечером гулять без чувства вины», «снова села бы рисовать».</p>
        <div class="tx-fields tx-fields--one">${prompts.map((p, i) => `<label class="tx-field">${esc(p)}<input type="text" data-i="${i}" autocomplete="off" value="${esc(state.magic[i])}"></label>`).join('')}</div>
        ${nav(false)}`);
      const inputs = [...root.querySelectorAll('input')];
      const next = $('[data-next]');
      const update = () => {
        inputs.forEach((input) => {
          state.magic[Number(input.dataset.i)] = input.value;
          input.classList.toggle('is-filled', Boolean(input.value.trim()));
        });
        next.disabled = !state.magic.some((v) => v.trim());
      };
      inputs.forEach((input) => input.addEventListener('input', update));
      next.addEventListener('click', list);
      update();
      inputs[0].focus({ preventScroll: true });
    }
    function list() {
      view(`${stepsBar(COUNT, 1)}
        <h2 class="tx-title">Список того, что я люблю</h2>
        <p class="tx-lead">Вспомните занятия, которые вы любили или любите, но сейчас бросили или делаете гораздо реже. Это не «полезные подвиги», а только то, что по-настоящему ваше.</p>
        <p class="tx-example">Например: пересмотреть любимый фильм, начать читать давно купленный роман, погулять с собакой полчаса, сходить в бассейн, приготовить новое блюдо, позвонить старому другу.</p>
        <div class="tx-add"><input type="text" data-new placeholder="Одно занятие…" aria-label="Одно занятие" autocomplete="off"><button type="button" class="btn" data-add>Добавить</button></div>
        <div class="tx-chips" data-items></div>
        <p class="tx-count" data-count></p>
        ${nav(true)}`);
      const input = $('[data-new]'),
        next = $('[data-next]');
      const paint = () => {
        const box = $('[data-items]');
        box.innerHTML = state.items
          .map(
            (item, i) =>
              `<span class="tx-chip">${esc(item)}<button type="button" data-del="${i}" aria-label="Убрать: ${esc(item)}">×</button></span>`,
          )
          .join('');
        box.querySelectorAll('[data-del]').forEach((b) =>
          b.addEventListener('click', () => {
            state.items.splice(Number(b.dataset.del), 1);
            if (state.chosen >= state.items.length) state.chosen = -1;
            paint();
          }),
        );
        const enough = state.items.length >= 3;
        const count = $('[data-count]');
        count.classList.toggle('is-complete', enough);
        count.textContent = enough
          ? `Замечательно, ${state.items.length} ${plural(state.items.length, 'пункт', 'пункта', 'пунктов')}. Хватит и этого, идём дальше.`
          : `Пока ${state.items.length} из 3: добавьте ещё понемногу`;
        next.disabled = !enough;
      };
      const add = () => {
        const v = input.value.trim();
        input.value = '';
        if (v && !state.items.includes(v)) state.items.push(v);
        input.focus();
        paint();
      };
      $('[data-add]').addEventListener('click', add);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          add();
        }
      });
      $('[data-back]').addEventListener('click', magic);
      next.addEventListener('click', choose);
      paint();
      input.focus({ preventScroll: true });
    }
    function choose() {
      view(`${stepsBar(COUNT, 2)}
        <h2 class="tx-title">Выберите самое простое</h2>
        <p class="tx-lead">Отметьте одно занятие из списка: то, которое проще всего, без денег, компании и долгой подготовки. Секрет не в подвиге, а в том, чтобы начать.</p>
        <div class="tx-chips" data-picks>${state.items.map((item, i) => `<button type="button" class="tx-chip" data-pick="${i}" aria-pressed="${state.chosen === i}">${esc(item)}</button>`).join('')}</div>
        <p class="tx-count" data-count>${state.chosen >= 0 ? 'Отличный выбор: маленькое дело, с которого реально начать.' : 'Нажмите на занятие из списка: одно, самое доступное'}</p>
        ${nav(true, 'Дальше', state.chosen < 0)}`);
      const next = $('[data-next]');
      root.querySelectorAll('[data-pick]').forEach((b) =>
        b.addEventListener('click', () => {
          state.chosen = Number(b.dataset.pick);
          root.querySelectorAll('[data-pick]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
          $('[data-count]').textContent = 'Отличный выбор: маленькое дело, с которого реально начать.';
          $('[data-count]').classList.add('is-complete');
          next.disabled = false;
        }),
      );
      $('[data-back]').addEventListener('click', list);
      next.addEventListener('click', () => {
        state.today = state.today || state.items[state.chosen];
        state.soon = state.soon || state.items[(state.chosen + 1) % state.items.length];
        plan();
      });
    }
    function plan() {
      const options = (value) =>
        state.items
          .map((item) => `<option value="${esc(item)}" ${item === value ? 'selected' : ''}>${esc(item)}</option>`)
          .join('');
      view(`${stepsBar(COUNT, 3)}
        <h2 class="tx-title">Договоримся с собой конкретно</h2>
        <p class="tx-lead">Превратим выбор в план. Чем меньше шаг, тем лучше: не «вернуть форму», а «сходить в бассейн и проплыть пару дорожек».</p>
        <div class="tx-fields tx-fields--one">
          <label class="tx-field">Что сделаю сегодня (хотя бы часть: найду телефон бассейна, положу книгу на видное место)<select data-today>${options(state.today)}</select></label>
          <label class="tx-field">Что сделаю в ближайшие дни<select data-soon>${options(state.soon)}</select></label>
        </div>
        <p class="tx-example">Привяжите действие ко времени: «после ужина, двадцать минут». Так договориться с собой легче.</p>
        ${nav(true, 'Завершить', false)}`);
      $('[data-today]').addEventListener('change', (e) => {
        state.today = e.target.value;
      });
      $('[data-soon]').addEventListener('change', (e) => {
        state.soon = e.target.value;
      });
      $('[data-back]').addEventListener('click', choose);
      $('[data-next]').addEventListener('click', finish);
    }
    function finish() {
      view(`<h2 class="tx-title">Цепь тронулась</h2>
        <p class="tx-lead">Поведение — рычаг, который можно потянуть руками, даже когда настроение и мысли пока не слушаются. Сделайте маленький шаг, и следом подтянутся другие звенья цепи.</p>
        <div class="tx-plan"><div class="tx-chips">${state.items.map((item) => `<span class="tx-chip">${esc(item)}</span>`).join('')}</div><p><b>Сегодня:</b> ${esc(state.today)}</p><p><b>В ближайшие дни:</b> ${esc(state.soon)}</p></div>
        <div class="tx-done"><strong>Упражнение пройдено</strong>${reward}</div>
        <div class="tx-actions"><button type="button" class="btn" data-again>Пройти ещё раз</button></div>${quiet}`);
      $('[data-again]').addEventListener('click', intro);
      complete();
    }
    fresh();
    intro();
  }

  const BOX_TIPS = [
    'Сядьте удобно, спина прямая, плечи расслаблены.',
    'Следуйте точкой по стороне квадрата: одна сторона — один счёт до четырёх.',
    'Если закружилась голова, просто подышите ровно.',
  ];
  const apps = {
    'breathing-box': () =>
      breathing({
        visual: 'square',
        cycles: 6,
        idleCue: 'Вдох, задержка, выдох, задержка по четыре счёта. Шесть циклов займут около полутора минут.',
        doneText: 'Дыхание выровнялось. Побудьте в этом ритме ещё немного или вернитесь к делам.',
        tips: BOX_TIPS,
        phases: [
          { name: 'Вдох', ms: 4000, from: 0.55, to: 1, cue: 'Медленный вдох через нос на четыре счёта.' },
          { name: 'Задержка', ms: 4000, from: 1, to: 1, cue: 'Задержите дыхание, не напрягаясь.' },
          { name: 'Выдох', ms: 4000, from: 1, to: 0.55, cue: 'Плавный выдох на четыре счёта.' },
          { name: 'Задержка', ms: 4000, from: 0.55, to: 0.55, cue: 'Пауза после выдоха, плечи расслаблены.' },
        ],
      }),
    'breathing-478': () =>
      breathing({
        visual: 'ring',
        cycles: 4,
        idleCue:
          'Освободите лёгкие: глубокий вдох носом и выдох ртом. Затем следите за кругом: он растёт на вдохе и сжимается на выдохе.',
        doneText: 'Четыре цикла позади: тело замедлилось. Если хочется спать, оставайтесь в покое.',
        tips: [
          'Язык — кончиком к нёбу, за верхними передними зубами.',
          'На выдохе губы слегка подожмите.',
          'Если закружилась голова, прервитесь и подышите обычно.',
        ],
        phases: [
          { name: 'Вдох носом', ms: 4000, from: 0.55, to: 1, cue: 'Вдох носом на четыре счёта.' },
          { name: 'Задержка', ms: 7000, from: 1, to: 1, cue: 'Задержите дыхание на семь счётов, без усилия.' },
          { name: 'Выдох ртом', ms: 8000, from: 1, to: 0.55, cue: 'Медленный выдох ртом на восемь счётов.' },
        ],
      }),
    pmr,
    'grounding-54321': grounding,
    activation,
  };
  (apps[slug] || (() => {}))();
})();
