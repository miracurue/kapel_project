'use strict';

/**
 * Голосовой ввод (F-14, W-31): кнопка-микрофон в поле ввода. Запись → «Расшифровываем…» →
 * текст в поле с пометкой «Распознано автоматически — проверьте». Ничего не отправляется
 * без нажатия «Отправить». Расшифровка — POST /api/v1/stt (ml-worker); если распознавание не
 * настроено, пользователь видит спокойное сообщение, а текст остаётся как был.
 */
(function () {
  const MIC =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>';
  const tid = (key) => `[data-testid="${key}"]`;
  const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  function wire(box) {
    const field = box.querySelector('textarea');
    if (!field || box.querySelector(tid('msg.composer.mic'))) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mic-btn';
    btn.dataset.testid = 'msg.composer.mic';
    btn.setAttribute('aria-label', 'Голосовой ввод');
    btn.innerHTML = MIC;
    const send = box.querySelector(tid('msg.composer.send'));
    box.insertBefore(btn, send || null);

    const note = document.createElement('p');
    note.className = 'mic-note small';
    note.setAttribute('role', 'status');
    note.hidden = true;
    box.after(note);
    const say = (key, text) => {
      note.hidden = !text;
      note.dataset.testid = key || '';
      note.textContent = text || '';
    };

    let rec = null;
    let chunks = [];
    let started = 0;
    let timer = null;

    const finish = async () => {
      clearInterval(timer);
      btn.classList.remove('on');
      const seconds = Math.max(1, Math.round((Date.now() - started) / 1000));
      const blob = new Blob(chunks, { type: (rec && rec.mimeType) || 'audio/webm' });
      say('msg.composer.mic.transcribing', 'Расшифровываем…');
      try {
        const token = (await (await fetch('/api/v1/csrf')).json()).token;
        const form = new FormData();
        form.append('audio', blob, 'voice.webm');
        form.append('duration_s', String(seconds));
        const res = await fetch('/api/v1/stt', {
          method: 'POST',
          headers: { 'x-csrf-token': token, 'idempotency-key': crypto.randomUUID() },
          body: form,
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.text) {
          field.value = [field.value, data.text].filter(Boolean).join(' ');
          field.focus();
          say('msg.composer.mic.recognized', 'Распознано автоматически — проверьте текст перед отправкой');
        } else if (res.status === 422) say('', 'Не расслышали — попробуйте ещё раз или напишите текстом.');
        else say('', 'Голос сейчас не расшифровывается — напишите текстом. Запись нигде не сохранена.');
      } catch (_) {
        say('', 'Нет связи. Напишите текстом — запись нигде не сохранена.');
      }
    };

    btn.addEventListener('click', async () => {
      if (rec && rec.state === 'recording') {
        rec.stop();
        return;
      }
      if (!navigator.mediaDevices || !window.MediaRecorder) {
        say('', 'Микрофон в этом браузере недоступен — напишите текстом.');
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        chunks = [];
        rec = new MediaRecorder(stream);
        rec.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data);
        rec.onstop = () => {
          stream.getTracks().forEach((t) => t.stop());
          finish();
        };
        rec.start();
        started = Date.now();
        btn.classList.add('on');
        const tick = () => say('msg.composer.mic.recording', `Идёт запись · ${mmss(Math.round((Date.now() - started) / 1000))} · Остановить`);
        tick();
        timer = setInterval(tick, 500);
      } catch (_) {
        say('', 'Нет доступа к микрофону — разрешите его в браузере или напишите текстом.');
      }
    });
  }

  function init() {
    document.querySelectorAll('.chat-input').forEach(wire);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
