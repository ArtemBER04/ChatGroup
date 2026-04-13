# ChatGroup (учебный SPA + API)

Фронтенд на чистом HTML/CSS/JS. **Чаты и сообщения** идут на backend **http://localhost:3000** (REST + Socket.IO). В браузере в **localStorage** остаются только JWT, данные пользователя для UI, профиль «О себе» и настройки интерфейса.

## Запуск

1. Поднимите сервер (папка `server/`): `npm install` и `npm start` (порт 3000).
2. Откройте фронт: файл `index.html` или локальный сервер, например `python -m http.server 8080` и страница `http://localhost:8080` — так надёжнее для `fetch` и Socket.IO.

## Файлы

| Путь | Назначение |
|------|------------|
| `index.html`, `styles.css`, `app.js` | Клиент ChatGroup |
| `server/` | Node.js API (см. `server/README.md`) |

## Примечание

Пароли на сервере хешируются (bcrypt). Не публикуйте `JWT_SECRET` и не коммитьте `.env` с секретами.
