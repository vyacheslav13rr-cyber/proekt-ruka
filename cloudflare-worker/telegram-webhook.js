// Вебхук-бот РУКА (Cloudflare Workers): мгновенная реакция на кнопки/сообщения.
// В отличие от .github/scripts/telegram-bot.mjs (опрос раз в 5 минут),
// этот воркер получает обновления от Telegram сразу, как только они происходят.
// Своей файловой системы или базы данных у воркера нет — все файлы
// читаются и пишутся прямо в этот репозиторий через GitHub Contents API.
//
// Нужные секреты воркера (Settings → Variables and Secrets в панели Cloudflare):
//   GH_TOKEN        — GitHub-токен с правом записи в этот репозиторий
//   BOT_TOKEN        — токен Telegram-бота (тот же, что в секретах GitHub)
//   CHANNEL_ID       — ID канала РУКА для публикации
//   OWNER_CHAT_ID    — твой личный числовой Telegram ID
//   WEBHOOK_SECRET   — придуманная тобой случайная строка, проверяется на каждый запрос

const GH_OWNER = 'vyacheslav13rr-cyber';
const GH_REPO = 'proekt-ruka';
const GH_BRANCH = 'main';
const GH_API = 'https://api.github.com';

const TOPICS_PATH = 'Телеграм/Темы для постинга в телеграм-канал РУКА.md';
const SCHEDULE_PATH = 'Телеграм/Расписание публикаций РУКА.md';
const STATE_PATH = '.github/state/telegram-bot-state.json';

// ---------- GitHub Contents API ----------

function ghHeaders(env, accept) {
  return {
    Authorization: `Bearer ${env.GH_TOKEN}`,
    'User-Agent': 'ruka-telegram-webhook',
    Accept: accept || 'application/vnd.github+json',
  };
}

function encodeBase64Utf8(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function decodeBase64Utf8(b64) {
  return decodeURIComponent(escape(atob(b64.replace(/\n/g, ''))));
}

async function ghGetFile(env, path) {
  const url = `${GH_API}/repos/${GH_OWNER}/${GH_REPO}/contents/${encodeURIComponent(path)}?ref=${GH_BRANCH}`;
  const res = await fetch(url, { headers: ghHeaders(env) });
  if (!res.ok) throw new Error(`GitHub GET ${path}: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return { content: decodeBase64Utf8(data.content), sha: data.sha };
}

async function ghPutFile(env, path, content, sha, message) {
  const url = `${GH_API}/repos/${GH_OWNER}/${GH_REPO}/contents/${encodeURIComponent(path)}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...ghHeaders(env), 'content-type': 'application/json' },
    body: JSON.stringify({
      message,
      content: encodeBase64Utf8(content),
      sha,
      branch: GH_BRANCH,
      committer: { name: 'ruka-telegram-bot', email: 'ruka-telegram-bot@users.noreply.github.com' },
    }),
  });
  if (!res.ok) throw new Error(`GitHub PUT ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function ghGetRawBytes(env, path) {
  const url = `${GH_API}/repos/${GH_OWNER}/${GH_REPO}/contents/${encodeURIComponent(path)}?ref=${GH_BRANCH}`;
  const res = await fetch(url, { headers: ghHeaders(env, 'application/vnd.github.raw') });
  if (!res.ok) throw new Error(`GitHub RAW GET ${path}: ${res.status}`);
  return res.arrayBuffer();
}

// ---------- Telegram API ----------

function tgApiUrl(env, method) {
  return `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;
}

async function tg(env, method, params = {}) {
  const res = await fetch(tgApiUrl(env, method), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!data.ok) console.error(`Telegram API ошибка (${method}):`, data);
  return data;
}

async function tgSendPhoto(env, chatId, imagePath, caption) {
  const bytes = await ghGetRawBytes(env, imagePath);
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', caption);
  form.append('photo', new Blob([bytes]), imagePath.split('/').pop());
  const res = await fetch(tgApiUrl(env, 'sendPhoto'), { method: 'POST', body: form });
  return res.json();
}

// ---------- Клавиатуры ----------

const kb = (rows) => ({ inline_keyboard: rows });
const btn = (text, data) => ({ text, callback_data: data });

// Единственный источник кнопок главного меню — добавить/убрать/переставить
// пункт достаточно поправить только этот массив, логику обработки трогать не нужно.
const MENU_BUTTONS = [
  { text: '📝 Новая тема', action: 'new_topic' },
  { text: '🆕 Создать пост', action: 'new_post' },
  { text: '📋 Темы', action: 'topics' },
  { text: '📅 Расписание', action: 'schedule' },
];

const BUTTONS_PER_ROW = 3;

function chunk(arr, size) {
  const rows = [];
  for (let i = 0; i < arr.length; i += size) rows.push(arr.slice(i, i + size));
  return rows;
}

// Главное меню — постоянная reply-клавиатура (не инлайн), сеткой по 3 кнопки в ряд.
function mainReplyKeyboard() {
  return {
    keyboard: chunk(MENU_BUTTONS.map((b) => ({ text: b.text })), BUTTONS_PER_ROW),
    resize_keyboard: true,
    is_persistent: false,
    one_time_keyboard: false,
  };
}

// Точное совпадение текста нажатой кнопки → действие из конфига выше.
function matchMenuButton(text) {
  const found = MENU_BUTTONS.find((b) => b.text === text);
  return found ? found.action : null;
}

// Убирает нативную кнопку «Меню» слева от поля ввода: список команд очищается,
// кнопка возвращается к обычному виду по умолчанию. Навигация теперь полностью
// через reply-клавиатуру снизу.
async function disableMenuButton(env) {
  await tg(env, 'deleteMyCommands');
  await tg(env, 'setChatMenuButton', { menu_button: { type: 'default' } });
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

function nextTopicId(md) {
  const ids = [...md.matchAll(/topic id=T-(\d+)/g)].map((m) => Number(m[1]));
  const n = ids.length ? Math.max(...ids) + 1 : 1;
  return `T-${String(n).padStart(4, '0')}`;
}

function appendReadyTopic(md, id, text) {
  const block = `<!-- topic id=${id} status=ready -->\n${text}\n<!-- /topic -->`;
  return replaceSection(md, 'Разобранные', (body) => body.replace(/\s+$/, '') + `\n\n${block}\n`);
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

// ---------- Загрузка/сохранение данных из репозитория ----------

async function loadDataCtx(env) {
  const [topics, schedule] = await Promise.all([ghGetFile(env, TOPICS_PATH), ghGetFile(env, SCHEDULE_PATH)]);
  return {
    env,
    topicsMd: topics.content,
    topicsSha: topics.sha,
    topicsChanged: false,
    scheduleMd: schedule.content,
    scheduleSha: schedule.sha,
    scheduleChanged: false,
  };
}

async function saveDataCtx(ctx) {
  const jobs = [];
  if (ctx.topicsChanged) jobs.push(ghPutFile(ctx.env, TOPICS_PATH, normalizeBlankLines(ctx.topicsMd), ctx.topicsSha, 'Бот: обновление тем'));
  if (ctx.scheduleChanged) jobs.push(ghPutFile(ctx.env, SCHEDULE_PATH, normalizeBlankLines(ctx.scheduleMd), ctx.scheduleSha, 'Бот: обновление расписания'));
  if (jobs.length) await Promise.all(jobs);
}

async function loadBotCtx(env) {
  const base = await loadDataCtx(env);
  let state = { sessions: {} };
  let stateSha = null;
  try {
    const stateFile = await ghGetFile(env, STATE_PATH);
    state = JSON.parse(stateFile.content);
    if (!state.sessions) state.sessions = {};
    stateSha = stateFile.sha;
  } catch (err) {
    console.error('Не удалось прочитать состояние диалога, начинаю с пустого', err);
  }
  return { ...base, state, stateSha, stateChanged: false };
}

async function saveBotCtx(ctx) {
  await saveDataCtx(ctx);
  if (ctx.stateChanged) {
    await ghPutFile(ctx.env, STATE_PATH, JSON.stringify(ctx.state, null, 2) + '\n', ctx.stateSha, 'Бот: обновление состояния диалога');
  }
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
    await tg(ctx.env, 'sendMessage', {
      chat_id: chatId,
      text: 'Тема не найдена (возможно уже опубликована).',
      reply_markup: mainReplyKeyboard(),
    });
    return;
  }
  const result = topic.image
    ? await tgSendPhoto(ctx.env, ctx.env.CHANNEL_ID, topic.image, topic.text)
    : await tg(ctx.env, 'sendMessage', { chat_id: ctx.env.CHANNEL_ID, text: topic.text });

  if (!result.ok) {
    await tg(ctx.env, 'sendMessage', {
      chat_id: chatId,
      text: `Не получилось опубликовать: ${result.description || 'ошибка Telegram API'}`,
      reply_markup: mainReplyKeyboard(),
    });
    return;
  }

  const dateStr = formatRuDateTime(new Date()).split(' ')[0];
  const moved = moveTopicToPublished(ctx.topicsMd, topicId, dateStr);
  if (moved.ok) {
    ctx.topicsMd = moved.md;
    ctx.topicsChanged = true;
  }
  ctx.scheduleMd = removeScheduleForTopic(ctx.scheduleMd, topicId).md;
  ctx.scheduleChanged = true;

  await tg(ctx.env, 'sendMessage', { chat_id: chatId, text: 'Опубликовано ✅', reply_markup: kb([[btn('🏠 В меню', 'menu:main')]]) });
}

// ---------- Напоминания по расписанию (запускается по крону) ----------

async function runReminders(env) {
  const ctx = await loadDataCtx(env);
  const now = new Date();
  for (const e of listSchedule(ctx.scheduleMd)) {
    if (e.notified) continue;
    const dt = parseRuDateTime(e.at);
    if (!dt || dt.getTime() > now.getTime()) continue;
    const topic = getReadyTopic(ctx.topicsMd, e.topic);
    const preview = topic ? truncate(topic.text, 80) : e.topic;
    await tg(env, 'sendMessage', {
      chat_id: env.OWNER_CHAT_ID,
      text: `⏰ Пора публиковать (${e.at}):\n${preview}`,
      reply_markup: kb([[btn('🚀 Опубликовать', `publish:confirm:${e.topic}`)], [btn('🏠 В меню', 'menu:main')]]),
    });
    ctx.scheduleMd = updateScheduleEntry(ctx.scheduleMd, e.id, { notified: true }).md;
    ctx.scheduleChanged = true;
  }
  await saveDataCtx(ctx);
}

// ---------- Обработка нажатий кнопок ----------

async function handleCallback(cq, ctx) {
  await tg(ctx.env, 'answerCallbackQuery', { callback_query_id: cq.id });
  const chatId = cq.message.chat.id;
  const messageId = cq.message.message_id;
  const data = cq.data || '';
  const send = async (text, keyboard) => {
    const r = await tg(ctx.env, 'editMessageText', { chat_id: chatId, message_id: messageId, text, reply_markup: keyboard });
    if (!r.ok) await tg(ctx.env, 'sendMessage', { chat_id: chatId, text, reply_markup: keyboard });
  };

  if (data === 'menu:main') {
    ctx.state.sessions[chatId] = { awaiting: null };
    ctx.stateChanged = true;
    return send('Главное меню — кнопки внизу 👇', kb([]));
  }

  if (data === 'menu:new_topic') {
    ctx.state.sessions[chatId] = { awaiting: 'new_topic' };
    ctx.stateChanged = true;
    return send('Пришли текст новой темы.', kb([[btn('🏠 В меню', 'menu:main')]]));
  }

  if (data === 'menu:new_post') {
    ctx.state.sessions[chatId] = { awaiting: 'new_post' };
    ctx.stateChanged = true;
    return send('Пришли готовый текст поста (можно в несколько строк).', kb([[btn('🏠 В меню', 'menu:main')]]));
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
    ctx.stateChanged = true;
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
    ctx.stateChanged = true;
    return send('Новая дата/время? Формат: 30.09.2026 19:00.', kb([[btn('🏠 В меню', 'menu:main')]]));
  }

  if (data.startsWith('schedule:delete:')) {
    const id = data.slice('schedule:delete:'.length);
    const del = deleteScheduleLine(ctx.scheduleMd, id);
    ctx.scheduleMd = del.md;
    ctx.scheduleChanged = true;
    const { text, keyboard } = renderScheduleList(ctx);
    return send(del.found ? `Удалено ✅\n\n${text}` : 'Запись уже отсутствовала.', keyboard);
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

  return send('Не понял действие.', kb([[btn('🏠 В меню', 'menu:main')]]));
}

// ---------- Обработка текстовых сообщений ----------

async function runMenuAction(action, chatId, ctx) {
  if (action === 'new_topic') {
    ctx.state.sessions[chatId] = { awaiting: 'new_topic' };
    ctx.stateChanged = true;
    return tg(ctx.env, 'sendMessage', { chat_id: chatId, text: 'Пришли текст новой темы.', reply_markup: mainReplyKeyboard() });
  }
  if (action === 'new_post') {
    ctx.state.sessions[chatId] = { awaiting: 'new_post' };
    ctx.stateChanged = true;
    return tg(ctx.env, 'sendMessage', {
      chat_id: chatId,
      text: 'Пришли готовый текст поста (можно в несколько строк).',
      reply_markup: mainReplyKeyboard(),
    });
  }
  if (action === 'topics') {
    return tg(ctx.env, 'sendMessage', {
      chat_id: chatId,
      text: 'Темы:',
      reply_markup: kb([
        [btn('🟡 Сырые', 'topics:raw')],
        [btn('🟢 Разобранные', 'topics:ready')],
        [btn('✅ Опубликованные', 'topics:published')],
      ]),
    });
  }
  if (action === 'schedule') {
    const { text, keyboard } = renderScheduleList(ctx);
    return tg(ctx.env, 'sendMessage', { chat_id: chatId, text, reply_markup: keyboard });
  }
}

async function handleMessage(msg, ctx) {
  const chatId = msg.chat.id;
  const session = ctx.state.sessions[chatId] || { awaiting: null };
  const text = (msg.text || '').trim();

  if (text === '/start') {
    ctx.state.sessions[chatId] = { awaiting: null };
    ctx.stateChanged = true;
    await disableMenuButton(ctx.env);
    await tg(ctx.env, 'sendMessage', { chat_id: chatId, text: 'Главное меню — кнопки внизу 👇', reply_markup: mainReplyKeyboard() });
    return;
  }

  const menuAction = matchMenuButton(text);
  if (menuAction) {
    ctx.state.sessions[chatId] = { awaiting: null };
    ctx.stateChanged = true;
    await runMenuAction(menuAction, chatId, ctx);
    return;
  }

  if (session.awaiting === 'new_topic') {
    if (!text) {
      await tg(ctx.env, 'sendMessage', { chat_id: chatId, text: 'Пришли текст темы.', reply_markup: mainReplyKeyboard() });
      return;
    }
    const topicText = text.replace(/\s*\n+\s*/g, ' ').trim();
    ctx.topicsMd = appendRawTopic(ctx.topicsMd, topicText);
    ctx.topicsChanged = true;
    ctx.state.sessions[chatId] = { awaiting: null };
    ctx.stateChanged = true;
    await tg(ctx.env, 'sendMessage', {
      chat_id: chatId,
      text: `Тема добавлена ✅\n«${topicText}»`,
      reply_markup: kb([[btn('➕ Ещё одна', 'menu:new_topic')], [btn('🏠 В меню', 'menu:main')]]),
    });
    return;
  }

  if (session.awaiting === 'new_post') {
    if (!text) {
      await tg(ctx.env, 'sendMessage', { chat_id: chatId, text: 'Пришли текст поста.', reply_markup: mainReplyKeyboard() });
      return;
    }
    const id = nextTopicId(ctx.topicsMd);
    ctx.topicsMd = appendReadyTopic(ctx.topicsMd, id, text);
    ctx.topicsChanged = true;
    ctx.state.sessions[chatId] = { awaiting: null };
    ctx.stateChanged = true;
    await tg(ctx.env, 'sendMessage', {
      chat_id: chatId,
      text: `Пост добавлен как ${id} ✅\n\n${text}`,
      reply_markup: kb([
        [btn('🚀 Опубликовать', `publish:confirm:${id}`)],
        [btn('📅 В расписание', `schedule:pick:${id}`)],
        [btn('🏠 В меню', 'menu:main')],
      ]),
    });
    return;
  }

  if (session.awaiting === 'schedule_datetime') {
    const dt = parseRuDateTime(text);
    if (!dt) {
      await tg(ctx.env, 'sendMessage', {
        chat_id: chatId,
        text: 'Не понял дату/время. Формат: 30.09.2026 19:00. Пришли ещё раз.',
        reply_markup: mainReplyKeyboard(),
      });
      return;
    }
    const { topicId } = session.payload;
    const { md, id } = addScheduleLine(ctx.scheduleMd, topicId, text);
    ctx.scheduleMd = md;
    ctx.scheduleChanged = true;
    ctx.state.sessions[chatId] = { awaiting: null };
    ctx.stateChanged = true;
    await tg(ctx.env, 'sendMessage', {
      chat_id: chatId,
      text: `Запланировано ✅\n${text} — ${topicId} (${id})`,
      reply_markup: kb([[btn('🏠 В меню', 'menu:main')]]),
    });
    return;
  }

  if (session.awaiting === 'schedule_edit_datetime') {
    const dt = parseRuDateTime(text);
    if (!dt) {
      await tg(ctx.env, 'sendMessage', {
        chat_id: chatId,
        text: 'Не понял дату/время. Формат: 30.09.2026 19:00. Пришли ещё раз.',
        reply_markup: mainReplyKeyboard(),
      });
      return;
    }
    const { scheduleId } = session.payload;
    const { md, found } = updateScheduleEntry(ctx.scheduleMd, scheduleId, { at: text, notified: false });
    ctx.scheduleMd = md;
    ctx.scheduleChanged = true;
    ctx.state.sessions[chatId] = { awaiting: null };
    ctx.stateChanged = true;
    await tg(ctx.env, 'sendMessage', {
      chat_id: chatId,
      text: found ? `Дата обновлена ✅\n${text}` : 'Запись не найдена, возможно уже удалена.',
      reply_markup: kb([[btn('🏠 В меню', 'menu:main')]]),
    });
    return;
  }

  await tg(ctx.env, 'sendMessage', { chat_id: chatId, text: 'Не понял. Выбери кнопку внизу 👇', reply_markup: mainReplyKeyboard() });
}

// ---------- Точка входа воркера ----------

async function handleUpdate(update, env) {
  const from = update.message?.from || update.callback_query?.from;
  if (!from || String(from.id) !== String(env.OWNER_CHAT_ID)) return;

  const ctx = await loadBotCtx(env);
  if (update.callback_query) await handleCallback(update.callback_query, ctx);
  else if (update.message) await handleMessage(update.message, ctx);
  await saveBotCtx(ctx);
}

export default {
  async fetch(request, env, execCtx) {
    if (request.method === 'GET') return new Response('РУКА bot webhook OK');
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });

    const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
    if (!env.WEBHOOK_SECRET || secret !== env.WEBHOOK_SECRET) {
      return new Response('forbidden', { status: 403 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response('bad request', { status: 400 });
    }

    execCtx.waitUntil(handleUpdate(update, env).catch((err) => console.error('handleUpdate error', err)));
    return new Response('ok');
  },

  async scheduled(event, env, execCtx) {
    execCtx.waitUntil(runReminders(env).catch((err) => console.error('runReminders error', err)));
  },
};
