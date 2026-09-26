// Бот РУКА: приём тем в Telegram и управление расписанием публикаций.
// Работает без постоянного сервера — запускается по расписанию GitHub Actions,
// один раз опрашивает Telegram (getUpdates), обрабатывает накопленные
// сообщения/нажатия кнопок и сохраняет изменения в файлы репозитория.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const TOPICS_FILE = 'Телеграм/Темы для постинга в телеграм-канал РУКА.md';
const SCHEDULE_FILE = 'Телеграм/Расписание публикаций РУКА.md';
const STATE_FILE = '.github/state/telegram-bot-state.json';

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;
const CHANNEL_ID = process.env.CHANNEL_ID;
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ---------- Telegram API ----------

async function tg(method, params = {}) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!data.ok) console.error(`Telegram API ошибка (${method}):`, data);
  return data;
}

async function tgSendPhoto(chatId, imagePath, caption) {
  const buf = await readFile(imagePath);
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', caption);
  form.append('photo', new Blob([buf]), path.basename(imagePath));
  const res = await fetch(`${API}/sendPhoto`, { method: 'POST', body: form });
  return res.json();
}

async function sendOrEdit(chatId, messageId, text, keyboard) {
  if (messageId) {
    const r = await tg('editMessageText', { chat_id: chatId, message_id: messageId, text, reply_markup: keyboard });
    if (r.ok) return;
  }
  await tg('sendMessage', { chat_id: chatId, text, reply_markup: keyboard });
}

// ---------- Клавиатуры ----------

const kb = (rows) => ({ inline_keyboard: rows });
const btn = (text, data) => ({ text, callback_data: data });

function mainMenuKeyboard() {
  return kb([
    [btn('📝 Новая тема', 'menu:new_topic')],
    [btn('📋 Темы', 'menu:topics')],
    [btn('📅 Расписание', 'menu:schedule')],
    [btn('🚀 Опубликовать', 'menu:publish')],
  ]);
}

function truncate(str, n) {
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

// ---------- Файл тем: разбор и правка секций ----------

function getSectionBody(md, name) {
  const heading = `## ${name}`;
  const start = md.indexOf(heading);
  if (start === -1) return '';
  const bodyStart = start + heading.length;
  const next = md.indexOf('\n## ', bodyStart);
  return next === -1 ? md.slice(bodyStart) : md.slice(bodyStart, next);
}

function replaceSection(md, name, transform) {
  const heading = `## ${name}`;
  const start = md.indexOf(heading);
  if (start === -1) throw new Error(`Раздел не найден: ${name}`);
  const bodyStart = start + heading.length;
  const next = md.indexOf('\n## ', bodyStart);
  const bodyEnd = next === -1 ? md.length : next;
  const body = md.slice(bodyStart, bodyEnd);
  return md.slice(0, bodyStart) + transform(body) + md.slice(bodyEnd);
}

function normalizeBlankLines(md) {
  return md.replace(/\n{3,}/g, '\n\n');
}

function appendRawTopic(md, text) {
  return replaceSection(md, 'Сырые темы', (body) => body.replace(/\s+$/, '') + `\n- ${text}\n`);
}

function listRawTopics(md) {
  const body = getSectionBody(md, 'Сырые темы');
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim());
}

function topicBlockRegex() {
  return /<!--\s*topic\s+id=(\S+?)\s+status=(\S+?)(?:\s+date=(\S+?))?\s*-->\n([\s\S]*?)\n<!--\s*\/topic\s*-->/g;
}

function parseTopicBlocks(body) {
  const out = [];
  const re = topicBlockRegex();
  let m;
  while ((m = re.exec(body))) {
    const [full, id, status, date, content] = m;
    let image = null;
    let text = content;
    const imgMatch = /\nКартинка:\s*(.+?)\s*$/m.exec(content);
    if (imgMatch) {
      image = imgMatch[1].trim();
      text = content.slice(0, imgMatch.index).trim();
    } else {
      text = content.trim();
    }
    out.push({ id, status, date: date || null, text, image, full });
  }
  return out;
}

function listReadyTopics(md) {
  return parseTopicBlocks(getSectionBody(md, 'Разобранные'));
}

function getReadyTopic(md, id) {
  return listReadyTopics(md).find((t) => t.id === id) || null;
}

function moveTopicToPublished(md, id, dateStr) {
  let removedContent = null;
  md = replaceSection(md, 'Разобранные', (body) =>
    body.replace(topicBlockRegex(), (full, bid, status, date, content) => {
      if (bid === id) {
        removedContent = content;
        return '';
      }
      return full;
    })
  );
  if (removedContent == null) return { md: null, ok: false };
  const block = `<!-- topic id=${id} status=published date=${dateStr} -->\n${removedContent}\n<!-- /topic -->`;
  md = replaceSection(md, 'Опубликованные', (body) => body.replace(/\s+$/, '') + `\n\n${block}\n`);
  return { md: normalizeBlankLines(md), ok: true };
}

// ---------- Файл расписания ----------

function scheduleLineRegex() {
  return /^- <!-- schedule id=(\S+) topic=(\S+) at=(\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}) notified=(true|false) -->.*$/gm;
}

function listSchedule(md) {
  const body = getSectionBody(md, 'Запланировано');
  const out = [];
  const re = scheduleLineRegex();
  let m;
  while ((m = re.exec(body))) {
    out.push({ id: m[1], topic: m[2], at: m[3], notified: m[4] === 'true' });
  }
  return out.sort((a, b) => parseRuDateTime(a.at) - parseRuDateTime(b.at));
}

function nextScheduleId(md) {
  const ids = [...md.matchAll(/schedule id=S-(\d+)/g)].map((m) => Number(m[1]));
  const n = ids.length ? Math.max(...ids) + 1 : 1;
  return `S-${String(n).padStart(4, '0')}`;
}

function scheduleLine(id, topicId, at, notified) {
  return `- <!-- schedule id=${id} topic=${topicId} at=${at} notified=${notified} --> ${at} — ${topicId}`;
}

function addScheduleLine(md, topicId, at) {
  const id = nextScheduleId(md);
  md = replaceSection(md, 'Запланировано', (body) => body.replace(/\s+$/, '') + `\n${scheduleLine(id, topicId, at, false)}\n`);
  return { md: normalizeBlankLines(md), id };
}

function updateScheduleEntry(md, id, patch) {
  let found = false;
  md = replaceSection(md, 'Запланировано', (body) =>
    body
      .split('\n')
      .map((line) => {
        const m = /^- <!-- schedule id=(\S+) topic=(\S+) at=(\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}) notified=(true|false) -->/.exec(line);
        if (m && m[1] === id) {
          found = true;
          const entry = { id: m[1], topic: m[2], at: m[3], notified: m[4] === 'true', ...patch };
          return scheduleLine(entry.id, entry.topic, entry.at, entry.notified);
        }
        return line;
      })
      .join('\n')
  );
  return { md: normalizeBlankLines(md), found };
}

function deleteScheduleLine(md, id) {
  let found = false;
  md = replaceSection(md, 'Запланировано', (body) =>
    body
      .split('\n')
      .filter((line) => {
        const m = /^- <!-- schedule id=(\S+) /.exec(line);
        if (m && m[1] === id) {
          found = true;
          return false;
        }
        return true;
      })
      .join('\n')
  );
  return { md: normalizeBlankLines(md), found };
}

function removeScheduleForTopic(md, topicId) {
  md = replaceSection(md, 'Запланировано', (body) =>
    body
      .split('\n')
      .filter((line) => {
        const m = /^- <!-- schedule id=\S+ topic=(\S+) /.exec(line);
        return !(m && m[1] === topicId);
      })
      .join('\n')
  );
  return { md: normalizeBlankLines(md) };
}

// ---------- Дата/время (московское, UTC+3, без перехода на летнее) ----------

function parseRuDateTime(str) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})$/.exec(str.trim());
  if (!m) return null;
  const [, dd, mm, yyyy, hh, mi] = m;
  return new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh) - 3, Number(mi)));
}

function formatRuDateTime(date) {
  const d = new Date(date.getTime() + 3 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

// ---------- Состояние между запусками ----------

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8'));
  } catch {
    return { offset: 0, sessions: {} };
  }
}

async function saveState(state) {
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

// ---------- Экраны-списки ----------

function renderReadyTopicsList(ctx, prefix) {
  const topics = listReadyTopics(ctx.topicsMd);
  if (!topics.length) {
    return { text: 'В «Разобранных» пока пусто.', keyboard: kb([[btn('🏠 В меню', 'menu:main')]]) };
  }
  const rows = topics.slice(0, 15).map((t) => [btn(`${t.id} — ${truncate(t.text, 40)}`, `${prefix}:${t.id}`)]);
  rows.push([btn('🏠 В меню', 'menu:main')]);
  return { text: 'Выбери тему:', keyboard: kb(rows) };
}

function renderScheduleList(ctx) {
  const entries = listSchedule(ctx.scheduleMd);
  if (!entries.length) {
    return { text: 'Расписание пусто.', keyboard: kb([[btn('➕ Добавить', 'menu:new_schedule_pick')], [btn('🏠 В меню', 'menu:main')]]) };
  }
  const rows = entries.slice(0, 15).map((e) => [btn(`${e.at} — ${e.topic}`, `schedule:select:${e.id}`)]);
  rows.push([btn('➕ Добавить', 'menu:new_schedule_pick')]);
  rows.push([btn('🏠 В меню', 'menu:main')]);
  return { text: 'Запланированные публикации:', keyboard: kb(rows) };
}

// ---------- Публикация ----------

async function publishTopic(ctx, chatId, topicId) {
  const topic = getReadyTopic(ctx.topicsMd, topicId);
  if (!topic) {
    await tg('sendMessage', { chat_id: chatId, text: 'Тема не найдена (возможно уже опубликована).' });
    return;
  }
  const result = topic.image
    ? await tgSendPhoto(CHANNEL_ID, topic.image, topic.text)
    : await tg('sendMessage', { chat_id: CHANNEL_ID, text: topic.text });

  if (!result.ok) {
    await tg('sendMessage', { chat_id: chatId, text: `Не получилось опубликовать: ${result.description || 'ошибка Telegram API'}` });
    return;
  }

  const dateStr = formatRuDateTime(new Date()).split(' ')[0];
  const moved = moveTopicToPublished(ctx.topicsMd, topicId, dateStr);
  if (moved.ok) {
    ctx.topicsMd = moved.md;
    ctx.changed.add('topics');
  }
  ctx.scheduleMd = removeScheduleForTopic(ctx.scheduleMd, topicId).md;
  ctx.changed.add('schedule');

  await tg('sendMessage', { chat_id: chatId, text: 'Опубликовано ✅', reply_markup: kb([[btn('🏠 В меню', 'menu:main')]]) });
}

// ---------- Напоминания по расписанию ----------

async function checkReminders(ctx) {
  const now = new Date();
  for (const e of listSchedule(ctx.scheduleMd)) {
    if (e.notified) continue;
    const dt = parseRuDateTime(e.at);
    if (!dt || dt.getTime() > now.getTime()) continue;
    const topic = getReadyTopic(ctx.topicsMd, e.topic);
    const preview = topic ? truncate(topic.text, 80) : e.topic;
    await tg('sendMessage', {
      chat_id: OWNER_CHAT_ID,
      text: `⏰ Пора публиковать (${e.at}):\n${preview}`,
      reply_markup: kb([[btn('🚀 Опубликовать', `publish:confirm:${e.topic}`)], [btn('🏠 В меню', 'menu:main')]]),
    });
    ctx.scheduleMd = updateScheduleEntry(ctx.scheduleMd, e.id, { notified: true }).md;
    ctx.changed.add('schedule');
  }
}

// ---------- Обработка нажатий кнопок ----------

async function handleCallback(cq, ctx) {
  await tg('answerCallbackQuery', { callback_query_id: cq.id });
  const chatId = cq.message.chat.id;
  const messageId = cq.message.message_id;
  const data = cq.data || '';
  const send = (text, keyboard) => sendOrEdit(chatId, messageId, text, keyboard);

  if (data === 'menu:main') {
    ctx.state.sessions[chatId] = { awaiting: null };
    return send('Главное меню:', mainMenuKeyboard());
  }

  if (data === 'menu:new_topic') {
    ctx.state.sessions[chatId] = { awaiting: 'new_topic' };
    return send('Пришли текст новой темы одной строкой.', kb([[btn('🏠 В меню', 'menu:main')]]));
  }

  if (data === 'menu:topics') {
    return send('Темы:', kb([
      [btn('🟡 Сырые', 'topics:raw')],
      [btn('🟢 Разобранные', 'topics:ready')],
      [btn('✅ Опубликованные', 'topics:published')],
      [btn('🏠 В меню', 'menu:main')],
    ]));
  }

  if (data === 'topics:raw') {
    const list = listRawTopics(ctx.topicsMd);
    const text = list.length ? `Сырые темы:\n${list.map((t, i) => `${i + 1}. ${t}`).join('\n')}` : 'Сырых тем пока нет.';
    return send(text, kb([[btn('⬅️ Назад', 'menu:topics')], [btn('🏠 В меню', 'menu:main')]]));
  }

  if (data === 'topics:ready') {
    const { text, keyboard } = renderReadyTopicsList(ctx, 'topic:select');
    return send(text, keyboard);
  }

  if (data === 'topics:published') {
    const list = parseTopicBlocks(getSectionBody(ctx.topicsMd, 'Опубликованные'));
    const text = list.length
      ? `Опубликованные:\n${list.map((t) => `${t.date || '—'} — ${truncate(t.text, 50)}`).join('\n')}`
      : 'Пока ничего не опубликовано.';
    return send(text, kb([[btn('⬅️ Назад', 'menu:topics')], [btn('🏠 В меню', 'menu:main')]]));
  }

  if (data.startsWith('topic:select:')) {
    const id = data.slice('topic:select:'.length);
    const topic = getReadyTopic(ctx.topicsMd, id);
    if (!topic) return send('Тема не найдена.', kb([[btn('🏠 В меню', 'menu:main')]]));
    const text = `${id}\n\n${topic.text}${topic.image ? `\n\n🖼 ${topic.image}` : ''}`;
    return send(text, kb([
      [btn('📅 В расписание', `schedule:pick:${id}`)],
      [btn('🚀 Опубликовать сейчас', `publish:confirm:${id}`)],
      [btn('⬅️ Назад', 'topics:ready')],
      [btn('🏠 В меню', 'menu:main')],
    ]));
  }

  if (data === 'menu:schedule') {
    const { text, keyboard } = renderScheduleList(ctx);
    return send(text, keyboard);
  }

  if (data === 'menu:new_schedule_pick') {
    const { text, keyboard } = renderReadyTopicsList(ctx, 'schedule:pick');
    return send(text, keyboard);
  }

  if (data.startsWith('schedule:pick:')) {
    const topicId = data.slice('schedule:pick:'.length);
    ctx.state.sessions[chatId] = { awaiting: 'schedule_datetime', payload: { topicId } };
    return send('Когда опубликовать? Формат: 30.09.2026 19:00 (время московское).', kb([[btn('🏠 В меню', 'menu:main')]]));
  }

  if (data.startsWith('schedule:select:')) {
    const id = data.slice('schedule:select:'.length);
    const entry = listSchedule(ctx.scheduleMd).find((e) => e.id === id);
    if (!entry) return send('Запись не найдена.', kb([[btn('🏠 В меню', 'menu:main')]]));
    const topic = getReadyTopic(ctx.topicsMd, entry.topic);
    const text = `${entry.at}\nТема: ${entry.topic}${topic ? `\n${truncate(topic.text, 200)}` : ''}`;
    return send(text, kb([
      [btn('✏️ Изменить дату/время', `schedule:edit:${id}`)],
      [btn('🚀 Опубликовать', `publish:confirm:${entry.topic}`)],
      [btn('🗑 Удалить', `schedule:delete:${id}`)],
      [btn('⬅️ Назад', 'menu:schedule')],
      [btn('🏠 В меню', 'menu:main')],
    ]));
  }

  if (data.startsWith('schedule:edit:')) {
    const id = data.slice('schedule:edit:'.length);
    ctx.state.sessions[chatId] = { awaiting: 'schedule_edit_datetime', payload: { scheduleId: id } };
    return send('Новая дата/время? Формат: 30.09.2026 19:00.', kb([[btn('🏠 В меню', 'menu:main')]]));
  }

  if (data.startsWith('schedule:delete:')) {
    const id = data.slice('schedule:delete:'.length);
    const del = deleteScheduleLine(ctx.scheduleMd, id);
    ctx.scheduleMd = del.md;
    ctx.changed.add('schedule');
    const { text, keyboard } = renderScheduleList(ctx);
    return send(del.found ? `Удалено ✅\n\n${text}` : 'Запись уже отсутствовала.', keyboard);
  }

  if (data === 'menu:publish') {
    const { text, keyboard } = renderReadyTopicsList(ctx, 'publish:confirm');
    return send(text, keyboard);
  }

  if (data.startsWith('publish:confirm:')) {
    const id = data.slice('publish:confirm:'.length);
    const topic = getReadyTopic(ctx.topicsMd, id);
    if (!topic) return send('Тема не найдена (возможно уже опубликована).', kb([[btn('🏠 В меню', 'menu:main')]]));
    const text = `Опубликовать в канал?\n\n${topic.text}${topic.image ? `\n\n🖼 ${topic.image}` : ''}`;
    return send(text, kb([
      [btn('✅ Отправить', `publish:send:${id}`)],
      [btn('❌ Отмена', 'menu:main')],
    ]));
  }

  if (data.startsWith('publish:send:')) {
    const id = data.slice('publish:send:'.length);
    return publishTopic(ctx, chatId, id);
  }

  return send('Не понял действие.', mainMenuKeyboard());
}

// ---------- Обработка текстовых сообщений ----------

async function handleMessage(msg, ctx) {
  const chatId = msg.chat.id;
  const session = ctx.state.sessions[chatId] || { awaiting: null };
  const text = (msg.text || '').trim();

  if (text === '/start') {
    await sendOrEdit(chatId, null, 'Главное меню:', mainMenuKeyboard());
    return;
  }

  if (session.awaiting === 'new_topic') {
    if (!text) {
      await tg('sendMessage', { chat_id: chatId, text: 'Пришли текст темы одной строкой.' });
      return;
    }
    ctx.topicsMd = appendRawTopic(ctx.topicsMd, text);
    ctx.changed.add('topics');
    ctx.state.sessions[chatId] = { awaiting: null };
    await tg('sendMessage', {
      chat_id: chatId,
      text: `Тема добавлена ✅\n«${text}»`,
      reply_markup: kb([[btn('➕ Ещё одна', 'menu:new_topic')], [btn('🏠 В меню', 'menu:main')]]),
    });
    return;
  }

  if (session.awaiting === 'schedule_datetime') {
    const dt = parseRuDateTime(text);
    if (!dt) {
      await tg('sendMessage', { chat_id: chatId, text: 'Не понял дату/время. Формат: 30.09.2026 19:00. Пришли ещё раз.' });
      return;
    }
    const { topicId } = session.payload;
    const { md, id } = addScheduleLine(ctx.scheduleMd, topicId, text);
    ctx.scheduleMd = md;
    ctx.changed.add('schedule');
    ctx.state.sessions[chatId] = { awaiting: null };
    await tg('sendMessage', {
      chat_id: chatId,
      text: `Запланировано ✅\n${text} — ${topicId} (${id})`,
      reply_markup: kb([[btn('🏠 В меню', 'menu:main')]]),
    });
    return;
  }

  if (session.awaiting === 'schedule_edit_datetime') {
    const dt = parseRuDateTime(text);
    if (!dt) {
      await tg('sendMessage', { chat_id: chatId, text: 'Не понял дату/время. Формат: 30.09.2026 19:00. Пришли ещё раз.' });
      return;
    }
    const { scheduleId } = session.payload;
    const { md, found } = updateScheduleEntry(ctx.scheduleMd, scheduleId, { at: text, notified: false });
    ctx.scheduleMd = md;
    ctx.changed.add('schedule');
    ctx.state.sessions[chatId] = { awaiting: null };
    await tg('sendMessage', {
      chat_id: chatId,
      text: found ? `Дата обновлена ✅\n${text}` : 'Запись не найдена, возможно уже удалена.',
      reply_markup: kb([[btn('🏠 В меню', 'menu:main')]]),
    });
    return;
  }

  await sendOrEdit(chatId, null, 'Главное меню:', mainMenuKeyboard());
}

// ---------- Точка входа ----------

async function main() {
  if (!BOT_TOKEN || !OWNER_CHAT_ID || !CHANNEL_ID) {
    console.error('Не заданы переменные окружения BOT_TOKEN / OWNER_CHAT_ID / CHANNEL_ID');
    process.exitCode = 1;
    return;
  }

  const state = await loadState();
  const ctx = {
    topicsMd: await readFile(TOPICS_FILE, 'utf8'),
    scheduleMd: await readFile(SCHEDULE_FILE, 'utf8'),
    state,
    changed: new Set(),
  };

  const updatesRes = await tg('getUpdates', { offset: state.offset, timeout: 0, allowed_updates: ['message', 'callback_query'] });
  const updates = updatesRes.ok ? updatesRes.result : [];

  for (const upd of updates) {
    state.offset = upd.update_id + 1;
    try {
      const from = upd.message?.from || upd.callback_query?.from;
      if (!from || String(from.id) !== String(OWNER_CHAT_ID)) continue;
      if (upd.callback_query) await handleCallback(upd.callback_query, ctx);
      else if (upd.message) await handleMessage(upd.message, ctx);
    } catch (err) {
      console.error('Ошибка обработки обновления', upd.update_id, err);
    }
  }

  await checkReminders(ctx);

  if (ctx.changed.has('topics')) await writeFile(TOPICS_FILE, normalizeBlankLines(ctx.topicsMd), 'utf8');
  if (ctx.changed.has('schedule')) await writeFile(SCHEDULE_FILE, normalizeBlankLines(ctx.scheduleMd), 'utf8');
  await saveState(ctx.state);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
