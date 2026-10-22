#!/usr/bin/env node
'use strict';

// Итоговые скриншоты: docs/ui-final/<роль>/<экран>-<desktop|390>.png + README.md (оглавление).
// Запуск: `npm run e2e:shots`. Сид-БД, случайный порт; первый экран (не полная страница).

const fs = require('fs');
const path = require('path');
const L = require('./lib');

const OUT = path.join(L.ROOT, 'docs', 'ui-final');
// [имя, url, зачем экран]; аккаунт роли — ROLE_ACCOUNTS либо явный.
const SCREENS = {
  anon: { who: null, list: [
    ['login', '/login', 'Вход: единая форма для всех ролей, ссылка на регистрацию.'],
    ['register', '/register', 'Регистрация пациента: раздельные согласия, необязательный код от врача.'],
  ] },
  patient: { who: 'p2', list: [
    ['dashboard', '/dashboard', 'Главная пациента: что назначено, ближайшие шаги, кнопка «Мне плохо».'],
    ['tests', '/tests', 'Тесты: назначенные, пройденные, динамика.'],
    ['chat', '/chat', 'ИИ-помощник: диалог поддержки с кризисным протоколом.'],
    ['diary', '/diary', 'Дневник настроения: запись за минуту и график.'],
    ['meds', '/meds', 'Лечение: приём лекарств по назначению врача и собственные записи.'],
    ['messages', '/messages', 'Сообщения врачу: короткая переписка без срочности.'],
    ['learn', '/learn', 'Обучение: короткие материалы о состоянии и навыках.'],
    ['previsit', '/previsit', 'Перед приёмом: подготовка вопросов и итогов недели.'],
    ['reminders', '/reminders', 'Напоминания: разовые и повторяющиеся.'],
    ['my-conclusions', '/my-conclusions', 'Заключения: то, что специалист выдал пациенту.'],
    ['share', '/share', 'Поделиться с врачом: что именно видит врач.'],
    ['privacy', '/privacy', 'Приватность: согласия, журнал просмотров, отзыв и удаление.'],
    ['profile', '/profile', 'Профиль: данные аккаунта и пароль.'],
    ['help', '/help', 'Мне плохо: экстренные контакты, обращение к врачу, быстрый выход.'],
  ] },
  psychiatrist: { who: 'psy1', list: [
    ['dashboard', '/dashboard', 'Сводка «светофор»: кому нужно внимание сегодня.'],
    ['patients', '/patients', 'Пациенты: список со статусом, фильтры, завершение наблюдения.'],
    ['patient-overview', '/patients/6', 'Карточка пациента: обзор, динамика и открытые эскалации.'],
    ['patient-scales', '/patients/6/scales', 'Шкалы: результаты онлайн-тестов и сравнение.'],
    ['patient-offline', '/patients/6/offline', 'Очные результаты: ввод, «ожидает ввода», сравнение онлайн/очно.'],
    ['patient-diary', '/patients/6/diary', 'Дневник пациента в пределах его согласия.'],
    ['patient-treatment', '/patients/6/treatment', 'Лечение: назначения и приём.'],
    ['patient-notes', '/patients/6/notes', 'Личные заметки врача (приватны).'],
    ['patient-materials', '/patients/6/materials', 'Материалы из ИИ-пространства по пациенту.'],
    ['patient-journal', '/patients/6/journal', 'Журнал действий по пациенту.'],
    ['patient-messages', '/patients/6/messages', 'Переписка с пациентом.'],
    ['patient-visit', '/patients/6/visit', 'К приёму: краткая сводка перед встречей.'],
    ['assignments', '/assignments', 'Назначения: каталог методик и расписание.'],
    ['invites', '/invites', 'Приглашения: коды для привязки пациентов.'],
    ['conclusions', '/conclusions', 'Заключения: черновики и подписанные версии.'],
    ['inbox', '/inbox', 'Сообщения: входящие от пациентов.'],
    ['crisis', '/crisis', 'Кризисная очередь: эскалации, SLA, подтверждение.'],
    ['ai', '/ai', 'ИИ-пространство: диалоги и работа с материалами.'],
    ['tools', '/tools', 'Инструменты: калькуляторы, шаблоны, импорт, когорта.'],
    ['calculator', '/tools/calculator/phq9', 'Калькулятор шкалы: быстрый подсчёт баллов.'],
    ['export', '/export', 'Экспорт: что попадает в научную выгрузку.'],
  ] },
  psychologist: { who: 'plg', list: [
    ['dashboard', '/dashboard', 'Сводка психолога.'],
    ['patient-conclusions', '/patients/9/conclusions', 'Заключения и сеансы обследования по пациенту.'],
    ['conclusion-edit', '/conclusions/1', 'Заключение: разделы, протоколы, подпись, версии.'],
    ['exam', '/patients/9/exam/1', 'Сеанс обследования: ввод протоколов методик по частям.'],
    ['patient-offline', '/patients/8/offline', 'Очные результаты и протоколы.'],
  ] },
  admin: { who: 'admin', list: [
    ['dashboard', '/dashboard', 'Требует решения: очередь дел администратора.'],
    ['nobody', '/admin/nobody', 'Без врача: эскалации без ответственного, передача врачу.'],
    ['deletion', '/admin/deletion', 'Запросы на удаление данных.'],
    ['users', '/admin/users', 'Пользователи: поиск, создание, деактивация.'],
    ['user-detail', '/admin/users/11', 'Карточка пользователя.'],
    ['assignments', '/admin/assignments', 'Привязки пациентов к врачам.'],
    ['invites', '/admin/invites', 'Приглашения по всей системе.'],
    ['audit', '/admin/audit', 'Журналы: действия и доступы.'],
    ['consents', '/admin/consents', 'Согласия пациентов.'],
    ['system', '/admin/system', 'Система: состояние и настройки.'],
  ] },
};
const LABEL = { anon: 'Без входа', patient: 'Пациент', psychiatrist: 'Психиатр', psychologist: 'Психолог', admin: 'Администратор' };

(async () => {
  if (!L.findChromium()) { console.log('SKIP shots: нет Chromium (CHROMIUM_PATH).'); return; }
  const srv = await L.startServer();
  const b = await L.launch();
  fs.rmSync(OUT, { recursive: true, force: true });
  let readme = '# Итоговые экраны (W3.I)\n\nСнято на сид-БД (`npm run e2e:shots`): десктоп 1280×800 и телефон 390×844, первый экран. Все данные вымышленные.\n';
  try {
    for (const [role, def] of Object.entries(SCREENS)) {
      readme += `\n## ${LABEL[role]}\n\n| Экран | Зачем | Десктоп | 390 px |\n|---|---|---|---|\n`;
      for (const [pname, profile] of [['desktop', L.DESKTOP], ['390', L.MOBILE]]) {
        let ctx; let page;
        if (def.who) ({ ctx, page } = await L.login(b, srv.base, def.who, profile));
        else { ctx = await b.newContext({ ...profile, locale: 'ru-RU' }); page = await ctx.newPage(); }
        for (const [name, url] of def.list) {
          const resp = await page.goto(srv.base + url, { waitUntil: 'load' });
          if (!resp || resp.status() >= 400) console.log(`WARN ${role} ${url} -> ${resp && resp.status()}`);
          fs.mkdirSync(path.join(OUT, role), { recursive: true });
          await page.screenshot({ path: path.join(OUT, role, `${name}-${pname}.png`) });
        }
        await ctx.close();
      }
      for (const [name, url, why] of def.list) readme += `| \`${url}\` | ${why} | [${role}/${name}-desktop.png](${role}/${name}-desktop.png) | [${role}/${name}-390.png](${role}/${name}-390.png) |\n`;
    }
  } finally { await b.close(); srv.stop(); }
  fs.writeFileSync(path.join(OUT, 'README.md'), readme);
  console.log('Скриншоты: ' + OUT);
})();
