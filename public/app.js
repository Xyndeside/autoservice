const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
}[c]));
const STATUS = {new: 'Новая', in_progress: 'В работе', done: 'Выполнена', cancelled: 'Отменена'};
const money = (n) => new Intl.NumberFormat('ru-RU').format(n) + ' ₽';
const date = (s) => new Date(s.replace(' ', 'T') + 'Z').toLocaleString('ru-RU', {
    dateStyle: 'short',
    timeStyle: 'short'
});
let me = null, tab = null, editing = null;

async function api(url, method = 'GET', body) {
    const r = await fetch(url, {
        method,
        headers: body ? {'Content-Type': 'application/json'} : {},
        body: body && JSON.stringify(body)
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Ошибка запроса');
    return data;
}

function toast(msg, err) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'show' + (err ? ' err' : '');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => (t.className = ''), 2800);
}

const form = (f) => Object.fromEntries(new FormData(f));
const run = (fn) => async (...a) => {
    try {
        await fn(...a);
    } catch (e) {
        toast(e.message, true);
    }
};

const TABS = {
    client: [['services', 'Услуги'], ['cars', 'Мои автомобили'], ['requests', 'Мои заявки']],
    admin: [['requests', 'Все заявки'], ['services', 'Услуги']],
};

const init = run(async () => {
    me = await api('/api/me');
    if (me) tab = TABS[me.role][0][0];
    render();
});
window.go = (t) => {
    tab = t;
    render();
};

function render() {
    const nav = $('#nav'), user = $('#user');
    if (!me) {
        nav.innerHTML = '';
        user.innerHTML = '';
        return authView();
    }
    nav.innerHTML = TABS[me.role].map(([k, l]) => `<button class="${k === tab ? 'on' : ''}" onclick="go('${k}')">${l}</button>`).join('');
    user.innerHTML = `${esc(me.name)} <button class="btn ghost" id="out">Выйти</button>`;
    $('#out').onclick = run(async () => {
        await api('/api/logout', 'POST');
        me = null;
        render();
    });
    const views = {
        client: {services: servicesView, cars: carsView, requests: requestsView},
        admin: {requests: adminRequestsView, services: adminServicesView}
    };
    run(views[me.role][tab])();
}

// ---------- Вход и регистрация ----------
function authView(mode = 'login') {
    const reg = mode === 'register';
    $('#app').innerHTML = `<div class="card auth"><h1>${reg ? 'Регистрация' : 'Вход'}</h1>
    <p class="sub">${reg ? 'Создайте аккаунт, чтобы записать автомобиль на ремонт.' : 'Войдите, чтобы оставить заявку или проверить её статус.'}</p>
    <form id="f">
      ${reg ? '<label>Имя<input name="name" required></label><label>Телефон<input name="phone" type="tel" placeholder="+371 20000000"></label>' : ''}
      <label>Email<input name="email" type="email" required></label>
      <label>Пароль<input name="password" type="password" required minlength="${reg ? 6 : 1}"></label>
      <button class="btn">${reg ? 'Зарегистрироваться' : 'Войти'}</button>
    </form>
    <span class="mute">${reg ? 'Уже есть аккаунт?' : 'Нет аккаунта?'} <button class="link" id="sw">${reg ? 'Войти' : 'Зарегистрироваться'}</button></span></div>`;
    $('#sw').onclick = () => authView(reg ? 'login' : 'register');
    $('#f').onsubmit = run(async (e) => {
        e.preventDefault();
        me = await api(reg ? '/api/register' : '/api/login', 'POST', form(e.target));
        tab = TABS[me.role][0][0];
        render();
    });
}

// ---------- Клиент ----------
async function servicesView() {
    const list = await api('/api/services');
    $('#app').innerHTML = `<h1>Услуги</h1><p class="sub">Выберите, что нужно сделать с автомобилем.</p>
    <div class="grid">${list.map((s) => `<div class="card"><strong>${esc(s.name)}</strong>
      <span class="mute">${esc(s.description)}</span><span class="price">${money(s.price)}</span>
      <button class="btn" onclick="newRequest(${s.id})">Оставить заявку</button></div>`).join('') || '<p class="empty">Услуг пока нет</p>'}</div>`;
}

window.newRequest = (id) => {
    window.preService = id;
    go('requests');
};

async function carsView() {
    const cars = await api('/api/cars');
    $('#app').innerHTML = `<h1>Мои автомобили</h1><p class="sub">Добавьте автомобиль, чтобы оформить на него заявку.</p>
    <div class="card"><h2>Добавить автомобиль</h2><form class="row" id="f">
      <label>Марка<input name="brand" required placeholder="Toyota"></label>
      <label>Модель<input name="model" required placeholder="Corolla"></label>
      <label>Год<input name="year" type="number" min="1950" max="2100" placeholder="2015"></label>
      <label>Гос. номер<input name="plate" placeholder="AB-1234"></label>
      <button class="btn">Добавить</button></form></div>
    <div class="card scroll">${cars.length ? `<table class="tbl"><tr><th>Автомобиль</th><th>Год</th><th>Номер</th><th></th></tr>
      ${cars.map((c) => `<tr><td>${esc(c.brand)} ${esc(c.model)}</td><td>${esc(c.year || '—')}</td><td>${esc(c.plate || '—')}</td>
      <td><button class="btn ghost danger" onclick="delCar(${c.id})">Удалить</button></td></tr>`).join('')}</table>` : '<p class="empty">Автомобилей пока нет — добавьте первый выше</p>'}</div>`;
    $('#f').onsubmit = run(async (e) => {
        e.preventDefault();
        await api('/api/cars', 'POST', form(e.target));
        toast('Автомобиль добавлен');
        carsView();
    });
}

window.delCar = run(async (id) => {
    if (!confirm('Удалить автомобиль?')) return;
    await api('/api/cars/' + id, 'DELETE');
    toast('Автомобиль удалён');
    carsView();
});

const badge = (s) => `<span class="badge s-${s}">${STATUS[s]}</span>`;

async function requestsView() {
    const [cars, services, reqs] = await Promise.all([api('/api/cars'), api('/api/services'), api('/api/requests')]);
    const pre = window.preService;
    window.preService = null;
    $('#app').innerHTML = `<h1>Мои заявки</h1><p class="sub">Оформите новую заявку и следите за статусом.</p>
    <div class="card"><h2>Новая заявка</h2>${cars.length ? `<form class="row" id="f">
      <label>Автомобиль<select name="car_id">${cars.map((c) => `<option value="${c.id}">${esc(c.brand)} ${esc(c.model)} ${esc(c.plate)}</option>`).join('')}</select></label>
      <label>Услуга<select name="service_id">${services.map((s) => `<option value="${s.id}" ${s.id === pre ? 'selected' : ''}>${esc(s.name)} — ${money(s.price)}</option>`).join('')}</select></label>
      <label class="full">Комментарий<textarea name="comment" rows="2" placeholder="Опишите проблему"></textarea></label>
      <button class="btn">Отправить заявку</button></form>`
        : '<p class="empty">Сначала <button class="link" onclick="go(\'cars\')">добавьте автомобиль</button></p>'}</div>
    <div class="card scroll">${reqs.length ? `<table class="tbl"><tr><th>№</th><th>Дата</th><th>Автомобиль</th><th>Услуга</th><th>Статус</th><th></th></tr>
      ${reqs.map((r) => `<tr><td>${r.id}</td><td>${date(r.created_at)}</td><td>${esc(r.car)}</td><td>${esc(r.service)}<div class="mute">${esc(r.comment)}</div></td><td>${badge(r.status)}</td>
      <td>${r.status === 'new' ? `<button class="btn ghost" onclick="cancelReq(${r.id})">Отменить</button>` : ''}</td></tr>`).join('')}</table>` : '<p class="empty">Заявок пока нет</p>'}</div>`;
    if ($('#f')) $('#f').onsubmit = run(async (e) => {
        e.preventDefault();
        await api('/api/requests', 'POST', form(e.target));
        toast('Заявка отправлена');
        requestsView();
    });
}

window.cancelReq = run(async (id) => {
    if (!confirm('Отменить заявку?')) return;
    await api(`/api/requests/${id}/status`, 'PATCH', {status: 'cancelled'});
    toast('Заявка отменена');
    requestsView();
});

// ---------- Администратор ----------
async function adminRequestsView() {
    const reqs = await api('/api/requests');
    $('#app').innerHTML = `<h1>Все заявки</h1><p class="sub">Меняйте статус — клиент увидит его сразу.</p>
    <div class="card scroll">${reqs.length ? `<table class="tbl"><tr><th>№</th><th>Дата</th><th>Клиент</th><th>Автомобиль</th><th>Услуга</th><th>Статус</th></tr>
    ${reqs.map((r) => `<tr><td>${r.id}</td><td>${date(r.created_at)}</td><td>${esc(r.client)}<div class="mute">${esc(r.phone || r.email)}</div></td><td>${esc(r.car)}</td>
      <td>${esc(r.service)}<div class="mute">${esc(r.comment)}</div></td>
      <td><select onchange="setStatus(${r.id},this.value)">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${k === r.status ? 'selected' : ''}>${v}</option>`).join('')}</select></td></tr>`).join('')}</table>` : '<p class="empty">Заявок пока нет</p>'}</div>`;
}

window.setStatus = run(async (id, status) => {
    await api(`/api/requests/${id}/status`, 'PATCH', {status});
    toast('Статус обновлён');
});

async function adminServicesView() {
    const list = await api('/api/services?all=1');
    const e = list.find((s) => s.id === editing) || {};
    $('#app').innerHTML = `<h1>Услуги автосервиса</h1><p class="sub">Добавляйте, меняйте цены и скрывайте услуги.</p>
    <div class="card"><h2>${e.id ? 'Редактирование услуги' : 'Новая услуга'}</h2><form class="row" id="f">
      <label>Название<input name="name" required value="${esc(e.name)}"></label>
      <label>Цена, ₽<input name="price" type="number" min="0" step="1" required value="${esc(e.price)}"></label>
      <label class="full">Описание<input name="description" value="${esc(e.description)}"></label>
      <div class="actions"><button class="btn">${e.id ? 'Сохранить' : 'Добавить'}</button>${e.id ? '<button type="button" class="btn ghost" id="cancel">Отмена</button>' : ''}</div></form></div>
    <div class="card scroll"><table class="tbl"><tr><th>Услуга</th><th>Цена</th><th>Статус</th><th></th></tr>
    ${list.map((s) => `<tr class="${s.active ? '' : 'off'}"><td>${esc(s.name)}<div class="mute">${esc(s.description)}</div></td><td>${money(s.price)}</td>
      <td>${s.active ? 'Доступна' : 'Скрыта'}</td><td><div class="actions">
      <button class="btn ghost" onclick="editSvc(${s.id})">Изменить</button>
      <button class="btn ghost" onclick="toggleSvc(${s.id})">${s.active ? 'Скрыть' : 'Показать'}</button>
      <button class="btn ghost danger" onclick="delSvc(${s.id})">Удалить</button></div></td></tr>`).join('')}</table></div>`;
    if ($('#cancel')) $('#cancel').onclick = () => {
        editing = null;
        adminServicesView();
    };
    $('#f').onsubmit = run(async (ev) => {
        ev.preventDefault();
        const d = form(ev.target);
        if (e.id) await api('/api/services/' + e.id, 'PUT', {
            ...d,
            active: !!e.active
        }); else await api('/api/services', 'POST', d);
        editing = null;
        toast('Услуга сохранена');
        adminServicesView();
    });
}

window.editSvc = (id) => {
    editing = id;
    adminServicesView();
    window.scrollTo(0, 0);
};
window.toggleSvc = run(async (id) => {
    const s = (await api('/api/services?all=1')).find((x) => x.id === id);
    await api('/api/services/' + id, 'PUT', {...s, active: !s.active});
    adminServicesView();
});
window.delSvc = run(async (id) => {
    if (!confirm('Удалить услугу?')) return;
    const r = await api('/api/services/' + id, 'DELETE');
    toast(r.hidden ? 'Услуга есть в заявках — она скрыта' : 'Услуга удалена');
    adminServicesView();
});

init();
