'use strict';

// W2.X (D14, NFR-011): единый словарь «технический код -> человеческая подпись».
// В интерфейсе не должно быть кодов вида view_patient_tab:diary, ai_open_thread, «Tier 1».
// Тексты подписей — заглушки, review-required (не клинические).

const TIER_WORDS = { 1: 'внимание', 2: 'повышенный', 3: 'срочный' };
/** «Уровень 1 · внимание» вместо «Tier 1». */
function tierLabel(tier) {
  const n = Number(tier);
  if (!TIER_WORDS[n]) return 'Уровень не определён';
  return `Уровень ${n} · ${TIER_WORDS[n]}`;
}

const TAB_LABELS = {
  overview: 'Обзор', scales: 'Шкалы и динамика', offline: 'Офлайн-ввод и сравнение', diary: 'Дневник', treatment: 'Лечение',
  notes: 'Заметки', conclusions: 'Заключения', materials: 'Материалы', journal: 'Журнал',
};

const ACTIONS = {
  view_list_dashboard: 'пациент показан в сводке врача',
  view_list_patients: 'пациент показан в списке пациентов',
  view_list_crisis: 'пациент показан в кризисной очереди',
  view_list_inbox: 'пациент показан во входящих сообщениях',
  view_list_reminders: 'пациент показан в напоминаниях «пора повторить тест»',
  view_list_search: 'пациент показан в результатах поиска',
  view_export_page: 'открыта страница экспорта карточки',
  view_patient_detail: 'открыта карточка пациента',
  view_crisis_item: 'открыта кризисная запись',
  view_patient_visit: 'открыта справка «К приёму»',
  export_patient_visit_txt: 'скачана справка «К приёму»',
  view_patient_messages: 'открыт диалог с пациентом',
  view_patient_care: 'открыты «Модули и опросник»',
  view_conclusion: 'открыто заключение',
  view_exam_session: 'открыта запись обследования',
  ai_bind_patient: 'диалог ИИ-пространства привязан к пациенту',
  ai_open_thread: 'открыт диалог ИИ-пространства по пациенту',
  ai_material_add: 'в ИИ-пространство добавлен материал о пациенте',
  ai_export: 'экспортирован ответ ИИ-пространства',
  ai_context_read: 'ИИ-пространство прочитало данные пациента',
  tools_template_fill: 'заполнен шаблон документа',
  tools_calculator_save: 'сохранён результат калькулятора',
  tools_csv_import: 'импортированы результаты из CSV',
  tools_csv_rollback: 'импорт из CSV отменён',
  deletion_request_cancelled: 'запрос на удаление отменён',
  user_create: 'создан пользователь', password_reset: 'сброс пароля', user_deactivate: 'деактивация', user_activate: 'активация',
  assignment_add: 'назначен специалист', assignment_remove: 'снят специалист', assignment_move: 'пациент переназначен',
  queue_acknowledge: '«Без врача»: подтверждено', queue_handover: '«Без врача»: передано врачу',
  deletion_execute: 'исполнено удаление данных', invite_create: 'выдан код-приглашение', invite_revoke: 'код-приглашение отозван',
  audit_export: 'выгрузка журнала в CSV',
};

/** Подпись действия журнала доступа/администратора. Неизвестный код -> нейтральное «служебное действие». */
function actionLabel(code) {
  const a = String(code || '');
  if (ACTIONS[a]) return ACTIONS[a];
  let m = /^view_patient_tab:(\w+)/.exec(a);
  if (m) return `открыта вкладка «${TAB_LABELS[m[1]] || 'карточки'}»`;
  m = /^export_patient_card_(\w+)/.exec(a);
  if (m) return `выгружена карточка пациента (${m[1]})`;
  return 'служебное действие';
}

const AI_EVENTS = {
  message: 'сообщение в чате', reply: 'ответ помощника', crisis: 'кризисная фраза в чате', provider_error: 'сбой ИИ-сервиса',
  contact_request: 'обращение «Связаться с человеком»', thread_deleted: 'диалог удалён',
  ws_bind_patient: 'диалог привязан к пациенту', ws_hint: 'открыта подсказка сценария', ws_material_add: 'добавлен материал',
  ws_material_delete: 'материал удалён', ws_material_download: 'материал скачан', ws_message: 'запрос врача', ws_open_thread: 'открыт диалог',
  ws_provider_error: 'сбой ИИ-сервиса', ws_reply: 'ответ ИИ-пространства', ws_thread_created: 'создан диалог', ws_thread_deleted: 'диалог удалён',
  ws_expired_purge: 'диалог удалён по сроку хранения', ws_export_message: 'экспорт ответа', ws_export_thread: 'экспорт диалога',
};
function aiEventLabel(code) {
  return AI_EVENTS[code] || 'служебное событие';
}

const INCIDENT_EVENTS = {
  created: 'создана', specialist_notified: 'врач уведомлён в сервисе', backup_notified: 'передано резервному специалисту',
  unresolved: 'нужен ручной разбор', acknowledged: 'подтверждена',
};
function incidentEventLabel(code) {
  return INCIDENT_EVENTS[code] || 'служебное событие';
}

/** D14: остатки технических кодов в сохранённых причинах («Tier 1: C») -> словарь. */
function cleanReason(text) {
  return String(text == null ? '' : text).replace(/\bTier\s*(\d)\b/g, (m, n) => tierLabel(n));
}

module.exports = { cleanReason, tierLabel, actionLabel, aiEventLabel, incidentEventLabel, TAB_LABELS };
