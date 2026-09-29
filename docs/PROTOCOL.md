# Протокол Stoat P2P (версия 1)

Спецификация того, что узлы хранят и чем обмениваются. Эталонная реализация: [`src/core/event.ts`](../src/core/event.ts),
[`src/state`](../src/state), [`src/p2p`](../src/p2p).

## 1. Событие

```jsonc
{
  "v": 1,
  "id": "5f1c…",            // sha256 (hex) канонического JSON всех полей, кроме id и sig
  "scope": "server:01J…",   // к чему относится событие (раздел 2)
  "type": "message.send",   // тип (раздел 3)
  "author": "01J…",         // ID пользователя (ULID)
  "key": "Qk3…",            // Ed25519 публичный ключ автора, base64url, 32 байта
  "ts": 1727600000000,      // часы автора, мс
  "deps": ["a1…", "b2…"],   // id событий, которые видел автор (отсортированы, ≤ 64)
  "body": { … },            // данные типа, ≤ 48 КиБ в каноническом виде
  "sig": "…"                // Ed25519 подпись байтов id, base64url
}
```

**Канонический JSON** — ключи объектов отсортированы, без пробелов, поля со значением `undefined` отсутствуют.

Событие **структурно валидно**, если: все поля на месте и других нет; `id` совпадает с хешем; `key` соответствует
`author` (раздел 4); подпись верна; `ts` не больше чем на 10 минут в будущем; `deps` — отсортированные уникальные
hex‑хеши. Все `deps` должны принадлежать тому же scope. Событие принимается только после всех своих `deps`.

## 2. Области (scopes)

| scope | Содержимое | Кто может писать | Кому узел отдаёт |
| --- | --- | --- | --- |
| `user:<user>` | профиль | только сам пользователь | всем |
| `server:<server>` | состояние сервера и сообщения | участники (и `member.join` по приглашению) | узлам, представляющим участника, или предъявившим приглашение |
| `dm:<a>:<b>` (`a < b`) | ЛС и отношения пары | `a` и `b` | узлам, представляющим `a` или `b` |
| `saved:<user>` | «Сохранённые заметки» | пользователь | никому (только локально) |

## 3. Типы событий

### Профиль (`user:*`)

`user.profile` — полный снимок профиля, выигрывает последний по `(ts, id)`:
`username` (2–32, буквы, цифры, `_ . -`), `display_name?`, `avatar?` (File), `status? {text, presence}`,
`profile? {content, background?}`, `pronouns?`, `x25519` (ключ для шифрования ЛС), `nodes` (адреса домашних узлов).

### Состояние сервера (`server:*`, участвуют в DAG)

| Тип | Тело | Условие применения |
| --- | --- | --- |
| `server.create` | `nonce, name, description?, nsfw?, channels?, system_messages?` | первое событие; `server = ULID(ts, sha256(key, nonce))` |
| `server.update` | `name?, description?, icon?, banner?, categories?, system_messages?, nsfw?, owner?, remove?[]` | `ManageServer`; категории — `ManageChannel`; `owner` — только владелец |
| `server.delete` | — | владелец |
| `server.permissions` | `role: "default" \| roleId`, `permissions` | `ManagePermissions`; ранг роли ниже своего; менять можно только имеющиеся у себя биты |
| `channel.create` | `type: Text \| Voice, name, description?, nsfw?` | `ManageChannel` |
| `channel.update` | `channel, name?, description?, icon?, nsfw?, slowmode?, remove?[]` | `ManageChannel` в канале |
| `channel.delete` | `channel` | `ManageChannel` в канале |
| `channel.permissions` | `channel, role: "default" \| roleId, permissions {allow, deny}` | `ManagePermissions` в канале, ранг, свои биты |
| `role.create` | `name, rank?` | `ManageRole` |
| `role.update` | `role, name?, colour?, hoist?, rank?, icon?, remove?[]` | `ManageRole`, роль ниже своей |
| `role.delete` | `role` | `ManageRole`, роль ниже своей |
| `role.ranks` | `ranks: roleId[]` | `ManageRole`; роли не ниже своей остаются на месте |
| `member.join` | `invite` | не участник, не забанен, код существует |
| `member.leave` | — | участник, не владелец |
| `member.kick` | `user` | `KickMembers`, цель ниже по рангу |
| `member.edit` | `user, nickname?, avatar?, pronouns?, roles?, timeout?, remove?[]` | свои: `ChangeNickname`/`ChangeAvatar`; чужие: `ManageNicknames`/`RemoveAvatars`/`AssignRoles`/`TimeoutMembers` и ранг |
| `ban.create` | `user, reason?` | `BanMembers`, ранг |
| `ban.remove` | `user` | `BanMembers` |
| `invite.create` | `channel` | `InviteOthers` в канале |
| `invite.delete` | `code` | автор приглашения или `ManageServer` |
| `emoji.create` | `name, file` | `ManageCustomisation` |
| `emoji.delete` | `emoji` | автор или `ManageCustomisation` |

**Порядок и свёртка.** `depth(e) = 1 + max(depth(d))` по `deps` из этого же сервера (0 для `server.create`).
События сортируются по `(depth, ts, id)` и применяются по очереди к пустому состоянию; права вычисляются по
состоянию *перед* событием, а «сейчас» для тайм‑аутов — это `ts` события. Неприменимое событие хранится и
пересылается, но ничего не меняет. Системные сообщения (`user_joined`, `user_left`, `user_kicked`,
`user_banned`) порождаются свёрткой детерминированно, их ID — ID события.

### Сообщения (`server:*`, `dm:*`, `saved:*`)

| Тип | Тело | Условие |
| --- | --- | --- |
| `message.send` | `channel, content?, attachments?, replies?[{id, mention}], embeds?, masquerade?, interactions?, nonce?, flags?` | автор был участником на позиции своих `deps`; сейчас имеет `SendMessage` (и `UploadFiles`/`SendEmbeds`/`Masquerade` при необходимости) |
| `message.edit` | `message, content?, embeds?` | автор исходного сообщения; `deps` содержит его событие |
| `message.delete` | `message` | автор или `ManageMessages` |
| `message.react` / `message.unreact` | `message, emoji, user?` | `React`; чужую реакцию снимает `ManageMessages` |
| `message.clear_reactions` | `message, emoji?` | `ManageMessages` |
| `message.pin` / `message.unpin` | `message` | `ManageMessages` |

ID сообщения — `ULID(ts, id события)`. Упоминания вычисляются из `content` (`<@user>`, `<%role>`) каждым узлом.
Сообщения от забаненного пользователя со временем позже бана скрываются.

**ЛС.** Тело события в `dm:*` шифруется:
`{"enc": {"n": nonce, "c": ciphertext, "k": x25519 отправителя, "r": x25519 получателя}}`,
ключ — `HKDF-SHA256(X25519(свой, чужой), info = "stoat-p2p/dm/v1/" + scope)`, шифр — ChaCha20‑Poly1305,
AAD = scope. Внутри — обычное тело сообщения. Если у собеседника ещё нет `x25519` в профиле, тело уходит открытым.

### Отношения (`dm:*`)

`relation.set {status: request | accept | remove | block | unblock}` — сворачиваются по `(ts, id)` в статусы
Stoat: `Friend`, `Outgoing`, `Incoming`, `Blocked`, `BlockedOther`, `None`.

## 4. Идентификаторы

* Пользователь: `ULID(created, sha256("stoat-p2p/user/" + key)[0..10])`; проверка — сравнение последних 16 символов.
* Объект, созданный событием: `ULID(event.ts, id[0..10])`.
* Канал ЛС: `ULID(max(time(a), time(b)), sha256("stoat-p2p/dm/" + a + ":" + b))`.
* Код приглашения: 10 символов алфавита `a–z A–Z 2–9` (без похожих) из байтов id события.
* Дискриминатор (`#1234`): `sha256("stoat-p2p/discriminator/" + key)` mod 9999 + 1.

## 5. Сетевой протокол

WebSocket по пути `/p2p`, текстовые JSON‑кадры `{ "t": "<тип>", … }`, максимум 16 МиБ на кадр.

### Рукопожатие

1. Обе стороны: `hello {proto: "stoat-p2p/1", node, name, challenge, announce[], relay}`.
2. Обе стороны: `auth {sig, users[], delegations[], grants[]}`:
   * `sig` — подпись узлом строки `stoat-p2p/auth/<challenge пира>/<свой ключ>/<ключ пира>`;
   * `users[] = {id, key, sig}` — подпись пользователем `stoat-p2p/represent/<challenge пира>/<ключ узла>`;
   * `delegations[] = {user, key, node, exp, sig}` — делегирования, выданные *этому* узлу (если он ретранслятор),
     подпись `stoat-p2p/delegate/<node>/<exp>`;
   * `grants[]` — делегирования от своих пользователей *пиру*, если тот объявил `relay: true`.
3. Если к узлу уже есть соединение, остаётся то, что открыл узел с меньшим ключом.
4. `users {users[], delegations[], grants[]}` — повторное объявление после создания аккаунта или новых делегирований.

### Синхронизация

| Кадр | Назначение |
| --- | --- |
| `sub {scopes: [{scope, invite?}]}` | «держи меня в курсе»; ответ — `summary` или `deny` |
| `summary {scope, buckets: {день: [count, hash]}}` | сводка: хеш — первые 32 hex‑символа sha256 отсортированных id |
| `ids? {scope, buckets[]}` → `ids {scope, ids[]}` | id событий в отличающихся днях |
| `get {ids[]}` → `events {events[]}` | запрос событий (ответ по 200 штук, старые первыми) |
| `event {event}` | живая рассылка нового события |
| `scopes?` → `scopes! {scopes[]}` | в каких серверах и ЛС состоят пользователи спрашивающего |
| `invite? {rid, code, ttl}` → `invite! {rid, code, scope}` | поиск сервера по коду (ретрансляторы пересылают с `ttl-1`) |
| `file? {hash}` → `file {hash, seq, total, data}` | файл по хешу, кусками по 512 КиБ в base64 |
| `peers {urls[]}` | обмен адресами |
| `presence {users[]}` | кто из представляемых пользователей онлайн (живёт 90 с) |
| `typing {user, channel, on, ttl}` | «печатает…» |

Узел принимает события только по scope'ам, которые ему интересны, а также профили, присланные узлом,
который представляет этого пользователя. Отдаёт — только при выполнении правил доступа из раздела 2
(проверка при каждой отправке).

## 6. Локальный HTTP API

Совместим с API Stoat 0.15 (см. `stoat-api/OpenAPI.json`): REST под `/api`, события — `/events`
(протокол v1, JSON), файлы — `/autumn`, веб‑клиент — `/`, панель узла — `/node`.
