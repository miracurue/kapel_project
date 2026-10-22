'use strict';
// После отзыва базового согласия сервер сам заводит запрос на стирание (W-50, PD-12) и закрывает пациенту
// запись; через API согласие снова не дать. Регрессионные тесты В3 возвращают состояние напрямую в базе.
function restoreBaseConsent(app, userId) {
  app.exec(`DELETE FROM data_subject_requests WHERE patient_id=${Number(userId)}`);
  const last = app.query(
    "SELECT content_version_id,text_sha256,sign_method FROM consent_events WHERE user_id=? AND consent_kind='base' AND action='given' ORDER BY id DESC LIMIT 1",
    userId,
  )[0];
  app.exec(
    `INSERT INTO consent_events(user_id,consent_kind,action,content_version_id,text_sha256,sign_method) VALUES (${Number(userId)},'base','given',${Number(last.content_version_id)},'${last.text_sha256}','${last.sign_method}')`,
  );
}
module.exports = { restoreBaseConsent };
