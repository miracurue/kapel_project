'use strict';

// W-38: точка входа модуля очереди запросов администратора.
// install(app, deps) монтирует маршруты и возвращает экземпляр службы
// (для планировщика F-21: service.returnExpiredToQueue()).

const { QueueService } = require('./queueService');
const routes = require('./routes');

module.exports = { QueueService, install: routes.install };
