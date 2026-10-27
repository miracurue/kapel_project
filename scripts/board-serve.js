#!/usr/bin/env node
'use strict';
// Локальный сервер доски: http://localhost:3399 — при каждом запросе перегенерирует доску.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PORT = Number(process.env.BOARD_PORT || 3399);
http.createServer((req, res) => {
  try {
    execFileSync('node', [path.join(__dirname, 'board-html.js')], { stdio: 'ignore' });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(path.join(__dirname, '..', '.agents', 'board.html')));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('board error: ' + e.message);
  }
}).listen(PORT, '127.0.0.1', () => console.log('board on http://localhost:' + PORT));
