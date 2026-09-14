/* =====================================================================
   TALLERES CREATIVOS · v1.0.0
   Un solo archivo de lógica, sin frameworks ni módulos raros.
   Los datos viven en Supabase (Postgres + Auth). Todo lo demás
   (cálculos, pantallas, modales) es JavaScript plano, igual de simple
   que la versión anterior que ya conocías, solo que ahora conectado
   a la nube en vez de a este equipo.
   ===================================================================== */

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const money = n => '$' + (Number(n) || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = n => Number(n) || 0;
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const hoy = () => new Date().toISOString().slice(0, 10);
const fmtFecha = f => f ? new Date(f).toLocaleDateString('es-MX') : '';

const CAFE_DEFAULT = 59;

/* Caché de datos en memoria, se recarga después de cada guardado */
let DB = { materiales: [], tipos: [], combos: [], sesiones: [], ventas: [], settings: { cafe_precio: CAFE_DEFAULT } };

const mat = id => DB.materiales.find(m => m.id === id);

/* ---------------------------------------------------------------------
   CÁLCULOS (mismas fórmulas que siempre)
   --------------------------------------------------------------------- */
const costoUnit = m => num(m.cant_adq) > 0 ? num(m.costo_adq) / num(m.cant_adq) : 0;
const precioUnitSug = m => costoUnit(m) * (1 + num(m.margen) / 100);
const gananciaUnit = m => precioUnitSug(m) - costoUnit(m);

function costoLista(lista) {
  return (lista || []).reduce((t, l) => { const m = mat(l.material_id); return t + (m ? costoUnit(m) * num(l.cantidad) : 0); }, 0);
}
function comboCosto(c) { return costoLista(c.materiales); }
function comboPrecio(c) { const co = comboCosto(c); return num(c.precio_final) > 0 ? num(c.precio_final) : co * (1 + num(c.margen) / 100); }
function comboGanancia(c) { return comboPrecio(c) - comboCosto(c); }

function resumenTipo(t, personas) {
  const per = Math.max(1, num(personas) || 1);
  const costoMat = costoLista(t.materiales);
  const precio = num(t.precio_final) > 0 ? num(t.precio_final) : costoMat * (1 + num(t.margen) / 100);
  const utilidad = precio - costoMat;
  const horas = num(t.duracion) || 1;
  const cafe = num(DB.settings.cafe_precio || CAFE_DEFAULT);
  return {
    personas: per, costoMat, precio, utilidad,
    margenReal: precio > 0 ? utilidad / precio * 100 : 0,
    utilHora: utilidad / horas,
    totalTaller: precio * per,
    totalCafe: t.incluye_cafe ? (precio + cafe) * per : 0,
    cafeNegocio: t.incluye_cafe ? cafe * per : 0,
    costoTotal: costoMat * per,
    utilidadTotal: utilidad * per
  };
}

/* =====================================================================
   AUTENTICACIÓN (Supabase Auth)
   ===================================================================== */
const loginScreen = document.getElementById('loginScreen');
const appRoot = document.getElementById('appRoot');

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('loginSubmit');
  const err = document.getElementById('loginError');
  err.textContent = '';
  btn.disabled = true; btn.textContent = 'Entrando…';
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  btn.disabled = false; btn.textContent = 'Iniciar sesión';
  if (error) { err.textContent = 'Correo o contraseña incorrectos.'; return; }
  await mostrarApp(data.session);
});

document.getElementById('btnLogout').addEventListener('click', async () => {
  await sb.auth.signOut();
  appRoot.style.display = 'none';
  loginScreen.style.display = 'flex';
});

async function mostrarApp(session) {
  loginScreen.style.display = 'none';
  appRoot.style.display = 'flex';
  document.getElementById('userEmailLabel').textContent = session.user.email;
  await cargarTodo();
  go('inicio');
}

/* Al cargar la página, revisa si ya había una sesión activa */
(async () => {
  const { data: { session } } = await sb.auth.getSession();
  if (session) { await mostrarApp(session); }
})();

/* =====================================================================
   CARGA DE DATOS
   ===================================================================== */
async function cargarTodo() {
  const [materiales, tipos, combos, sesiones, ventas, settingsRes] = await Promise.all([
    sb.from('materials').select('*').order('nombre'),
    sb.from('workshop_types').select('*').order('nombre'),
    sb.from('combos').select('*').order('nombre'),
    sb.from('sessions').select('*').order('fecha', { ascending: false }),
    sb.from('sales').select('*').order('fecha', { ascending: false }),
    sb.from('settings').select('*').eq('id', 'main').maybeSingle()
  ]);
  DB.materiales = materiales.data || [];
  DB.tipos = tipos.data || [];
  DB.combos = combos.data || [];
  DB.sesiones = sesiones.data || [];
  DB.ventas = ventas.data || [];
  DB.settings = settingsRes.data || { cafe_precio: CAFE_DEFAULT };
}

/* =====================================================================
   NAVEGACIÓN
   ===================================================================== */
document.querySelectorAll('#menu [data-v]').forEach(b => {
  b.onclick = () => go(b.dataset.v);
});

function go(v) {
  document.querySelectorAll('#menu [data-v]').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  document.getElementById('app').innerHTML = V[v]();
}

const abrir = id => document.getElementById(id).classList.add('on');
const cerrar = id => document.getElementById(id).classList.remove('on');

const V = {};

/* =====================================================================
   INICIO
   ===================================================================== */
V.inicio = () => {
  const vendido = DB.sesiones.reduce((t, s) => t + num(s.total_taller), 0) + DB.ventas.reduce((t, v) => t + num(v.total), 0);
  const costo = DB.sesiones.reduce((t, s) => t + num(s.costo_mat), 0) + DB.ventas.reduce((t, v) => t + num(v.costo), 0);
  const cafe = DB.sesiones.reduce((t, s) => t + num(s.cafe_negocio), 0);
  const bajo = DB.materiales.filter(m => num(m.existencia) <= num(m.minimo)).length;
  return `
  <h2 class="titulo">Hola 👋</h2><p class="sub">Resumen rápido del negocio.</p>
  <div class="grid g4">
    <div class="kpi"><small>VENDIDO</small><b>${money(vendido)}</b></div>
    <div class="kpi"><small>COSTO MATERIAL</small><b>${money(costo)}</b></div>
    <div class="kpi"><small>UTILIDAD</small><b>${money(vendido - costo)}</b></div>
    <div class="kpi"><small>☕ CAFÉ (NEGOCIO)</small><b>${money(cafe)}</b></div>
  </div>
  <div class="card" style="margin-top:18px"><h3>Estado del inventario</h3>
    ${bajo ? `<p style="color:var(--rojo);font-weight:700">⚠ ${bajo} material(es) en stock bajo.</p>`
           : `<p style="color:var(--verde);font-weight:700">✅ Todo el inventario está por arriba del mínimo.</p>`}
  </div>`;
};

/* =====================================================================
   INVENTARIO
   ===================================================================== */
V.inventario = () => {
  const filas = DB.materiales.map(m => {
    const cu = costoUnit(m), pv = precioUnitSug(m), gan = gananciaUnit(m);
    const bajo = num(m.existencia) <= num(m.minimo);
    return `<tr>
      <td><b>${esc(m.nombre)}</b><span class="mut">${esc(m.categoria)}</span></td>
      <td>${num(m.existencia).toLocaleString('es-MX')} ${esc(m.unidad)}
          <span class="chip ${bajo ? 'bajo' : 'ok'}" style="margin-left:6px">${bajo ? 'Stock bajo' : 'Disponible'}</span></td>
      <td><b>${money(m.costo_adq)}</b><span class="mut">${num(m.cant_adq)} ${esc(m.unidad)} adquiridos</span></td>
      <td>${money(cu)}<span class="mut">/ ${esc(m.unidad)}</span></td>
      <td>${num(m.margen)}%</td>
      <td><b style="color:var(--morado2)">${money(pv)}</b><span class="mut">/ ${esc(m.unidad)}</span></td>
      <td style="color:var(--verde);font-weight:700">${money(gan)}<span class="mut">/ ${esc(m.unidad)}</span></td>
      <td><button class="btn sec mini" onclick="editarMat('${m.id}')">✏️ Editar</button></td>
    </tr>`;
  }).join('');
  const totalAdq = DB.materiales.reduce((t, m) => t + num(m.costo_adq), 0);
  const valorExist = DB.materiales.reduce((t, m) => t + costoUnit(m) * num(m.existencia), 0);
  const valorVenta = DB.materiales.reduce((t, m) => t + precioUnitSug(m) * num(m.existencia), 0);
  return `
  <h2 class="titulo">📦 Inventario</h2>
  <p class="sub">Existencias, costo de adquisición, costo unitario, margen, precio sugerido y ganancia por unidad.</p>
  <div class="grid g4">
    <div class="kpi"><small>TOTAL ADQUISICIÓN</small><b>${money(totalAdq)}</b></div>
    <div class="kpi"><small>VALOR EXISTENCIA (COSTO)</small><b>${money(valorExist)}</b></div>
    <div class="kpi"><small>VALOR EXISTENCIA (VENTA)</small><b>${money(valorVenta)}</b></div>
    <div class="kpi"><small>GANANCIA POTENCIAL</small><b>${money(valorVenta - valorExist)}</b></div>
  </div>
  <div style="margin:16px 0"><button class="btn" onclick="editarMat()">＋ Nuevo material</button></div>
  <div class="tabla-wrap"><table>
    <thead><tr><th>Material</th><th>Existencia</th><th>Adquisición</th><th>Costo unitario</th>
    <th>Margen</th><th>Precio sugerido</th><th>Ganancia</th><th>Acción</th></tr></thead>
    <tbody>${filas || `<tr><td colspan="8" style="text-align:center;color:var(--gris);padding:26px">Aún no hay materiales.</td></tr>`}</tbody>
  </table></div>`;
};

function editarMat(id) {
  const m = id ? mat(id) : { nombre: '', categoria: 'Otros', unidad: 'pieza', cant_adq: 1, costo_adq: 0, existencia: 0, minimo: 0, margen: 100 };
  document.getElementById('boxMat').innerHTML = `
  <div class="modal-head"><h3>📦 ${id ? 'Editar material' : 'Nuevo material'}</h3>
    <button class="cerrar" onclick="cerrar('mMat')">✕</button></div>
  <div class="grid g2">
    <div><label>Nombre</label><input id="f_nom" value="${esc(m.nombre)}"></div>
    <div><label>Categoría</label><select id="f_cat">
      ${['Pinturas', 'Piezas', 'Cerámica', 'Textil', 'Otros'].map(c => `<option ${c === m.categoria ? 'selected' : ''}>${c}</option>`).join('')}
    </select></div>
    <div><label>Unidad</label><select id="f_uni">
      ${['pieza', 'ml', 'metro', 'gramo', 'juego', 'set', 'hoja', 'impresión', 'pendiente'].map(u => `<option ${u === m.unidad ? 'selected' : ''}>${u}</option>`).join('')}
    </select></div>
    <div><label>Existencia actual</label><input type="number" id="f_exi" value="${num(m.existencia)}"></div>
    <div><label>Cantidad adquirida (total comprado)</label><input type="number" id="f_ca" value="${num(m.cant_adq)}" oninput="prevMat()"></div>
    <div><label>Costo total de adquisición</label><input type="number" id="f_co" value="${num(m.costo_adq)}" oninput="prevMat()"></div>
    <div><label>Stock mínimo</label><input type="number" id="f_min" value="${num(m.minimo)}"></div>
    <div><label>Margen de ganancia (%)</label><input type="number" id="f_mar" value="${num(m.margen)}" oninput="prevMat()"></div>
  </div>
  <div class="totales" id="prevMat"></div>
  <div class="nota">💡 El costo unitario sale de dividir el costo total entre la cantidad adquirida.</div>
  <div id="matError"></div>
  <div class="acciones">
    ${id ? `<button class="btn rojo" onclick="borrarMat('${id}')">Eliminar</button>` : ''}
    <button class="btn sec" onclick="cerrar('mMat')">Cancelar</button>
    <button class="btn" onclick="guardarMat('${id || ''}')">${id ? 'Guardar cambios' : 'Guardar material'}</button>
  </div>`;
  abrir('mMat'); prevMat();
}
function prevMat() {
  const ca = num(document.getElementById('f_ca').value), co = num(document.getElementById('f_co').value), mg = num(document.getElementById('f_mar').value);
  const cu = ca > 0 ? co / ca : 0, pv = cu * (1 + mg / 100);
  document.getElementById('prevMat').innerHTML = `
    <div class="linea"><span>Costo unitario</span><b>${money(cu)}</b></div>
    <div class="linea"><span>Precio sugerido de venta</span><b>${money(pv)}</b></div>
    <div class="linea final"><span>Ganancia por unidad</span><b style="color:var(--verde)">${money(pv - cu)}</b></div>`;
}
async function guardarMat(id) {
  const errBox = document.getElementById('matError'); errBox.innerHTML = '';
  const nombre = document.getElementById('f_nom').value.trim();
  const cantAdq = num(document.getElementById('f_ca').value);
  const costoAdq = num(document.getElementById('f_co').value);
  if (!nombre) return errBox.innerHTML = `<div class="error-box">Escribe el nombre del material.</div>`;
  if (cantAdq <= 0) return errBox.innerHTML = `<div class="error-box">La cantidad adquirida debe ser mayor que cero.</div>`;
  const payload = {
    ...(id ? { id } : {}), nombre, categoria: document.getElementById('f_cat').value, unidad: document.getElementById('f_uni').value,
    existencia: num(document.getElementById('f_exi').value), cant_adq: cantAdq, costo_adq: costoAdq,
    minimo: num(document.getElementById('f_min').value), margen: num(document.getElementById('f_mar').value)
  };
  const { error } = await sb.from('materials').upsert(payload);
  if (error) return errBox.innerHTML = `<div class="error-box">${esc(error.message)}</div>`;
  await cargarTodo(); cerrar('mMat'); go('inventario');
}
async function borrarMat(id) {
  if (!confirm('¿Eliminar este material?')) return;
  const { error } = await sb.from('materials').delete().eq('id', id);
  if (error) return alert(error.message);
  await cargarTodo(); cerrar('mMat'); go('inventario');
}

/* ---------------------------------------------------------------------
   Fila reutilizable "material + cantidad" (Talleres y Combos)
   --------------------------------------------------------------------- */
function opcionesMat(sel) {
  return DB.materiales.map(m => `<option value="${m.id}" ${m.id === sel ? 'selected' : ''}>${esc(m.nombre)} (${money(costoUnit(m))}/${esc(m.unidad)})</option>`).join('');
}
function filaMat(prefix, l = {}) {
  return `<div class="filaMat">
    <div><label>Material</label><select class="${prefix}m" onchange="${prefix === 't' ? 'prevTipo' : 'prevCombo'}()">${opcionesMat(l.material_id)}</select></div>
    <div><label>Cantidad</label><input type="number" class="${prefix}q" value="${l.cantidad ?? 1}" oninput="${prefix === 't' ? 'prevTipo' : 'prevCombo'}()"></div>
    <div></div><div></div>
    <div><button class="btn rojo mini" onclick="this.closest('.filaMat').remove();${prefix === 't' ? 'prevTipo' : 'prevCombo'}()">✕</button></div>
  </div>`;
}
function leerFilas(prefix, contenedorId) {
  return [...document.querySelectorAll(`#${contenedorId} .filaMat`)]
    .map(f => ({ material_id: f.querySelector(`.${prefix}m`).value, cantidad: num(f.querySelector(`.${prefix}q`).value) }))
    .filter(l => l.material_id && l.cantidad > 0);
}

/* =====================================================================
   TALLERES (tipos + sesiones registradas)
   ===================================================================== */
V.talleres = () => {
  const filas = DB.tipos.map(t => {
    const r = resumenTipo(t, 1);
    const cafe = num(DB.settings.cafe_precio || CAFE_DEFAULT);
    return `<tr>
      <td><b>${esc(t.nombre)}</b><span class="mut">${(t.materiales || []).length} materiales · ${num(t.duracion)} h</span></td>
      <td>${money(r.costoMat)}</td>
      <td><b>${money(r.precio)}</b></td>
      <td>${t.incluye_cafe ? `<b style="color:#92400e">${money(r.precio + cafe)}</b>` : '<span class="mut">Sin café</span>'}</td>
      <td style="color:var(--verde);font-weight:700">${money(r.utilidad)}</td>
      <td>${r.margenReal.toFixed(1)}%</td>
      <td><button class="btn mini" onclick="nuevaSesion('${t.id}')">Registrar</button>
          <button class="btn sec mini" onclick="editarTipo('${t.id}')">✏️</button></td>
    </tr>`;
  }).join('');
  const hist = DB.sesiones.map(s => `<tr>
      <td>${fmtFecha(s.fecha)}</td><td>${esc(s.tipo_nombre)}</td><td>${s.personas}</td>
      <td><b>${money(s.total_taller)}</b></td>
      <td>${s.total_cafe ? money(s.total_cafe) : '<span class="mut">—</span>'}</td>
      <td>${money(s.costo_mat)}</td>
      <td style="color:var(--verde);font-weight:700">${money(s.utilidad)}</td></tr>`).join('');
  return `
  <h2 class="titulo">🎨 Talleres</h2>
  <p class="sub">Cada tipo muestra su precio de venta y, cuando aplica, el total con café en un solo renglón.</p>
  <div style="margin-bottom:16px"><button class="btn" onclick="editarTipo()">＋ Nuevo tipo de taller</button></div>
  <div class="tabla-wrap"><table>
    <thead><tr><th>Taller</th><th>Costo material</th><th>Total taller</th><th>Total taller con café</th><th>Utilidad</th><th>Margen</th><th>Acción</th></tr></thead>
    <tbody>${filas || `<tr><td colspan="7" style="text-align:center;color:var(--gris);padding:26px">Aún no hay tipos de taller.</td></tr>`}</tbody>
  </table></div>
  <div class="card" style="margin-top:20px"><h3>Talleres realizados</h3>
    <div class="tabla-wrap"><table>
      <thead><tr><th>Fecha</th><th>Taller</th><th>Personas</th><th>Total taller</th><th>Total con café</th><th>Costo material</th><th>Utilidad</th></tr></thead>
      <tbody>${hist || `<tr><td colspan="7" style="text-align:center;color:var(--gris);padding:22px">Sin talleres registrados.</td></tr>`}</tbody>
    </table></div></div>`;
};

function editarTipo(id) {
  const t = id ? DB.tipos.find(x => x.id === id) : { nombre: '', duracion: 2.5, margen: 50, precio_final: 0, incluye_cafe: false, materiales: [] };
  document.getElementById('boxTipo').innerHTML = `
  <div class="modal-head"><h3>🎨 ${id ? 'Editar tipo de taller' : 'Nuevo tipo de taller'}</h3>
    <button class="cerrar" onclick="cerrar('mTipo')">✕</button></div>
  <div class="grid g2">
    <div><label>Nombre del taller</label><input id="t_nom" value="${esc(t.nombre)}"></div>
    <div><label>Duración estimada (horas)</label><input type="number" step="0.5" id="t_dur" value="${num(t.duracion)}" oninput="prevTipo()"></div>
    <div><label>Margen deseado (%)</label><input type="number" id="t_mar" value="${num(t.margen)}" oninput="prevTipo()"></div>
    <div><label>Precio final por persona (0 = usar el calculado)</label><input type="number" id="t_pf" value="${num(t.precio_final)}" oninput="prevTipo()"></div>
    <div><label>¿Incluye café?</label><select id="t_cafe" onchange="prevTipo()">
      <option value="no" ${!t.incluye_cafe ? 'selected' : ''}>No</option>
      <option value="si" ${t.incluye_cafe ? 'selected' : ''}>Sí (${money(DB.settings.cafe_precio || CAFE_DEFAULT)} por persona)</option>
    </select></div>
    <div><label>Personas (para ver el total del grupo)</label><input type="number" id="t_per" value="1" oninput="prevTipo()"></div>
  </div>
  <h3 style="margin:18px 0 10px">Materiales por persona</h3>
  <div id="t_lista">${(t.materiales && t.materiales.length ? t.materiales : [{}]).map(l => filaMat('t', l)).join('')}</div>
  <button class="btn sec mini" onclick="document.getElementById('t_lista').insertAdjacentHTML('beforeend', filaMat('t', {}));prevTipo()">＋ Agregar material</button>
  <div class="totales" id="prevTipo"></div>
  <div class="nota">☕ El café se cobra aparte a ${money(DB.settings.cafe_precio || CAFE_DEFAULT)} por persona y no se suma al costo de materiales.</div>
  <div id="tipoError"></div>
  <div class="acciones">
    ${id ? `<button class="btn rojo" onclick="borrarTipo('${id}')">Eliminar</button>` : ''}
    <button class="btn sec" onclick="cerrar('mTipo')">Cancelar</button>
    <button class="btn" onclick="guardarTipo('${id || ''}')">Guardar cambios</button>
  </div>`;
  abrir('mTipo'); prevTipo();
}
function prevTipo() {
  const materiales = leerFilas('t', 't_lista');
  const tTmp = { materiales, margen: num(document.getElementById('t_mar').value), precio_final: num(document.getElementById('t_pf').value),
                 duracion: num(document.getElementById('t_dur').value), incluye_cafe: document.getElementById('t_cafe').value === 'si' };
  const per = Math.max(1, num(document.getElementById('t_per').value));
  const r = resumenTipo(tTmp, per);
  document.getElementById('prevTipo').innerHTML = `
    <div class="linea"><span>Costo de materiales / persona</span><b>${money(r.costoMat)}</b></div>
    <div class="linea"><span>Precio por persona</span><b>${money(r.precio)}</b></div>
    <div class="linea"><span>Utilidad / persona</span><b style="color:var(--verde)">${money(r.utilidad)}</b></div>
    <div class="linea"><span>Margen real</span><b>${r.margenReal.toFixed(1)}%</b></div>
    <div class="linea"><span>Utilidad por hora estimada</span><b>${money(r.utilHora)}/h</b></div>
    <div class="linea final"><span>Total taller (${per} persona${per > 1 ? 's' : ''})</span><b>${money(r.totalTaller)}</b></div>
    ${tTmp.incluye_cafe ? `<div class="linea final cafe"><span>Total taller con café</span><b>${money(r.totalCafe)}</b></div>` : ''}`;
}
async function guardarTipo(id) {
  const errBox = document.getElementById('tipoError'); errBox.innerHTML = '';
  const nombre = document.getElementById('t_nom').value.trim();
  const materiales = leerFilas('t', 't_lista');
  if (!nombre) return errBox.innerHTML = `<div class="error-box">Ponle nombre al taller.</div>`;
  if (!materiales.length) return errBox.innerHTML = `<div class="error-box">Agrega al menos un material.</div>`;
  const payload = {
    ...(id ? { id } : {}), nombre, duracion: num(document.getElementById('t_dur').value), margen: num(document.getElementById('t_mar').value),
    precio_final: num(document.getElementById('t_pf').value), incluye_cafe: document.getElementById('t_cafe').value === 'si', materiales
  };
  const { error } = await sb.from('workshop_types').upsert(payload);
  if (error) return errBox.innerHTML = `<div class="error-box">${esc(error.message)}</div>`;
  await cargarTodo(); cerrar('mTipo'); go('talleres');
}
async function borrarTipo(id) {
  if (!confirm('¿Eliminar este tipo de taller?')) return;
  const { error } = await sb.from('workshop_types').delete().eq('id', id);
  if (error) return alert(error.message);
  await cargarTodo(); cerrar('mTipo'); go('talleres');
}

/* ---- Registrar taller impartido (sesión) ---- */
function nuevaSesion(id) {
  const t = DB.tipos.find(x => x.id === id);
  document.getElementById('boxSesion').innerHTML = `
  <div class="modal-head"><h3>🎨 Registrar taller — ${esc(t.nombre)}</h3>
    <button class="cerrar" onclick="cerrar('mSesion')">✕</button></div>
  <div class="grid g2">
    <div><label>Fecha</label><input type="date" id="s_fec" value="${hoy()}"></div>
    <div><label>Personas</label><input type="number" id="s_per" value="1" min="1" oninput="prevSesion('${id}')"></div>
    <div><label>¿Se cobró café?</label><select id="s_cafe" onchange="prevSesion('${id}')">
      <option value="${t.incluye_cafe ? 'si' : 'no'}" selected>${t.incluye_cafe ? 'Sí' : 'No'}</option>
      <option value="${t.incluye_cafe ? 'no' : 'si'}">${t.incluye_cafe ? 'No' : 'Sí'}</option></select></div>
  </div>
  <div class="totales" id="prevSesion"></div>
  <div class="nota">Al guardar se descuenta automáticamente el material del inventario.</div>
  <div id="sesionError"></div>
  <div class="acciones"><button class="btn sec" onclick="cerrar('mSesion')">Cancelar</button>
    <button class="btn" onclick="guardarSesion('${id}')">Guardar taller</button></div>`;
  abrir('mSesion'); prevSesion(id);
}
function prevSesion(id) {
  const t = { ...DB.tipos.find(x => x.id === id) };
  t.incluye_cafe = document.getElementById('s_cafe').value === 'si';
  const per = Math.max(1, num(document.getElementById('s_per').value));
  const r = resumenTipo(t, per);
  document.getElementById('prevSesion').innerHTML = `
    <div class="linea"><span>Costo de materiales</span><b>${money(r.costoTotal)}</b></div>
    <div class="linea"><span>Utilidad</span><b style="color:var(--verde)">${money(r.utilidadTotal)}</b></div>
    <div class="linea final"><span>Total taller</span><b>${money(r.totalTaller)}</b></div>
    ${t.incluye_cafe ? `<div class="linea final cafe"><span>Total taller con café</span><b>${money(r.totalCafe)}</b></div>` : ''}`;
}
async function guardarSesion(id) {
  const errBox = document.getElementById('sesionError'); errBox.innerHTML = '';
  const t = { ...DB.tipos.find(x => x.id === id) };
  t.incluye_cafe = document.getElementById('s_cafe').value === 'si';
  const per = Math.max(1, num(document.getElementById('s_per').value));
  const r = resumenTipo(t, per);

  // 1) Verificar inventario suficiente
  for (const l of (t.materiales || [])) {
    const m = mat(l.material_id);
    const requerido = num(l.cantidad) * per;
    if (!m || num(m.existencia) < requerido) {
      return errBox.innerHTML = `<div class="error-box">Inventario insuficiente de ${m ? esc(m.nombre) : 'material'}.</div>`;
    }
  }
  // 2) Descontar inventario
  for (const l of (t.materiales || [])) {
    const m = mat(l.material_id);
    const nuevaExistencia = num(m.existencia) - num(l.cantidad) * per;
    const { error } = await sb.from('materials').update({ existencia: nuevaExistencia }).eq('id', m.id);
    if (error) return errBox.innerHTML = `<div class="error-box">${esc(error.message)}</div>`;
  }
  // 3) Registrar la sesión
  const { error } = await sb.from('sessions').insert({
    fecha: document.getElementById('s_fec').value || hoy(), tipo_id: t.id, tipo_nombre: t.nombre, personas: per,
    total_taller: r.totalTaller, total_cafe: r.totalCafe, cafe_negocio: r.cafeNegocio, costo_mat: r.costoTotal, utilidad: r.utilidadTotal
  });
  if (error) return errBox.innerHTML = `<div class="error-box">${esc(error.message)}</div>`;
  await cargarTodo(); cerrar('mSesion'); go('talleres');
}

/* =====================================================================
   JUEGOS / COMBOS
   ===================================================================== */
V.combos = () => {
  const filas = DB.combos.map(c => {
    const co = comboCosto(c), pv = comboPrecio(c), g = comboGanancia(c);
    const contenido = (c.materiales || []).map(l => { const m = mat(l.material_id); return m ? `${esc(m.nombre)} ×${l.cantidad}${m.unidad === 'ml' ? ' ml' : ''}` : ''; }).join('<br>');
    return `<tr>
      <td><b>${esc(c.nombre)}</b><span class="mut">${(c.materiales || []).length} material(es)</span></td>
      <td>${contenido}</td>
      <td>${money(co)}</td>
      <td>${co > 0 ? ((pv / co - 1) * 100).toFixed(0) : 0}%</td>
      <td><b style="color:var(--morado2)">${money(pv)}</b></td>
      <td style="color:var(--verde);font-weight:700">${money(g)}</td>
      <td><button class="btn sec mini" onclick="editarCombo('${c.id}')">✏️ Editar</button></td>
    </tr>`;
  }).join('');
  return `
  <h2 class="titulo">🎁 Juegos / Combos</h2>
  <p class="sub">Arma un juego con varios materiales, asígnale margen y véndelo con un solo clic. El inventario se descuenta solo.</p>
  <div style="margin-bottom:16px"><button class="btn" onclick="editarCombo()">＋ Nuevo juego / combo</button></div>
  <div class="tabla-wrap"><table>
    <thead><tr><th>Juego</th><th>Contenido</th><th>Costo</th><th>Margen</th><th>Precio de venta</th><th>Ganancia</th><th>Acción</th></tr></thead>
    <tbody>${filas || `<tr><td colspan="7" style="text-align:center;color:var(--gris);padding:26px">Aún no hay juegos o combos creados.</td></tr>`}</tbody>
  </table></div>`;
};

function editarCombo(id) {
  const c = id ? DB.combos.find(x => x.id === id) : { nombre: '', margen: 100, precio_final: 0, materiales: [] };
  document.getElementById('boxCombo').innerHTML = `
  <div class="modal-head"><h3>🎁 ${id ? 'Editar juego' : 'Nuevo juego / combo'}</h3>
    <button class="cerrar" onclick="cerrar('mCombo')">✕</button></div>
  <div class="grid g2">
    <div><label>Nombre del juego</label><input id="c_nom" value="${esc(c.nombre)}"></div>
    <div><label>Margen deseado (%)</label><input type="number" id="c_mar" value="${num(c.margen)}" oninput="prevCombo()"></div>
    <div><label>Precio final (opcional, 0 = usar el sugerido)</label><input type="number" id="c_pf" value="${num(c.precio_final)}" oninput="prevCombo()"></div>
  </div>
  <h3 style="margin:18px 0 10px">Materiales que lo forman</h3>
  <div id="c_lista">${(c.materiales && c.materiales.length ? c.materiales : [{}]).map(l => filaMat('c', l)).join('')}</div>
  <button class="btn sec mini" onclick="document.getElementById('c_lista').insertAdjacentHTML('beforeend', filaMat('c', {}));prevCombo()">＋ Agregar material</button>
  <div class="totales" id="prevCombo"></div>
  <div id="comboError"></div>
  <div class="acciones">
    ${id ? `<button class="btn rojo" onclick="borrarCombo('${id}')">Eliminar</button>` : ''}
    <button class="btn sec" onclick="cerrar('mCombo')">Cancelar</button>
    <button class="btn" onclick="guardarCombo('${id || ''}')">Guardar</button>
  </div>`;
  abrir('mCombo'); prevCombo();
}
function prevCombo() {
  const lista = leerFilas('c', 'c_lista');
  const co = costoLista(lista);
  const mg = num(document.getElementById('c_mar').value), pf = num(document.getElementById('c_pf').value);
  const pv = pf > 0 ? pf : co * (1 + mg / 100);
  document.getElementById('prevCombo').innerHTML = `
    <div class="linea"><span>Costo total del juego</span><b>${money(co)}</b></div>
    <div class="linea"><span>Margen real</span><b>${co > 0 ? ((pv / co - 1) * 100).toFixed(1) : 0}%</b></div>
    <div class="linea"><span>Ganancia</span><b style="color:var(--verde)">${money(pv - co)}</b></div>
    <div class="linea final"><span>Precio de venta del juego</span><b>${money(pv)}</b></div>`;
}
async function guardarCombo(id) {
  const errBox = document.getElementById('comboError'); errBox.innerHTML = '';
  const nombre = document.getElementById('c_nom').value.trim();
  const materiales = leerFilas('c', 'c_lista');
  if (!nombre) return errBox.innerHTML = `<div class="error-box">Ponle nombre al juego.</div>`;
  if (!materiales.length) return errBox.innerHTML = `<div class="error-box">Agrega al menos un material.</div>`;
  const payload = { ...(id ? { id } : {}), nombre, margen: num(document.getElementById('c_mar').value), precio_final: num(document.getElementById('c_pf').value), materiales };
  const { error } = await sb.from('combos').upsert(payload);
  if (error) return errBox.innerHTML = `<div class="error-box">${esc(error.message)}</div>`;
  await cargarTodo(); cerrar('mCombo'); go('combos');
}
async function borrarCombo(id) {
  if (!confirm('¿Eliminar este juego?')) return;
  const { error } = await sb.from('combos').delete().eq('id', id);
  if (error) return alert(error.message);
  await cargarTodo(); cerrar('mCombo'); go('combos');
}

/* =====================================================================
   VENTAS (materiales o juegos vendidos fuera de un taller)
   ===================================================================== */
V.ventas = () => {
  const filas = DB.ventas.map(v => `<tr>
      <td>${fmtFecha(v.fecha)}</td><td><b>${esc(v.nombre)}</b><span class="mut">${v.tipo === 'combo' ? 'Juego / combo' : 'Material'}</span></td>
      <td>${v.cantidad}</td><td>${money(v.precio)}</td><td><b>${money(v.total)}</b></td>
      <td>${money(v.costo)}</td><td style="color:var(--verde);font-weight:700">${money(v.total - v.costo)}</td></tr>`).join('');
  return `
  <h2 class="titulo">🛍️ Ventas</h2>
  <p class="sub">Para productos y juegos vendidos fuera de un taller. El precio se propone solo, ya con su margen.</p>
  <div style="margin-bottom:16px"><button class="btn" onclick="nuevaVenta()">＋ Nueva venta</button></div>
  <div class="tabla-wrap"><table>
    <thead><tr><th>Fecha</th><th>Producto</th><th>Cantidad</th><th>Precio unitario</th><th>Total</th><th>Costo</th><th>Ganancia</th></tr></thead>
    <tbody>${filas || `<tr><td colspan="7" style="text-align:center;color:var(--gris);padding:26px">Sin ventas registradas.</td></tr>`}</tbody>
  </table></div>`;
};

function itemVenta() {
  const [tipo, id] = document.getElementById('v_prod').value.split(':');
  if (tipo === 'combo') { const c = DB.combos.find(x => x.id === id); return { tipo, id, nombre: c.nombre, costo: comboCosto(c), sug: comboPrecio(c), materiales: c.materiales }; }
  const m = mat(id); return { tipo, id, nombre: m.nombre, costo: costoUnit(m), sug: precioUnitSug(m), materiales: [{ material_id: m.id, cantidad: 1 }] };
}
function nuevaVenta() {
  if (!DB.combos.length && !DB.materiales.length) return alert('Primero registra materiales en Inventario.');
  const opts = DB.combos.map(c => `<option value="combo:${c.id}">🎁 ${esc(c.nombre)}</option>`).join('')
             + DB.materiales.map(m => `<option value="mat:${m.id}">${esc(m.nombre)}</option>`).join('');
  document.getElementById('boxVenta').innerHTML = `
  <div class="modal-head"><h3>🛍️ Nueva venta</h3><button class="cerrar" onclick="cerrar('mVenta')">✕</button></div>
  <div class="grid g2">
    <div><label>Producto o juego</label><select id="v_prod" onchange="autoPrecio()">${opts}</select></div>
    <div><label>Cantidad</label><input type="number" id="v_cant" value="1" min="1" oninput="prevVenta()"></div>
    <div><label>Precio unitario de venta (sugerido, puedes cambiarlo)</label><input type="number" id="v_pre" oninput="prevVenta()"></div>
    <div><label>Fecha</label><input type="date" id="v_fec" value="${hoy()}"></div>
  </div>
  <div class="totales" id="prevVenta"></div>
  <div class="nota">💡 El precio se llena solo con el margen configurado. Puedes ajustarlo si das promoción.</div>
  <div id="ventaError"></div>
  <div class="acciones"><button class="btn sec" onclick="cerrar('mVenta')">Cancelar</button>
    <button class="btn" onclick="guardarVenta()">Registrar venta</button></div>`;
  abrir('mVenta'); autoPrecio();
}
function autoPrecio() { document.getElementById('v_pre').value = itemVenta().sug.toFixed(2); prevVenta(); }
function prevVenta() {
  const it = itemVenta(), c = Math.max(1, num(document.getElementById('v_cant').value)), p = num(document.getElementById('v_pre').value);
  const total = p * c, costo = it.costo * c, gan = total - costo;
  document.getElementById('prevVenta').innerHTML = `
    <div class="linea"><span>Costo unitario</span><b>${money(it.costo)}</b></div>
    <div class="linea"><span>Precio sugerido</span><b>${money(it.sug)}</b></div>
    <div class="linea"><span>Costo total</span><b>${money(costo)}</b></div>
    <div class="linea"><span>Ganancia</span><b style="color:${gan < 0 ? 'var(--rojo)' : 'var(--verde)'}">${money(gan)}</b></div>
    <div class="linea final"><span>Total de la venta</span><b>${money(total)}</b></div>`;
}
async function guardarVenta() {
  const errBox = document.getElementById('ventaError'); errBox.innerHTML = '';
  const it = itemVenta(), c = Math.max(1, num(document.getElementById('v_cant').value)), p = num(document.getElementById('v_pre').value);
  if (p <= 0) return errBox.innerHTML = `<div class="error-box">Captura un precio de venta válido.</div>`;

  // 1) Verificar y descontar inventario de cada material involucrado
  for (const l of it.materiales) {
    const m = mat(l.material_id);
    const requerido = num(l.cantidad) * c;
    if (!m || num(m.existencia) < requerido) return errBox.innerHTML = `<div class="error-box">Inventario insuficiente de ${m ? esc(m.nombre) : 'material'}.</div>`;
  }
  for (const l of it.materiales) {
    const m = mat(l.material_id);
    const { error } = await sb.from('materials').update({ existencia: num(m.existencia) - num(l.cantidad) * c }).eq('id', m.id);
    if (error) return errBox.innerHTML = `<div class="error-box">${esc(error.message)}</div>`;
  }
  // 2) Registrar la venta
  const { error } = await sb.from('sales').insert({
    fecha: document.getElementById('v_fec').value || hoy(), tipo: it.tipo === 'combo' ? 'combo' : 'material', referencia_id: it.id,
    nombre: it.nombre, cantidad: c, precio: p, total: p * c, costo: it.costo * c
  });
  if (error) return errBox.innerHTML = `<div class="error-box">${esc(error.message)}</div>`;
  await cargarTodo(); cerrar('mVenta'); go('ventas');
}

/* =====================================================================
   RESULTADOS
   ===================================================================== */
V.resultados = () => {
  const vT = DB.sesiones.reduce((t, s) => t + num(s.total_taller), 0);
  const vV = DB.ventas.reduce((t, v) => t + num(v.total), 0);
  const cT = DB.sesiones.reduce((t, s) => t + num(s.costo_mat), 0);
  const cV = DB.ventas.reduce((t, v) => t + num(v.costo), 0);
  const cafe = DB.sesiones.reduce((t, s) => t + num(s.cafe_negocio), 0);
  const vendido = vT + vV, costo = cT + cV, util = vendido - costo;
  return `
  <h2 class="titulo">📊 Resultados</h2><p class="sub">Lo importante, sin llenar la pantalla de indicadores.</p>
  <div class="grid g4">
    <div class="kpi"><small>VENDIDO</small><b>${money(vendido)}</b></div>
    <div class="kpi"><small>COSTO DE MATERIALES</small><b>${money(costo)}</b></div>
    <div class="kpi"><small>UTILIDAD</small><b>${money(util)}</b></div>
    <div class="kpi"><small>MARGEN</small><b>${vendido > 0 ? (util / vendido * 100).toFixed(1) : 0}%</b></div>
  </div>
  <div class="card" style="margin-top:18px"><h3>Desglose</h3>
    <div class="linea"><span>Talleres</span><b>${money(vT)}</b></div>
    <div class="linea"><span>Ventas de productos y juegos</span><b>${money(vV)}</b></div>
    <div class="linea cafe"><span>☕ Café para el negocio</span><b>${money(cafe)}</b></div>
    <div class="linea final"><span>Total ingresado con café</span><b>${money(vendido + cafe)}</b></div>
  </div>`;
};

/* =====================================================================
   ADMINISTRACIÓN
   ===================================================================== */
V.admin = () => `
  <h2 class="titulo">⚙️ Administración</h2><p class="sub">Configura una vez y simplifica la operación diaria.</p>
  <div class="grid g2">
    <div class="card"><h3>🎨 Tipos de taller</h3><p class="sub">Materiales por persona, margen, precio y café.</p>
      <button class="btn" onclick="editarTipo()">＋ Crear tipo</button></div>
    <div class="card"><h3>🎁 Juegos / combos</h3><p class="sub">Conjuntos con costo, margen y ganancia propia.</p>
      <button class="btn" onclick="editarCombo()">＋ Crear juego</button></div>
    <div class="card"><h3>📦 Materiales</h3><p class="sub">Existencia, unidad, costo, margen y mínimo.</p>
      <button class="btn" onclick="editarMat()">＋ Material</button></div>
    <div class="card"><h3>☕ Café</h3><p class="sub">Precio del café por persona.</p>
      <label>Precio del café</label><input type="number" id="cfgCafe" value="${num(DB.settings.cafe_precio || CAFE_DEFAULT)}">
      <button class="btn" style="margin-top:10px" onclick="guardarConfig()">Guardar</button></div>
    <div class="card"><h3>💾 Respaldo</h3><p class="sub">Descarga toda tu información en un archivo JSON.</p>
      <button class="btn" onclick="respaldar()">↓ Descargar respaldo</button></div>
    <div class="card"><h3>👤 Usuarios</h3><p class="sub">Para dar de alta a alguien más, entra a Supabase → Authentication → Users → Add user. No hay registro público.</p></div>
  </div>`;

async function guardarConfig() {
  const cafe_precio = num(document.getElementById('cfgCafe').value);
  const { error } = await sb.from('settings').upsert({ id: 'main', cafe_precio });
  if (error) return alert(error.message);
  await cargarTodo(); go('admin');
}
async function respaldar() {
  const data = { exportado_en: new Date().toISOString(), materiales: DB.materiales, tipos: DB.tipos, combos: DB.combos, sesiones: DB.sesiones, ventas: DB.ventas, settings: DB.settings };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'respaldo_talleres_' + hoy() + '.json';
  a.click();
}
