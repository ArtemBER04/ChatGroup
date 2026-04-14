/**
 * ChatGroup — клиент: REST API + Socket.IO (http://151.242.88.37:3000).
 * Профиль и настройки UI остаются в localStorage.
 */
const API_BASE = "https://chat-group.website/api";

const STORAGE_KEYS = {
  TOKEN: "chatgroup_jwt",
  USER: "chatgroup_user",
  USER_PROFILES: "messenger_mock_user_profiles",
  APP_SETTINGS: "messenger_mock_app_settings",
};

const DEFAULT_PROFILE_COLOR = "#5288c1";
const MAX_IMAGE_DATA_URL_CHARS = 10 * 1024 * 1024;

let authToken = null;
/** { id: number, username: string } */
let currentUser = null;
let currentUsername = null;
let activeChatId = null;

/** Кэш чатов с сервера: { id, name, created_at, role } */
let chatsCache = [];

/** Сообщения активного чата (нормализованный вид для UI) */
let activeChatMessages = [];

let memberPopoverTargetLogin = null;
let videoCallStream = null;
let pendingAddMemberLogin = null;

// ——— localStorage: только токен, пользователь, профили, настройки ———

function loadToken() {
  return localStorage.getItem(STORAGE_KEYS.TOKEN);
}

function loadStoredUser() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.USER);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function setAuth(token, user) {
  authToken = token;
  currentUser = user;
  currentUsername = user?.username || null;
  localStorage.setItem(STORAGE_KEYS.TOKEN, token);
  localStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(user));
}

function clearAuth() {
  authToken = null;
  currentUser = null;
  currentUsername = null;
  localStorage.removeItem(STORAGE_KEYS.TOKEN);
  localStorage.removeItem(STORAGE_KEYS.USER);
}

function authHeaders() {
  const h = { "Content-Type": "application/json" };
  if (authToken) h.Authorization = `Bearer ${authToken}`;
  return h;
}

async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { ...authHeaders(), ...(options.headers || {}) },
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(data?.error || res.statusText || "Ошибка запроса");
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ——— Socket.IO (глобальный io из CDN) ———
let socket = null;

function disconnectSocket() {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
}

function connectSocket() {
  disconnectSocket();
  if (!authToken || typeof io === "undefined") return;

  socket = io(API_BASE, {
    auth: { token: authToken },
    transports: ["websocket", "polling"],
  });

  socket.on("connect", () => {
    if (activeChatId) {
      socket.emit("join_chat", { chatId: activeChatId }, () => {});
    }
  });

  socket.on("connect_error", (err) => {
    console.warn("Socket.IO:", err.message);
  });

  socket.on("message", (msg) => {
    if (!msg || msg.chat_id !== activeChatId) return;
    const normalized = mapServerMessage(msg);
    if (activeChatMessages.some((m) => m.id === normalized.id)) return;
    activeChatMessages.push(normalized);
    activeChatMessages.sort((a, b) => Number(a.id) - Number(b.id));
    const chat = getActiveChat();
    if (chat) {
      renderMessages(chat);
      renderMembers(chat);
    }
  });
}

function loadUserProfiles() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.USER_PROFILES);
    const data = raw ? JSON.parse(raw) : {};
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function saveUserProfiles(profiles) {
  localStorage.setItem(STORAGE_KEYS.USER_PROFILES, JSON.stringify(profiles));
}

function getProfileAbout(username) {
  const p = loadUserProfiles()[username];
  return p && typeof p.about === "string" && p.about.trim()
    ? p.about.trim()
    : "Пользователь ничего не написал о себе.";
}

function getProfileColor(username) {
  const p = loadUserProfiles()[username];
  const c = p && p.profileColor;
  if (typeof c === "string" && /^#[0-9A-Fa-f]{6}$/.test(c)) return c;
  return DEFAULT_PROFILE_COLOR;
}

function defaultAppSettings() {
  return { compactChatList: false, notifyMock: true, soundMock: false };
}

function loadAppSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.APP_SETTINGS);
    if (!raw) return defaultAppSettings();
    const parsed = JSON.parse(raw);
    return { ...defaultAppSettings(), ...parsed };
  } catch {
    return defaultAppSettings();
  }
}

function saveAppSettings(settings) {
  localStorage.setItem(STORAGE_KEYS.APP_SETTINGS, JSON.stringify(settings));
}

function applyAppSettingsToUI() {
  const s = loadAppSettings();
  chatListEl.classList.toggle("compact", !!s.compactChatList);
}

function formatTime(isoString) {
  const d = new Date(isoString);
  return d.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Преобразование записи сообщения с сервера в формат UI */
function mapServerMessage(m) {
  const isImg = m.type === "image";
  return {
    id: m.id,
    sender: m.username,
    time: m.created_at,
    type: isImg ? "image" : "text",
    text: isImg ? "" : m.content || "",
    imageData: isImg ? m.content : null,
  };
}

function isChatAdmin(chat) {
  if (!chat || !currentUsername) return false;
  return chat.role === "admin";
}

function getActiveChat() {
  if (!activeChatId) return null;
  return chatsCache.find((c) => c.id === activeChatId) || null;
}

/** Участники: сервер не отдаёт список — собираем из сообщений + вы */
function deriveMemberUsernames(messages) {
  const set = new Set();
  if (currentUsername) set.add(currentUsername);
  (messages || []).forEach((m) => {
    if (m.sender) set.add(m.sender);
  });
  return Array.from(set);
}

// ——— DOM ———

const authScreen = document.getElementById("auth-screen");
const appScreen = document.getElementById("app-screen");
const authForm = document.getElementById("auth-form");
const authError = document.getElementById("auth-error");
const usernameInput = document.getElementById("username");
const passwordInput = document.getElementById("password");
const headerUser = document.getElementById("header-user");
const btnLogout = document.getElementById("btn-logout");
const chatListEl = document.getElementById("chat-list");
const currentChatTitle = document.getElementById("current-chat-title");
const messagesContainer = document.getElementById("messages-container");
const messageInput = document.getElementById("message-input");
const btnSend = document.getElementById("btn-send");
const btnAddChat = document.getElementById("btn-add-chat");
const btnVideoCall = document.getElementById("btn-video-call");
const btnLeaveGroup = document.getElementById("btn-leave-group");
const btnDeleteChat = document.getElementById("btn-delete-chat");
const photoInput = document.getElementById("photo-input");
const btnAttachPhoto = document.getElementById("btn-attach-photo");
const membersListEl = document.getElementById("members-list");
const btnAddMember = document.getElementById("btn-add-member");
const modalOverlay = document.getElementById("modal-overlay");
const newChatNameInput = document.getElementById("new-chat-name");
const modalError = document.getElementById("modal-error");
const modalCancel = document.getElementById("modal-cancel");
const modalCreate = document.getElementById("modal-create");

const profileFullscreen = document.getElementById("profile-fullscreen");
const profileFsBack = document.getElementById("profile-fs-back");
const profileUsernameInput = document.getElementById("profile-username");
const profileAboutInput = document.getElementById("profile-about");
const profileSave = document.getElementById("profile-save");

const modalAddMemberOverlay = document.getElementById("modal-add-member-overlay");
const addMemberUsernameInput = document.getElementById("add-member-username");
const addMemberError = document.getElementById("add-member-error");
const addMemberConfirmBlock = document.getElementById("add-member-confirm-block");
const addMemberConfirmText = document.getElementById("add-member-confirm-text");
const addMemberConfirmYes = document.getElementById("add-member-confirm-yes");
const addMemberCancel = document.getElementById("add-member-cancel");
const addMemberCheck = document.getElementById("add-member-check");

const modalSettingsOverlay = document.getElementById("modal-settings-overlay");
const settingCompactList = document.getElementById("setting-compact-list");
const settingNotifyMock = document.getElementById("setting-notify-mock");
const settingSoundMock = document.getElementById("setting-sound-mock");
const settingProfileColor = document.getElementById("setting-profile-color");
const settingProfileColorHex = document.getElementById("setting-profile-color-hex");
const settingsClose = document.getElementById("settings-close");

const btnProfile = document.getElementById("btn-profile");
const btnSettings = document.getElementById("btn-settings");

const memberPopoverBackdrop = document.getElementById("member-popover-backdrop");
const memberPopover = document.getElementById("member-popover");
const memberPopoverHeader = document.getElementById("member-popover-header");
const memberPopoverName = document.getElementById("member-popover-name");
const memberPopoverLoginText = document.getElementById("member-popover-login");
const memberPopoverAbout = document.getElementById("member-popover-about");
const memberPopoverActions = document.getElementById("member-popover-actions");
const memberBtnRemove = document.getElementById("member-btn-remove");
const memberBtnAdmin = document.getElementById("member-btn-admin");
const memberPopoverClose = document.getElementById("member-popover-close");

const modalVideoOverlay = document.getElementById("modal-video-overlay");
const videoWrapEl = document.getElementById("video-wrap");
const videoLocalPreview = document.getElementById("video-local-preview");
const videoCallHint = document.getElementById("video-call-hint");
const videoCallEnd = document.getElementById("video-call-end");

// ——— Сервер: чаты и сообщения ———

async function fetchChatsFromServer() {
  const data = await apiFetch("/chats");
  chatsCache = Array.isArray(data.chats) ? data.chats : [];
  return chatsCache;
}

async function fetchMessagesFromServer(chatId) {
  const data = await apiFetch(`/messages/${chatId}?limit=200`);
  const list = Array.isArray(data.messages) ? data.messages : [];
  return list.map(mapServerMessage);
}

/** Кнопки, не поддерживаемые текущим API */
function setServerLimitedUi() {
  btnLeaveGroup.hidden = true;
  btnDeleteChat.hidden = true;
  btnAddMember.hidden = true;
}

function updateChatToolbarState() {
  const hasChat = !!activeChatId;
  btnVideoCall.hidden = !hasChat;
  btnAttachPhoto.hidden = !hasChat;
  setServerLimitedUi();
}

// ——— Вход / регистрация ———

async function register() {
  const username = (usernameInput.value || "").trim();
  const password = passwordInput.value || "";

  authError.hidden = true;
  authError.textContent = "";

  if (!username || !password) {
    authError.textContent = "Заполните имя пользователя и пароль.";
    authError.hidden = false;
    return;
  }

  try {
    let data;
    try {
      data = await apiFetch("/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
    } catch (e) {
      if (e.status !== 401) throw e;
      try {
        await apiFetch("/register", {
          method: "POST",
          body: JSON.stringify({ username, password }),
        });
      } catch (regErr) {
        if (regErr.status === 409) {
          authError.textContent = "Имя занято — введите верный пароль для входа.";
          authError.hidden = false;
          return;
        }
        throw regErr;
      }
      data = await apiFetch("/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
    }

    setAuth(data.token, data.user);
    connectSocket();
    showApp();
    await fetchChatsFromServer();
    renderChats();
    if (chatsCache.length > 0) {
      await switchChat(chatsCache[0].id);
    } else {
      showNoChatSelected();
    }
  } catch (e) {
    authError.textContent = e.data?.error || e.message || "Ошибка сервера. Запущен ли API на :3000?";
    authError.hidden = false;
  }
}

function logout() {
  closeMemberPopover();
  closeVideoCallModal();
  disconnectSocket();
  clearAuth();
  activeChatId = null;
  chatsCache = [];
  activeChatMessages = [];
  authScreen.hidden = false;
  appScreen.hidden = true;
  usernameInput.value = "";
  passwordInput.value = "";
}

function showApp() {
  authScreen.hidden = true;
  appScreen.hidden = false;
  refreshHeaderUserLabel();
  applyAppSettingsToUI();
}

function refreshHeaderUserLabel() {
  if (!currentUsername) return;
  headerUser.textContent = `Вы вошли как: ${currentUsername}`;
}

function showNoChatSelected() {
  activeChatId = null;
  activeChatMessages = [];
  closeMemberPopover();
  closeVideoCallModal();
  currentChatTitle.textContent = "Выберите или создайте чат";
  messagesContainer.innerHTML = "";
  const empty = document.createElement("div");
  empty.className = "messages-empty";
  empty.textContent = "Создайте чат кнопкой «+» рядом с заголовком «Чаты».";
  messagesContainer.appendChild(empty);
  membersListEl.innerHTML = "";
  const li = document.createElement("li");
  li.className = "members-list-item";
  li.textContent = "Нет активного чата";
  membersListEl.appendChild(li);
  messageInput.disabled = true;
  btnSend.disabled = true;
  renderChats();
  updateChatToolbarState();
}

function setChatInputEnabled(on) {
  messageInput.disabled = !on;
  btnSend.disabled = !on;
}

function renderChats() {
  chatListEl.innerHTML = "";
  chatsCache.forEach((chat) => {
    const li = document.createElement("li");
    li.className = "chat-list-item" + (chat.id === activeChatId ? " active" : "");
    li.textContent = chat.name;
    li.dataset.chatId = String(chat.id);
    li.addEventListener("click", () => switchChat(chat.id));
    chatListEl.appendChild(li);
  });
  applyAppSettingsToUI();
}

async function switchChat(chatId) {
  const chat = chatsCache.find((c) => c.id === chatId);
  if (!chat) return;

  activeChatId = chatId;
  currentChatTitle.textContent = chat.name;
  setChatInputEnabled(true);
  renderChats();
  updateChatToolbarState();

  messagesContainer.innerHTML = "";
  const loading = document.createElement("div");
  loading.className = "messages-empty";
  loading.textContent = "Загрузка…";
  messagesContainer.appendChild(loading);

  try {
    activeChatMessages = await fetchMessagesFromServer(chatId);
  } catch (e) {
    activeChatMessages = [];
    messagesContainer.innerHTML = "";
    const err = document.createElement("div");
    err.className = "messages-empty";
    err.textContent = e.data?.error || e.message || "Не удалось загрузить сообщения";
    messagesContainer.appendChild(err);
    return;
  }

  if (socket && socket.connected) {
    socket.emit("join_chat", { chatId }, () => {});
  }

  renderMessages(chat);
  renderMembers(chat);
}

function renderMessages(chat) {
  messagesContainer.innerHTML = "";

  if (!activeChatMessages.length) {
    const empty = document.createElement("div");
    empty.className = "messages-empty";
    empty.textContent = "Пока нет сообщений. Напишите первое!";
    messagesContainer.appendChild(empty);
    return;
  }

  activeChatMessages.forEach((msg) => {
    const isMine = msg.sender === currentUsername;
    const row = document.createElement("div");
    row.className = "message-row " + (isMine ? "mine" : "other");

    const avatar = document.createElement("div");
    avatar.className = "message-avatar";
    const letter = (String(msg.sender).trim()[0] || "?").toUpperCase();
    avatar.textContent = letter;
    avatar.style.background = getProfileColor(msg.sender);

    const wrap = document.createElement("div");
    wrap.className = "message-bubble-wrap";

    const bubble = document.createElement("div");
    bubble.className = "message-bubble " + (isMine ? "mine" : "other");

    const meta = document.createElement("div");
    meta.className = "message-meta";
    meta.innerHTML = `<span class="sender">${escapeHtml(msg.sender)}</span> · ${formatTime(msg.time)}`;
    bubble.appendChild(meta);

    if (msg.type === "image" && msg.imageData) {
      const img = document.createElement("img");
      img.className = "message-image";
      img.src = msg.imageData;
      img.alt = "Фото";
      bubble.appendChild(img);
      if (msg.text && String(msg.text).trim()) {
        const cap = document.createElement("div");
        cap.className = "message-text";
        cap.textContent = msg.text;
        bubble.appendChild(cap);
      }
    } else {
      const text = document.createElement("div");
      text.className = "message-text";
      text.textContent = msg.text || "";
      bubble.appendChild(text);
    }

    wrap.appendChild(bubble);
    row.appendChild(avatar);
    row.appendChild(wrap);
    messagesContainer.appendChild(row);
  });

  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function sendMessage() {
  if (!currentUsername || !activeChatId || messageInput.disabled) return;
  const text = (messageInput.value || "").trim();
  if (!text) return;
  if (!socket || !socket.connected) {
    window.alert("Нет соединения с сервером. Проверьте Socket.IO.");
    return;
  }

  socket.emit(
    "send_message",
    { chatId: activeChatId, content: text, type: "text" },
    (ack) => {
      if (!ack || !ack.ok) {
        window.alert(ack?.error || "Не удалось отправить сообщение");
        return;
      }
      messageInput.value = "";
    },
  );
}

function fileToScaledDataUrl(file, maxW, maxH, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let w = img.naturalWidth;
        let h = img.naturalHeight;
        const scale = Math.min(1, maxW / w, maxH / h);
        w = Math.round(w * scale);
        h = Math.round(h * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        let q = quality;
        let dataUrl = canvas.toDataURL("image/jpeg", q);
        while (dataUrl.length > MAX_IMAGE_DATA_URL_CHARS && q > 0.35) {
          q -= 0.08;
          dataUrl = canvas.toDataURL("image/jpeg", q);
        }
        resolve(dataUrl);
      };
      img.onerror = () => reject(new Error("image"));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error("read"));
    reader.readAsDataURL(file);
  });
}

function sendImageMessage(imageData) {
  if (!activeChatId || messageInput.disabled) return;
  if (!socket || !socket.connected) {
    window.alert("Нет соединения с сервером.");
    return;
  }
  socket.emit(
    "send_message",
    { chatId: activeChatId, content: imageData, type: "image" },
    (ack) => {
      if (!ack || !ack.ok) {
        window.alert(ack?.error || "Не удалось отправить фото");
      }
    },
  );
}

async function handlePhotoFile(file) {
  if (!file || !file.type.startsWith("image/")) return;
  if (file.size > 10 * 1024 * 1024) {
    window.alert("Файл слишком большой. Максимум 10 МБ.");
    return;
  }
  try {
    const dataUrl = await fileToScaledDataUrl(file, 1280, 1280, 0.82);
    if (dataUrl.length > MAX_IMAGE_DATA_URL_CHARS) {
      window.alert("Изображение слишком большое после сжатия.");
      return;
    }
    sendImageMessage(dataUrl);
    messageInput.value = "";
  } catch {
    window.alert("Не удалось обработать файл.");
  }
  photoInput.value = "";
}

async function openVideoCallModal() {
  if (!activeChatId) return;
  modalVideoOverlay.hidden = false;
  videoWrapEl.classList.remove("has-stream");
  videoLocalPreview.srcObject = null;
  videoCallHint.textContent = "Запрос доступа к камере…";

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    videoCallHint.textContent = "В этом браузере недоступен getUserMedia (камера).";
    return;
  }

  try {
    if (videoCallStream) {
      videoCallStream.getTracks().forEach((t) => t.stop());
      videoCallStream = null;
    }
    videoCallStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user" },
      audio: true,
    });
    videoLocalPreview.srcObject = videoCallStream;
    videoWrapEl.classList.add("has-stream");
  } catch (err) {
    videoCallHint.textContent =
      "Камера недоступна: " + (err && err.message ? err.message : "доступ запрещён");
    videoWrapEl.classList.remove("has-stream");
  }
}

function closeVideoCallModal() {
  modalVideoOverlay.hidden = true;
  if (videoCallStream) {
    videoCallStream.getTracks().forEach((t) => t.stop());
    videoCallStream = null;
  }
  videoLocalPreview.srcObject = null;
  videoWrapEl.classList.remove("has-stream");
  videoCallHint.textContent = "Камера выключена или недоступна";
}

function renderMembers(chat) {
  membersListEl.innerHTML = "";
  const members = deriveMemberUsernames(activeChatMessages);
  if (!members.length) {
    const li = document.createElement("li");
    li.className = "members-list-item";
    li.textContent = "Нет данных об участниках";
    membersListEl.appendChild(li);
    return;
  }

  const hint = document.createElement("li");
  hint.className = "members-list-item";
  hint.style.fontSize = "0.75rem";
  hint.style.color = "var(--text-secondary)";
  hint.style.marginBottom = "8px";
  hint.textContent = "Участники по сообщениям (API списка нет)";
  membersListEl.appendChild(hint);

  members
    .slice()
    .sort((a, b) => a.localeCompare(b, "ru"))
    .forEach((login) => {
      const li = document.createElement("li");
      li.className = "members-list-row";

      const badge = document.createElement("span");
      badge.className = "member-name-badge";
      badge.textContent = login;
      badge.style.background = getProfileColor(login);

      const meta = document.createElement("div");
      meta.className = "members-row-meta";
      if (chat && isChatAdmin(chat) && login === currentUsername) {
        const adminLbl = document.createElement("span");
        adminLbl.className = "member-admin-label";
        adminLbl.textContent = "Админ";
        meta.appendChild(adminLbl);
      }

      const menuBtn = document.createElement("button");
      menuBtn.type = "button";
      menuBtn.className = "btn-member-dots";
      menuBtn.textContent = "⋯";
      menuBtn.title = "Подробнее";
      menuBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openMemberPopover(login, menuBtn);
      });

      li.appendChild(badge);
      li.appendChild(meta);
      li.appendChild(menuBtn);
      membersListEl.appendChild(li);
    });
}

function closeMemberPopover() {
  memberPopoverBackdrop.hidden = true;
  memberPopover.hidden = true;
  memberPopoverTargetLogin = null;
}

function openMemberPopover(login, anchorBtn) {
  memberPopoverTargetLogin = login;
  const chat = getActiveChat();
  const color = getProfileColor(login);

  memberPopoverHeader.style.background = color;
  memberPopoverName.textContent = login;
  memberPopoverLoginText.textContent = login;
  memberPopoverAbout.textContent = getProfileAbout(login);
  memberPopoverActions.hidden = true;

  const rect = anchorBtn.getBoundingClientRect();
  const pw = 280;
  let left = rect.right - pw;
  if (left < 8) left = 8;
  if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
  let top = rect.bottom + 6;
  const ph = 320;
  if (top + ph > window.innerHeight - 8) {
    top = Math.max(8, rect.top - ph - 6);
  }

  memberPopover.style.left = left + "px";
  memberPopover.style.top = top + "px";

  memberPopoverBackdrop.hidden = false;
  memberPopover.hidden = false;
}

function openNewChatModal() {
  modalError.hidden = true;
  modalError.textContent = "";
  newChatNameInput.value = "";
  modalOverlay.hidden = false;
  newChatNameInput.focus();
}

function closeNewChatModal() {
  modalOverlay.hidden = true;
}

async function createNewChatFromModal() {
  const name = (newChatNameInput.value || "").trim();
  modalError.hidden = true;
  if (!name) {
    modalError.textContent = "Введите название чата.";
    modalError.hidden = false;
    return;
  }
  try {
    const data = await apiFetch("/chats", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    closeNewChatModal();
    await fetchChatsFromServer();
    renderChats();
    await switchChat(data.id);
  } catch (e) {
    modalError.textContent = e.data?.error || e.message || "Ошибка";
    modalError.hidden = false;
  }
}

function openProfileModal() {
  if (!currentUsername) return;
  profileUsernameInput.value = currentUsername;
  const profiles = loadUserProfiles();
  const p = profiles[currentUsername] || {};
  profileAboutInput.value = p.about || "";
  profileFullscreen.hidden = false;
  profileAboutInput.focus();
}

function closeProfileModal() {
  profileFullscreen.hidden = true;
}

function saveProfileFromModal() {
  if (!currentUsername) return;
  const profiles = loadUserProfiles();
  const prev = profiles[currentUsername] || {};
  profiles[currentUsername] = {
    about: (profileAboutInput.value || "").trim(),
    profileColor:
      typeof prev.profileColor === "string" && /^#[0-9A-Fa-f]{6}$/.test(prev.profileColor)
        ? prev.profileColor
        : DEFAULT_PROFILE_COLOR,
  };
  saveUserProfiles(profiles);
  refreshHeaderUserLabel();
  const chat = getActiveChat();
  if (chat) {
    renderMessages(chat);
    renderMembers(chat);
  }
  closeProfileModal();
}

function resetAddMemberModal() {
  addMemberUsernameInput.value = "";
  addMemberError.hidden = true;
  addMemberError.textContent = "";
  addMemberConfirmBlock.hidden = true;
  pendingAddMemberLogin = null;
}

function openAddMemberModal() {
  window.alert("Добавление участников пока не реализовано в API сервера.");
}

function closeAddMemberModal() {
  modalAddMemberOverlay.hidden = true;
  resetAddMemberModal();
}

function checkAddMemberUser() {}
function confirmAddMemberToChat() {}

function syncColorHexLabel() {
  if (settingProfileColorHex && settingProfileColor) {
    settingProfileColorHex.textContent = settingProfileColor.value;
  }
}

function openSettingsModal() {
  const s = loadAppSettings();
  settingCompactList.checked = !!s.compactChatList;
  settingNotifyMock.checked = s.notifyMock !== false;
  settingSoundMock.checked = !!s.soundMock;
  const profiles = loadUserProfiles();
  const col = profiles[currentUsername]?.profileColor;
  settingProfileColor.value =
    typeof col === "string" && /^#[0-9A-Fa-f]{6}$/.test(col) ? col : DEFAULT_PROFILE_COLOR;
  syncColorHexLabel();
  modalSettingsOverlay.hidden = false;
}

function closeSettingsModal() {
  modalSettingsOverlay.hidden = true;
}

function saveSettingsFromForm() {
  saveAppSettings({
    compactChatList: settingCompactList.checked,
    notifyMock: settingNotifyMock.checked,
    soundMock: settingSoundMock.checked,
  });
  if (currentUsername) {
    const profiles = loadUserProfiles();
    const prev = profiles[currentUsername] || {};
    profiles[currentUsername] = {
      ...prev,
      profileColor: settingProfileColor.value,
    };
    saveUserProfiles(profiles);
    const chat = getActiveChat();
    if (chat) renderMembers(chat);
  }
  applyAppSettingsToUI();
  closeSettingsModal();
}

async function tryRestoreSession() {
  const t = loadToken();
  const u = loadStoredUser();
  if (!t || !u || !u.username) return;

  authToken = t;
  currentUser = u;
  currentUsername = u.username;

  try {
    await fetchChatsFromServer();
  } catch {
    clearAuth();
    return;
  }

  connectSocket();
  showApp();
  renderChats();
  if (chatsCache.length > 0) {
    await switchChat(chatsCache[0].id);
  } else {
    showNoChatSelected();
  }
}

// ——— События ———

authForm.addEventListener("submit", (e) => {
  e.preventDefault();
  register();
});

btnLogout.addEventListener("click", logout);
btnSend.addEventListener("click", sendMessage);

messageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

btnAddChat.addEventListener("click", openNewChatModal);
btnVideoCall.addEventListener("click", openVideoCallModal);
btnLeaveGroup.addEventListener("click", () =>
  window.alert("Выход из группы на сервере пока не реализован."),
);
btnDeleteChat.addEventListener("click", () =>
  window.alert("Удаление чата на сервере пока не реализовано."),
);

btnAttachPhoto.addEventListener("click", () => photoInput.click());
photoInput.addEventListener("change", () => {
  const f = photoInput.files && photoInput.files[0];
  if (f) handlePhotoFile(f);
});

videoCallEnd.addEventListener("click", closeVideoCallModal);
modalVideoOverlay.addEventListener("click", (e) => {
  if (e.target === modalVideoOverlay) closeVideoCallModal();
});

btnProfile.addEventListener("click", openProfileModal);
btnSettings.addEventListener("click", openSettingsModal);
profileFsBack.addEventListener("click", closeProfileModal);
profileSave.addEventListener("click", saveProfileFromModal);
settingsClose.addEventListener("click", saveSettingsFromForm);

settingProfileColor.addEventListener("input", syncColorHexLabel);

btnAddMember.addEventListener("click", openAddMemberModal);
addMemberCancel.addEventListener("click", closeAddMemberModal);
addMemberCheck.addEventListener("click", checkAddMemberUser);
addMemberConfirmYes.addEventListener("click", confirmAddMemberToChat);

modalAddMemberOverlay.addEventListener("click", (e) => {
  if (e.target === modalAddMemberOverlay) closeAddMemberModal();
});

modalCancel.addEventListener("click", closeNewChatModal);
modalCreate.addEventListener("click", () => createNewChatFromModal());

modalOverlay.addEventListener("click", (e) => {
  if (e.target === modalOverlay) closeNewChatModal();
});

modalSettingsOverlay.addEventListener("click", (e) => {
  if (e.target === modalSettingsOverlay) closeSettingsModal();
});

memberPopoverBackdrop.addEventListener("click", closeMemberPopover);
memberPopoverClose.addEventListener("click", closeMemberPopover);
memberBtnRemove.addEventListener("click", () =>
  window.alert("Удаление участника на сервере пока не реализовано."),
);
memberBtnAdmin.addEventListener("click", () =>
  window.alert("Назначение админа на сервере пока не реализовано."),
);

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!modalVideoOverlay.hidden) {
    closeVideoCallModal();
    return;
  }
  if (!memberPopover.hidden) closeMemberPopover();
});

document.querySelectorAll(".modal-dialog").forEach((el) => {
  el.addEventListener("click", (e) => e.stopPropagation());
});

memberPopover.addEventListener("click", (e) => e.stopPropagation());

newChatNameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    createNewChatFromModal();
  }
});

tryRestoreSession();
