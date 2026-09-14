/* =====================================================================
   TALLERES CREATIVOS · v2.1.0
   Un solo archivo de lógica, sin frameworks ni módulos raros.
   Los datos viven en Supabase (Postgres + Auth). Todo lo demás
   (cálculos, pantallas, modales) es JavaScript plano.

   "Talleres" funciona en 3 niveles:

   1) 🎁 Juegos/Combos (ya existía) = el catálogo de "qué taller se
      puede hacer" (ej. "Taller Tetera", "Taller Cerámica"). Aquí SÍ
      se definen materiales, margen y precio — se configura una sola
      vez, no cada vez que agendas.

   2) 🎨 Taller / Nueva inscripción (el evento que se agenda) = solo
      pide: Nombre del taller/evento, Fecha, Horario, Cupo (máximo de
      personas) y Duración estimada. NADA de materiales ni clientes.

   3) 👤 Participantes = dentro de cada taller creado, se agrega a
      cada persona con: Nombre, Teléfono (opcional) y qué Juego(s)/
      Combo(s) va a hacer — puede elegir UNO O VARIOS a la vez (v2.1.0:
      antes solo permitía elegir uno; ahora Juan puede hacer, por
      ejemplo, "Taller Tetera" + "Taller Tazas" en la misma inscripción,
      y su monto se suma automáticamente). El café es una sola opción
      por persona (no se repite por cada taller que elija). El primero
      agregado queda como "titular" del evento.

   El dinero se maneja en UNA sola cuenta compartida por todo el evento
   (no una por persona): un total combinado, un solo saldo, y el
   anticipo siempre es automáticamente el 50% de ese total.

   Al agregar un participante se descuenta de inmediato el inventario
   según los materiales de TODOS los talleres que eligió; al quitarlo,
   se restaura todo junto.

   (Se conservan las correcciones de versiones anteriores: contenido de
   combos, precio sugerido automático con casilla, y el precio de un
   combo usado como ingrediente = su venta, no su costo crudo.)
   ===================================================================== */

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const money = n => '$' + (Number(n) || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = n => Number(n) || 0;
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const hoy = () => new Date().toISOString().slice(0, 10);
const fmtFecha = f => f ? new Date(f).toLocaleDateString('es-MX') : '';

const CAFE_DEFAULT = 59;

/* Caché de datos en memoria, se recarga después de cada guardado */
let DB = {
  materiales: [], combos: [],
  reservas: [], participantes: [], participanteTalleres: [], pagos: [],
  ventas: [], sesionesAntiguas: [],
  settings: { cafe_precio: CAFE_DEFAULT }
};

/* Filtro de fechas para la lista de inscripciones */
let filtroInscripciones = { desde: '', hasta: '' };

const mat = id => DB.materiales.find(m => m.id === id);
const combo = id => DB.combos.find(c => c.id === id);
const reserva = id => DB.reservas.find(r => r.id === id);

/* ---------------------------------------------------------------------
   REFERENCIAS "mat:<id>" / "combo:<id>" — usadas dentro de la receta de
   un Juego/Combo (que solo admite materiales sueltos). parseRef()
   también acepta datos "viejos" guardados sin prefijo.
   --------------------------------------------------------------------- */
function parseRef(ref) {
  if (typeof ref !== 'string' || !ref) return ['mat', ''];
  const idx = ref.indexOf(':');
  if (idx === -1) return ['mat', ref];
  return [ref.slice(0, idx), ref.slice(idx + 1)];
}
const refMat = id => `mat:${id}`;

/* ---------------------------------------------------------------------
   CÁLCULOS (mismas fórmulas de siempre)
   --------------------------------------------------------------------- */
const costoUnit = m => num(m.cant_adq) > 0 ? num(m.costo_adq) / num(m.cant_adq) : 0;
const precioUnitSug = m => costoUnit(m) * (1 + num(m.margen) / 100);
const gananciaUnit = m => precioUnitSug(m) - costoUnit(m);

function costoUnitRef(ref) {
  const [, id] = parseRef(ref);
  const m = mat(id); return m ? costoUnit(m) : 0;
}
function costoLista(lista) {
  return (lista || []).reduce((t, l) => t + costoUnitRef(l.material_id) * num(l.cantidad), 0);
}
function comboCosto(c) { return costoLista(c.materiales); }
function comboPrecio(c) { const co = comboCosto(c); return num(c.precio_final) > 0 ? num(c.precio_final) : co * (1 + num(c.margen) / 100); }
function comboGanancia(c) { return comboPrecio(c) - comboCosto(c); }
function contenidoTexto(lista) {
  return (lista || []).map(l => {
    const [, id] = parseRef(l.material_id);
    const m = mat(id); return m ? `${esc(m.nombre)} ×${l.cantidad}${m.unidad === 'ml' ? ' ml' : ''}` : '';
  }).filter(Boolean).join('<br>');
}

/** Expande una receta de materiales a un Map(materialId -> cantidadTotal), multiplicado por un factor. */
function expandirReceta(lista, factor) {
  const mapa = new Map();
  (lista || []).forEach(l => {
    const [, id] = parseRef(l.material_id);
    if (!id) return;
    mapa.set(id, (mapa.get(id) || 0) + num(l.cantidad) * factor);
  });
  return mapa;
}

/* ---------------------------------------------------------------------
   INSCRIPCIONES Y PARTICIPANTES
   --------------------------------------------------------------------- */
function participantesDe(reservaId) {
  return DB.participantes.filter(p => p.reserva_id === reservaId).sort((a, b) => (a.created_at > b.created_at ? 1 : -1));
}
/** Lista de talleres (uno o varios) que eligió un participante. */
function talleresDeParticipante(participanteId) {
  return DB.participanteTalleres.filter(t => t.participante_id === participanteId);
}
/** Texto legible "Tetera + Tazas" para mostrar en tablas. */
function nombresTalleresTexto(participanteId) {
  const ts = talleresDeParticipante(participanteId);
  return ts.length ? ts.map(t => esc(t.combo_nombre)).join(' + ') : '<span class="mut">—</span>';
}
/** Junta los materiales (con su prefijo) de TODOS los talleres elegidos por un participante, para descontar/restaurar inventario en una sola operación. */
function materialesCombinadosParticipante(participanteId) {
  const ts = talleresDeParticipante(participanteId);
  return ts.flatMap(t => t.materiales_snapshot || []);
}
function titularDe(reservaId) {
  const ps = participantesDe(reservaId);
  return ps.find(p => p.es_titular) || ps[0] || null;
}
function hayCupo(r) { return participantesDe(r.id).length < num(r.cupo); }

/** Costo de materiales de TODOS los talleres que eligió un participante. */
function costoTotalParticipante(participanteId) {
  return talleresDeParticipante(participanteId).reduce((t, x) => t + num(x.costo_taller), 0);
}
function totalReserva(reservaId) { return participantesDe(reservaId).reduce((t, p) => t + num(p.monto_total), 0); }
function pagadoReserva(reservaId) { return DB.pagos.filter(p => p.reserva_id === reservaId).reduce((t, p) => t + num(p.monto), 0); }
function saldoReserva(reservaId) { const s = totalReserva(reservaId) - pagadoReserva(reservaId); return s > 0.004 ? s : 0; }
function estadoPagoReserva(reservaId) {
  const total = totalReserva(reservaId), pagado = pagadoReserva(reservaId);
  if (total <= 0) return { label: '—', clase: '' };
  if (pagado <= 0.004) return { label: '🔴 Pendiente', clase: 'bajo' };
  if (pagado >= total - 0.004) return { label: '🟢 Pagado', clase: 'ok' };
  return { label: '🟡 Parcial', clase: 'warn' };
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

(async () => {
  const { data: { session } } = await sb.auth.getSession();
  if (session) { await mostrarApp(session); }
})();

/* =====================================================================
   CARGA DE DATOS
   ===================================================================== */
async function cargarTodo() {
  const [materiales, combos, reservas, participantes, participanteTalleres, ventas, pagos, sesionesAntiguas, settingsRes] = await Promise.all([
    sb.from('materials').select('*').order('nombre'),
    sb.from('combos').select('*').order('nombre'),
    sb.from('reservas').select('*').order('fecha', { ascending: false }),
    sb.from('reserva_participantes').select('*').order('created_at'),
    sb.from('participante_talleres').select('*').order('created_at'),
    sb.from('sales').select('*').order('fecha', { ascending: false }),
    sb.from('pagos').select('*').order('fecha', { ascending: false }),
    sb.from('sessions').select('*').order('fecha', { ascending: false }),
    sb.from('settings').select('*').eq('id', 'main').maybeSingle()
  ]);
  DB.materiales = materiales.data || [];
  DB.combos = combos.data || [];
  DB.reservas = reservas.data || [];
  DB.participantes = participantes.data || [];
  DB.participanteTalleres = participanteTalleres.data || [];
  DB.ventas = ventas.data || [];
  DB.pagos = pagos.data || [];
  DB.sesionesAntiguas = sesionesAntiguas.data || [];
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
  const vT = DB.participantes.reduce((t, p) => t + num(p.monto_total), 0);
  const vV = DB.ventas.reduce((t, v) => t + num(v.total), 0);
  const cT = DB.participantes.reduce((t, p) => t + costoTotalParticipante(p.id), 0);
  const cV = DB.ventas.reduce((t, v) => t + num(v.costo), 0);
  const cafeTotal = DB.participantes.reduce((t, p) => t + num(p.cafe_monto), 0);
  const vendido = vT + vV, costo = cT + cV;
  const bajo = DB.materiales.filter(m => num(m.existencia) <= num(m.minimo)).length;
  const porCobrar = DB.reservas.reduce((t, r) => t + saldoReserva(r.id), 0);
  return `
  <h2 class="titulo">Hola 👋</h2><p class="sub">Resumen rápido del negocio.</p>
  <div class="grid g4">
    <div class="kpi"><small>VENDIDO</small><b>${money(vendido)}</b></div>
    <div class="kpi"><small>COSTO MATERIAL</small><b>${money(costo)}</b></div>
    <div class="kpi"><small>UTILIDAD</small><b>${money(vendido - costo)}</b></div>
    <div class="kpi"><small>☕ CAFÉ (NEGOCIO)</small><b>${money(cafeTotal)}</b></div>
  </div>
  <div class="grid g4" style="margin-top:14px">
    <div class="kpi" style="${porCobrar > 0 ? 'background:#fff5d8' : ''}"><small>POR COBRAR (INSCRIPCIONES)</small><b style="${porCobrar > 0 ? 'color:#9a6d00' : ''}">${money(porCobrar)}</b></div>
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
   Filas "material + cantidad" reutilizadas al armar la receta de un
   Juego/Combo (único lugar donde ahora se seleccionan materiales).
   --------------------------------------------------------------------- */
function etiquetaMaterial(m) {
  return `${esc(m.nombre)} — costo ${money(costoUnit(m))}/${esc(m.unidad)} · venta sug. ${money(precioUnitSug(m))}/${esc(m.unidad)}`;
}
function opcionesSoloMateriales(sel) {
  const [, selId] = parseRef(sel || '');
  return DB.materiales.map(m => {
    const val = refMat(m.id);
    const selected = selId === m.id;
    return `<option value="${val}" ${selected ? 'selected' : ''}>${etiquetaMaterial(m)}</option>`;
  }).join('');
}
function filaMat(l = {}) {
  return `<div class="filaMat">
    <div><label>Material</label><select class="cm" onchange="prevCombo()">${opcionesSoloMateriales(l.material_id)}</select></div>
    <div><label>Cantidad</label><input type="number" class="cq" value="${l.cantidad ?? 1}" min="0" step="0.01" oninput="prevCombo()"></div>
    <div></div><div></div>
    <div><button type="button" class="btn rojo mini" onclick="this.closest('.filaMat').remove();prevCombo()">✕</button></div>
  </div>`;
}
function leerFilasCombo() {
  return [...document.querySelectorAll(`#c_lista .filaMat`)]
    .map(f => ({ material_id: f.querySelector('.cm').value, cantidad: num(f.querySelector('.cq').value) }))
    .filter(l => l.material_id && l.cantidad > 0);
}
function agregarTodasPinturas() {
  const pinturas = DB.materiales.filter(m => m.categoria === 'Pinturas');
  if (!pinturas.length) { alert('No tienes materiales en la categoría "Pinturas" todavía. Agrégalos primero en Inventario.'); return; }
  const respuesta = prompt('¿Cuántos ml de cada color quieres asignar? (podrás ajustar cada color después)', '10');
  if (respuesta === null) return;
  const base = num(respuesta) > 0 ? num(respuesta) : 10;
  const yaPuestos = new Set(leerFilasCombo().map(l => l.material_id));
  const contenedor = document.getElementById('c_lista');
  let agregadas = 0;
  pinturas.forEach(m => {
    const val = refMat(m.id);
    if (yaPuestos.has(val)) return;
    contenedor.insertAdjacentHTML('beforeend', filaMat({ material_id: val, cantidad: base }));
    agregadas++;
  });
  prevCombo();
  if (!agregadas) alert('Ya tenías todas las pinturas agregadas en esta lista.');
}

/* =====================================================================
   JUEGOS / COMBOS  (catálogo de "qué taller se puede hacer")
   ===================================================================== */
V.combos = () => {
  const filas = DB.combos.map(c => {
    const co = comboCosto(c), pv = comboPrecio(c), g = comboGanancia(c);
    const contenido = contenidoTexto(c.materiales);
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
  <p class="sub">Este es tu catálogo de talleres: cada juego (materiales + margen + precio) es una opción que los participantes podrán elegir al inscribirse en 📅 Talleres.</p>
  <div style="margin-bottom:16px"><button class="btn" onclick="editarCombo()">＋ Nuevo juego / combo</button></div>
  <div class="tabla-wrap"><table>
    <thead><tr><th>Juego</th><th>Contenido</th><th>Costo</th><th>Margen</th><th>Precio de venta</th><th>Ganancia</th><th>Acción</th></tr></thead>
    <tbody>${filas || `<tr><td colspan="7" style="text-align:center;color:var(--gris);padding:26px">Aún no hay juegos o combos creados.</td></tr>`}</tbody>
  </table></div>`;
};

function editarCombo(id) {
  const c = id ? combo(id) : { nombre: '', margen: 100, precio_final: 0, materiales: [] };
  const autoInicial = !(num(c.precio_final) > 0);
  document.getElementById('boxCombo').innerHTML = `
  <div class="modal-head"><h3>🎁 ${id ? 'Editar juego' : 'Nuevo juego / combo'}</h3>
    <button class="cerrar" onclick="cerrar('mCombo')">✕</button></div>
  <div class="grid g2">
    <div><label>Nombre del juego (así lo verán al elegir su taller)</label><input id="c_nom" value="${esc(c.nombre)}" placeholder="Ej. Taller Cerámica"></div>
    <div><label>Margen deseado (%)</label><input type="number" id="c_mar" value="${num(c.margen)}" oninput="prevCombo()"></div>
    <div>
      <label>Precio final de venta</label>
      <label style="display:flex;align-items:center;gap:6px;font-weight:400;font-size:12px;color:var(--suave);margin:2px 0 6px">
        <input type="checkbox" id="c_pf_auto" ${autoInicial ? 'checked' : ''} onchange="prevCombo()" style="width:auto">
        Usar precio sugerido automáticamente (recomendado)
      </label>
      <input type="number" id="c_pf" value="${num(c.precio_final)}" oninput="prevCombo()">
    </div>
  </div>
  <h3 style="margin:18px 0 10px">Materiales que lo forman</h3>
  <div id="c_lista">${(c.materiales || []).map(l => filaMat(l)).join('')}</div>
  <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">
    <button class="btn sec mini" onclick="document.getElementById('c_lista').insertAdjacentHTML('beforeend', filaMat({}));prevCombo()">＋ Agregar material</button>
    <button class="btn sec mini" onclick="agregarTodasPinturas()">🎨 Agregar todas las pinturas</button>
  </div>
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
  const lista = leerFilasCombo();
  const co = costoLista(lista);
  const auto = document.getElementById('c_pf_auto').checked;
  const mg = num(document.getElementById('c_mar').value);
  const pfField = document.getElementById('c_pf');
  pfField.disabled = auto;
  let pv;
  if (auto) { pv = co * (1 + mg / 100); pfField.value = pv.toFixed(2); } else { pv = num(pfField.value); }
  document.getElementById('prevCombo').innerHTML = `
    <div class="linea"><span>Costo total del juego</span><b>${money(co)}</b></div>
    <div class="linea"><span>Margen real</span><b>${co > 0 ? ((pv / co - 1) * 100).toFixed(1) : 0}%</b></div>
    <div class="linea"><span>Ganancia</span><b style="color:var(--verde)">${money(pv - co)}</b></div>
    <div class="linea final"><span>Precio de venta del juego</span><b>${money(pv)}</b></div>
    ${mg <= 0 && auto ? `<div class="error-box" style="margin-top:10px">⚠ Tu margen está en 0%: vas a vender exactamente al costo, sin ganancia.</div>` : ''}`;
}
async function guardarCombo(id) {
  const errBox = document.getElementById('comboError'); errBox.innerHTML = '';
  const nombre = document.getElementById('c_nom').value.trim();
  const materiales = leerFilasCombo();
  if (!nombre) return errBox.innerHTML = `<div class="error-box">Ponle nombre al juego.</div>`;
  if (!materiales.length) return errBox.innerHTML = `<div class="error-box">Agrega al menos un material.</div>`;
  const auto = document.getElementById('c_pf_auto').checked;
  const payload = { ...(id ? { id } : {}), nombre, margen: num(document.getElementById('c_mar').value), precio_final: auto ? 0 : num(document.getElementById('c_pf').value), materiales };
  const { error } = await sb.from('combos').upsert(payload);
  if (error) return errBox.innerHTML = `<div class="error-box">${esc(error.message)}</div>`;
  await cargarTodo(); cerrar('mCombo'); go('combos');
}
async function borrarCombo(id) {
  if (!confirm('¿Eliminar este juego? Si alguna inscripción ya lo usó, esa inscripción conserva su información (no se ve afectada).')) return;
  const { error } = await sb.from('combos').delete().eq('id', id);
  if (error) return alert(error.message);
  await cargarTodo(); cerrar('mCombo'); go('combos');
}

/* =====================================================================
   TALLERES → INSCRIPCIONES (agenda) + PARTICIPANTES (quién y qué taller)
   ===================================================================== */
V.talleres = () => {
  const reservasFiltradas = DB.reservas.filter(r => {
    if (filtroInscripciones.desde && r.fecha < filtroInscripciones.desde) return false;
    if (filtroInscripciones.hasta && r.fecha > filtroInscripciones.hasta) return false;
    return true;
  });

  const filas = reservasFiltradas.map(r => {
    const parts = participantesDe(r.id);
    const titular = titularDe(r.id);
    const otros = parts.filter(p => !titular || p.id !== titular.id);
    const total = totalReserva(r.id), pagado = pagadoReserva(r.id), saldo = saldoReserva(r.id);
    const est = estadoPagoReserva(r.id);
    return `<tr>
      <td><b>${r.nombre ? esc(r.nombre) : '<span class="mut">Sin nombre</span>'}</b></td>
      <td>${fmtFecha(r.fecha)}${r.horario ? `<span class="mut">${esc(r.horario)}</span>` : ''}</td>
      <td><b>${titular ? esc(titular.nombre) : '<span class="mut">Sin participantes</span>'}</b>
          ${otros.length ? `<span class="mut">+${otros.length} más: ${otros.map(o => esc(o.nombre)).join(', ')}</span>` : ''}</td>
      <td>${parts.length}/${num(r.cupo)}</td>
      <td>${num(r.duracion)} h</td>
      <td><b>${money(total)}</b></td>
      <td>${money(pagado)}</td>
      <td>${saldo > 0 ? `<b style="color:var(--rojo)">${money(saldo)}</b>` : `<span class="mut">$0.00</span>`}</td>
      <td><span class="chip ${est.clase}">${est.label}</span></td>
      <td><button class="btn mini" onclick="gestionarInscripcion('${r.id}')">👥 Ver / Participantes</button></td>
    </tr>`;
  }).join('');

  const historialAntiguo = DB.sesionesAntiguas.length ? `
  <div class="card" style="margin-top:20px">
    <h3>Historial anterior (formato previo)</h3>
    <p class="tiny mut" style="margin-bottom:10px">Talleres registrados antes de este cambio. Se conservan aquí solo para consulta.</p>
    <div class="tabla-wrap"><table>
      <thead><tr><th>Fecha</th><th>Cliente</th><th>Taller</th><th>Personas</th><th>Total</th><th>Costo</th><th>Utilidad</th></tr></thead>
      <tbody>${DB.sesionesAntiguas.map(s => `<tr>
        <td>${fmtFecha(s.fecha)}</td><td>${esc(s.cliente || '—')}</td><td>${esc(s.tipo_nombre || '')}</td>
        <td>${s.personas}</td><td>${money(s.total_taller)}</td><td>${money(s.costo_mat)}</td>
        <td style="color:var(--verde)">${money(s.utilidad)}</td></tr>`).join('')}</tbody>
    </table></div>
  </div>` : '';

  return `
  <h2 class="titulo">📅 Talleres</h2>
  <p class="sub">Crea el taller (fecha, horario, cupo, duración) y luego inscribe a cada participante con lo que vaya a hacer.</p>
  <div style="margin-bottom:16px"><button class="btn" onclick="nuevaInscripcion()">＋ Nuevo taller</button></div>

  <div class="card">
    <div class="toolbar" style="margin-bottom:14px">
      <div><label style="margin:0 0 4px">Desde</label><input type="date" id="ft_desde" value="${filtroInscripciones.desde}" style="min-width:150px"></div>
      <div><label style="margin:0 0 4px">Hasta</label><input type="date" id="ft_hasta" value="${filtroInscripciones.hasta}" style="min-width:150px"></div>
      <button class="btn sec mini" style="align-self:flex-end" onclick="aplicarFiltroInscripciones()">Filtrar</button>
      <button class="btn sec mini" style="align-self:flex-end" onclick="quitarFiltroInscripciones()">Quitar filtro</button>
    </div>
    <div class="tabla-wrap"><table>
      <thead><tr><th>Nombre del taller</th><th>Fecha</th><th>Titular / participantes</th><th>Cupo</th><th>Duración</th><th>Total</th><th>Pagado</th><th>Saldo</th><th>Estado</th><th>Acción</th></tr></thead>
      <tbody>${filas || `<tr><td colspan="10" style="text-align:center;color:var(--gris);padding:26px">Aún no hay talleres creados${filtroInscripciones.desde || filtroInscripciones.hasta ? ' en ese rango de fechas' : ''}.</td></tr>`}</tbody>
    </table></div>
  </div>
  ${historialAntiguo}`;
};

function aplicarFiltroInscripciones() {
  filtroInscripciones.desde = document.getElementById('ft_desde').value || '';
  filtroInscripciones.hasta = document.getElementById('ft_hasta').value || '';
  go('talleres');
}
function quitarFiltroInscripciones() {
  filtroInscripciones = { desde: '', hasta: '' };
  go('talleres');
}

/* ---- Crear / editar los datos básicos de un taller (fecha/horario/cupo/duración) ---- */
function nuevaInscripcion(id) {
  const r = id ? reserva(id) : { nombre: '', fecha: hoy(), horario: '', cupo: 4, duracion: 2 };
  document.getElementById('boxTipo').innerHTML = `
  <div class="modal-head"><h3>🎨 ${id ? 'Editar taller' : 'Nuevo taller'}</h3>
    <button class="cerrar" onclick="cerrar('mTipo')">✕</button></div>
  <div class="grid g2">
    <div style="grid-column:1 / -1"><label>Nombre del taller</label><input id="i_nom" value="${esc(r.nombre || '')}" placeholder="Ej. Taller sabatino, Cumpleaños de Ana"></div>
    <div><label>Fecha</label><input type="date" id="i_fec" value="${r.fecha}"></div>
    <div><label>Horario</label><input id="i_hor" value="${esc(r.horario || '')}" placeholder="Ej. 16:00"></div>
    <div><label>Cupo (máximo de personas)</label><input type="number" id="i_cupo" value="${num(r.cupo)}" min="1"></div>
    <div><label>Duración estimada (horas)</label><input type="number" id="i_dur" value="${num(r.duracion)}" min="0" step="0.5"></div>
  </div>
  <p class="tiny mut" style="margin-top:10px">Aquí solo defines el espacio. Cada participante elegirá qué taller(es) va a hacer (Cerámica, Tetera, etc., incluso más de uno) al inscribirse, en el siguiente paso.</p>
  <div id="inscripcionError"></div>
  <div class="acciones">
    ${id ? `<button class="btn rojo" onclick="borrarInscripcion('${id}')">Eliminar</button>` : ''}
    <button class="btn sec" onclick="cerrar('mTipo')">Cancelar</button>
    <button class="btn" onclick="guardarInscripcion('${id || ''}')">${id ? 'Guardar cambios' : 'Crear e inscribir participantes'}</button>
  </div>`;
  abrir('mTipo');
}
async function guardarInscripcion(id) {
  const errBox = document.getElementById('inscripcionError'); errBox.innerHTML = '';
  const cupo = num(document.getElementById('i_cupo').value);
  if (cupo <= 0) return errBox.innerHTML = `<div class="error-box">El cupo debe ser mayor a cero.</div>`;
  const payload = {
    ...(id ? { id } : {}),
    nombre: document.getElementById('i_nom').value.trim(),
    fecha: document.getElementById('i_fec').value || hoy(),
    horario: document.getElementById('i_hor').value.trim(),
    cupo, duracion: num(document.getElementById('i_dur').value)
  };
  const { data, error } = await sb.from('reservas').upsert(payload).select().single();
  if (error) return errBox.innerHTML = `<div class="error-box">${esc(error.message)}</div>`;
  await cargarTodo();
  cerrar('mTipo');
  gestionarInscripcion(data.id); // pasa directo a inscribir participantes
}
async function borrarInscripcion(id) {
  const parts = participantesDe(id);
  const msg = parts.length
    ? `Este taller tiene ${parts.length} participante(s) y se perderá su información de pago. ¿Eliminar de todas formas?`
    : '¿Eliminar este taller?';
  if (!confirm(msg)) return;
  for (const p of parts) {
    const consumo = expandirReceta(materialesCombinadosParticipante(p.id), 1);
    for (const [materialId, cantidad] of consumo) {
      const m = mat(materialId);
      if (m) await sb.from('materials').update({ existencia: num(m.existencia) + cantidad }).eq('id', m.id);
    }
  }
  const { error } = await sb.from('reservas').delete().eq('id', id);
  if (error) return alert(error.message);
  await cargarTodo();
  cerrar('mTipo'); cerrar('mSesion');
  go('talleres');
}

/* ---- Gestionar participantes y pagos de un taller ---- */
function gestionarInscripcion(id) {
  const r = reserva(id);
  if (!r) return;
  const parts = participantesDe(id);
  const total = totalReserva(id), pagado = pagadoReserva(id), saldo = saldoReserva(id);
  const anticipoSugerido = total / 2;
  const pagosDeEsta = DB.pagos.filter(p => p.reserva_id === id).sort((a, b) => (a.fecha < b.fecha ? 1 : -1));

  document.getElementById('boxSesion').innerHTML = `
  <div class="modal-head"><h3>🎨 ${r.nombre ? esc(r.nombre) : 'Taller'} — ${fmtFecha(r.fecha)}${r.horario ? ' · ' + esc(r.horario) : ''}</h3>
    <button class="cerrar" onclick="cerrar('mSesion')">✕</button></div>
  <p class="tiny mut">Cupo: ${parts.length}/${num(r.cupo)} · Duración estimada: ${num(r.duracion)} h
    <button class="btn sec mini" style="margin-left:8px" onclick="cerrar('mSesion');nuevaInscripcion('${id}')">✏️ Editar datos</button></p>

  <h3 style="margin:16px 0 10px">Participantes</h3>
  <div class="tabla-wrap"><table>
    <thead><tr><th>Nombre</th><th>Teléfono</th><th>Taller(es)</th><th>Café</th><th>Monto</th><th></th></tr></thead>
    <tbody>${parts.length ? parts.map(p => `<tr>
        <td><b>${esc(p.nombre)}</b>${p.es_titular ? '<span class="mut">Titular</span>' : ''}</td>
        <td>${p.telefono ? esc(p.telefono) : '<span class="mut">—</span>'}</td>
        <td>${nombresTalleresTexto(p.id)}</td>
        <td>${p.incluye_cafe ? '☕ Sí' : 'No'}</td>
        <td><b>${money(p.monto_total)}</b></td>
        <td><button class="btn rojo mini" onclick="quitarParticipante('${p.id}','${id}')">✕</button></td>
      </tr>`).join('') : `<tr><td colspan="6" style="text-align:center;color:var(--gris);padding:16px">Aún no hay participantes.</td></tr>`}
    </tbody>
  </table></div>

  ${parts.length < num(r.cupo) ? `
  <div style="margin-top:14px">
    <h3 style="margin-bottom:10px">＋ Agregar participante</h3>
    <div class="grid g2">
      <div><label>Nombre</label><input id="pp_nom" placeholder="Nombre del participante"></div>
      <div><label>Teléfono (opcional)</label><input id="pp_tel" placeholder="Ej. 722 123 4567"></div>
    </div>
    <label style="margin-top:12px">¿Qué taller(es) va a hacer? (puede elegir más de uno)</label>
    <div id="pp_talleres_list" class="card" style="padding:10px 14px;margin-top:4px">
      ${DB.combos.length ? DB.combos.map(c => `<label style="display:flex;align-items:center;gap:8px;padding:6px 0;font-weight:400">
          <input type="checkbox" class="pp_taller_chk" value="${c.id}" onchange="actualizarTotalNuevoParticipante()" style="width:auto">
          ${esc(c.nombre)} — ${money(comboPrecio(c))}
        </label>`).join('') : '<p class="tiny mut">No hay juegos/combos creados todavía. Ve a 🎁 Juegos/Combos y crea al menos uno.</p>'}
    </div>
    <label style="display:flex;align-items:center;gap:6px;font-weight:400;margin-top:10px">
      <input type="checkbox" id="pp_cafe" onchange="actualizarTotalNuevoParticipante()" style="width:auto"> Incluye café (${money(DB.settings.cafe_precio || CAFE_DEFAULT)})
    </label>
    <div class="totales" id="pp_total_preview" style="margin-top:10px">
      <div class="linea final"><span>Total de este participante</span><b>$0.00</b></div>
    </div>
    <div id="participanteError"></div>
    <div class="acciones"><button class="btn" onclick="guardarParticipante('${id}')">＋ Agregar participante</button></div>
  </div>` : `<div class="nota" style="margin-top:14px">Cupo lleno (${num(r.cupo)}/${num(r.cupo)}). Quita a alguien o edita el cupo para agregar más.</div>`}

  <h3 style="margin:20px 0 10px">💳 Pagos</h3>
  <div class="totales">
    <div class="linea"><span>Total del taller (todos los participantes)</span><b>${money(total)}</b></div>
    <div class="linea"><span>Pagado hasta ahora</span><b style="color:var(--verde)">${money(pagado)}</b></div>
    <div class="linea final"><span>Saldo pendiente</span><b style="color:${saldo > 0 ? 'var(--rojo)' : 'var(--verde)'}">${money(saldo)}</b></div>
  </div>
  ${saldo > 0 ? `
  <div class="grid g2" style="margin-top:12px">
    <div><button class="btn" style="width:100%" onclick="registrarAnticipo('${id}')" ${pagado >= anticipoSugerido - 0.004 ? 'disabled' : ''}>
      💰 Registrar anticipo (50% = ${money(anticipoSugerido)})
    </button></div>
    <div style="display:flex;gap:8px;align-items:end">
      <div style="flex:1"><label>Abono libre</label><input type="number" id="pp_abono" value="${saldo.toFixed(2)}" min="0.01" max="${saldo}" step="0.01"></div>
      <button class="btn sec" onclick="guardarPagoLibre('${id}')">Registrar</button>
    </div>
  </div>
  <div id="pagoError"></div>` : `<div class="nota" style="margin-top:10px">✅ Este taller ya está pagado por completo.</div>`}

  <h3 style="margin:18px 0 10px">Historial de pagos</h3>
  <div class="card" style="padding:12px 16px">
    ${pagosDeEsta.length ? pagosDeEsta.map(p => `<div class="linea"><span>${fmtFecha(p.fecha)}${p.nota ? ' · ' + esc(p.nota) : ''}</span><b>${money(p.monto)}</b></div>`).join('') : '<p class="tiny mut">Aún no hay pagos registrados.</p>'}
  </div>
  <div class="acciones"><button class="btn sec" onclick="cerrar('mSesion')">Cerrar</button></div>`;
  abrir('mSesion');
  actualizarTotalNuevoParticipante();
}

/** Recalcula en vivo el total del participante que se está por agregar (suma de talleres elegidos + café). */
function actualizarTotalNuevoParticipante() {
  const preview = document.getElementById('pp_total_preview');
  if (!preview) return;
  const idsSeleccionados = [...document.querySelectorAll('.pp_taller_chk:checked')].map(chk => chk.value);
  const cafe = document.getElementById('pp_cafe')?.checked || false;
  const totalTalleres = idsSeleccionados.reduce((t, id2) => { const c = combo(id2); return t + (c ? comboPrecio(c) : 0); }, 0);
  const cafeMonto = cafe ? num(DB.settings.cafe_precio || CAFE_DEFAULT) : 0;
  preview.innerHTML = `
    ${idsSeleccionados.length ? `<div class="linea"><span>${idsSeleccionados.length} taller(es) elegido(s)</span><b>${money(totalTalleres)}</b></div>` : ''}
    ${cafe ? `<div class="linea cafe"><span>☕ Café</span><b>${money(cafeMonto)}</b></div>` : ''}
    <div class="linea final"><span>Total de este participante</span><b>${money(totalTalleres + cafeMonto)}</b></div>`;
}

async function guardarParticipante(reservaId) {
  const errBox = document.getElementById('participanteError'); errBox.innerHTML = '';
  const r = reserva(reservaId);
  const nombre = document.getElementById('pp_nom').value.trim();
  const telefono = document.getElementById('pp_tel').value.trim();
  const comboIds = [...document.querySelectorAll('.pp_taller_chk:checked')].map(chk => chk.value);
  const incluyeCafe = document.getElementById('pp_cafe').checked;
  if (!nombre) return errBox.innerHTML = `<div class="error-box">Escribe el nombre del participante.</div>`;
  if (!comboIds.length) return errBox.innerHTML = `<div class="error-box">Selecciona al menos un taller que vaya a hacer (crea uno en 🎁 Juegos/Combos si aún no tienes ninguno).</div>`;
  if (!hayCupo(r)) return errBox.innerHTML = `<div class="error-box">El cupo de este taller ya está lleno.</div>`;

  const talleresElegidos = comboIds.map(cid => combo(cid)).filter(Boolean);
  const cafeMonto = incluyeCafe ? num(DB.settings.cafe_precio || CAFE_DEFAULT) : 0;
  const precioTotal = talleresElegidos.reduce((t, c) => t + comboPrecio(c), 0);
  const costoTotal = talleresElegidos.reduce((t, c) => t + comboCosto(c), 0);
  const montoTotal = precioTotal + cafeMonto;

  // Se combinan los materiales de TODOS los talleres elegidos para verificar/descontar inventario en un solo paso.
  const materialesCombinados = talleresElegidos.flatMap(c => c.materiales || []);
  const consumo = expandirReceta(materialesCombinados, 1);
  for (const [materialId, cantidadReq] of consumo) {
    const m = mat(materialId);
    if (!m || num(m.existencia) < cantidadReq) return errBox.innerHTML = `<div class="error-box">Inventario insuficiente de ${m ? esc(m.nombre) : 'material'} para los talleres elegidos.</div>`;
  }
  for (const [materialId, cantidadReq] of consumo) {
    const m = mat(materialId);
    const { error } = await sb.from('materials').update({ existencia: num(m.existencia) - cantidadReq }).eq('id', m.id);
    if (error) return errBox.innerHTML = `<div class="error-box">${esc(error.message)}</div>`;
  }

  const esTitular = participantesDe(reservaId).length === 0;
  const { data: nuevoParticipante, error } = await sb.from('reserva_participantes').insert({
    reserva_id: reservaId, nombre, telefono, es_titular: esTitular,
    incluye_cafe: incluyeCafe, cafe_monto: cafeMonto, monto_total: montoTotal
  }).select().single();
  if (error) return errBox.innerHTML = `<div class="error-box">${esc(error.message)}</div>`;

  // Un renglón en participante_talleres por cada taller que eligió esta persona.
  const filasTalleres = talleresElegidos.map(c => ({
    participante_id: nuevoParticipante.id, combo_id: c.id, combo_nombre: c.nombre,
    precio_taller: comboPrecio(c), costo_taller: comboCosto(c), materiales_snapshot: c.materiales
  }));
  const { error: errorTalleres } = await sb.from('participante_talleres').insert(filasTalleres);
  if (errorTalleres) return errBox.innerHTML = `<div class="error-box">El participante se guardó, pero hubo un problema al registrar sus talleres: ${esc(errorTalleres.message)}</div>`;

  await cargarTodo();
  gestionarInscripcion(reservaId);
}

async function quitarParticipante(participanteId, reservaId) {
  if (!confirm('¿Quitar a este participante? Se restaurará el material de TODOS los talleres que tenía elegidos.')) return;
  const p = DB.participantes.find(x => x.id === participanteId);
  if (!p) return;
  const consumo = expandirReceta(materialesCombinadosParticipante(participanteId), 1);
  for (const [materialId, cantidad] of consumo) {
    const m = mat(materialId);
    if (m) await sb.from('materials').update({ existencia: num(m.existencia) + cantidad }).eq('id', m.id);
  }
  const { error } = await sb.from('reserva_participantes').delete().eq('id', participanteId);
  if (error) return alert(error.message);
  await cargarTodo();
  gestionarInscripcion(reservaId);
}

async function registrarAnticipo(reservaId) {
  const total = totalReserva(reservaId), pagado = pagadoReserva(reservaId);
  const anticipo = total / 2;
  const falta = anticipo - pagado;
  if (falta <= 0.004) return;
  const { error } = await sb.from('pagos').insert({ reserva_id: reservaId, fecha: hoy(), monto: falta, nota: 'Anticipo (50%)' });
  if (error) return alert(error.message);
  await cargarTodo();
  gestionarInscripcion(reservaId);
}
async function guardarPagoLibre(reservaId) {
  const errBox = document.getElementById('pagoError'); if (errBox) errBox.innerHTML = '';
  const saldo = saldoReserva(reservaId);
  const monto = num(document.getElementById('pp_abono').value);
  if (monto <= 0) return errBox.innerHTML = `<div class="error-box">Captura un monto válido.</div>`;
  if (monto > saldo + 0.01) return errBox.innerHTML = `<div class="error-box">Ese monto es mayor al saldo pendiente (${money(saldo)}).</div>`;
  const { error } = await sb.from('pagos').insert({ reserva_id: reservaId, fecha: hoy(), monto, nota: 'Abono' });
  if (error) return errBox.innerHTML = `<div class="error-box">${esc(error.message)}</div>`;
  await cargarTodo();
  gestionarInscripcion(reservaId);
}

/* =====================================================================
   VENTAS (materiales o juegos vendidos fuera de una inscripción)
   ===================================================================== */
V.ventas = () => {
  const filas = DB.ventas.map(v => `<tr>
      <td>${fmtFecha(v.fecha)}</td><td><b>${esc(v.nombre)}</b><span class="mut">${v.tipo === 'combo' ? 'Juego / combo' : 'Material'}</span></td>
      <td>${v.cantidad}</td><td>${money(v.precio)}</td><td><b>${money(v.total)}</b></td>
      <td>${money(v.costo)}</td><td style="color:var(--verde);font-weight:700">${money(v.total - v.costo)}</td></tr>`).join('');
  return `
  <h2 class="titulo">🛍️ Ventas</h2>
  <p class="sub">Para productos y juegos vendidos fuera de una inscripción. El precio se propone solo, ya con su margen.</p>
  <div style="margin-bottom:16px"><button class="btn" onclick="nuevaVenta()">＋ Nueva venta</button></div>
  <div class="tabla-wrap"><table>
    <thead><tr><th>Fecha</th><th>Producto</th><th>Cantidad</th><th>Precio unitario</th><th>Total</th><th>Costo</th><th>Ganancia</th></tr></thead>
    <tbody>${filas || `<tr><td colspan="7" style="text-align:center;color:var(--gris);padding:26px">Sin ventas registradas.</td></tr>`}</tbody>
  </table></div>`;
};

function itemVenta() {
  const [tipo, id] = parseRef(document.getElementById('v_prod').value);
  if (tipo === 'combo') { const c = combo(id); return { tipo, id, nombre: c.nombre, costo: comboCosto(c), sug: comboPrecio(c), materiales: c.materiales }; }
  const m = mat(id); return { tipo, id, nombre: m.nombre, costo: costoUnit(m), sug: precioUnitSug(m), materiales: [{ material_id: refMat(m.id), cantidad: 1 }] };
}
function nuevaVenta() {
  if (!DB.combos.length && !DB.materiales.length) return alert('Primero registra materiales en Inventario.');
  const opts = DB.combos.map(c => `<option value="combo:${c.id}">🎁 ${esc(c.nombre)}</option>`).join('')
             + DB.materiales.map(m => `<option value="${refMat(m.id)}">${esc(m.nombre)}</option>`).join('');
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
  const consumo = expandirReceta(it.materiales, c);
  for (const [materialId, cantidadReq] of consumo) {
    const m = mat(materialId);
    if (!m || num(m.existencia) < cantidadReq) return errBox.innerHTML = `<div class="error-box">Inventario insuficiente de ${m ? esc(m.nombre) : 'material'}.</div>`;
  }
  for (const [materialId, cantidadReq] of consumo) {
    const m = mat(materialId);
    const { error } = await sb.from('materials').update({ existencia: num(m.existencia) - cantidadReq }).eq('id', m.id);
    if (error) return errBox.innerHTML = `<div class="error-box">${esc(error.message)}</div>`;
  }
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
  const vT = DB.participantes.reduce((t, p) => t + num(p.monto_total), 0);
  const cT = DB.participantes.reduce((t, p) => t + costoTotalParticipante(p.id), 0);
  const cafeTotal = DB.participantes.reduce((t, p) => t + num(p.cafe_monto), 0);
  const vV = DB.ventas.reduce((t, v) => t + num(v.total), 0);
  const cV = DB.ventas.reduce((t, v) => t + num(v.costo), 0);
  const vendido = vT + vV, costo = cT + cV, util = vendido - costo;

  const pendientes = DB.reservas
    .map(r => ({ r, saldo: saldoReserva(r.id) }))
    .filter(x => x.saldo > 0)
    .sort((a, b) => b.saldo - a.saldo);
  const totalPorCobrar = pendientes.reduce((t, x) => t + x.saldo, 0);

  const filasPendientes = pendientes.map(({ r, saldo }) => {
    const titular = titularDe(r.id);
    const est = estadoPagoReserva(r.id);
    return `<tr>
      <td>${fmtFecha(r.fecha)}</td>
      <td><b>${titular ? esc(titular.nombre) : '—'}</b>${titular && titular.telefono ? `<span class="mut">${esc(titular.telefono)}</span>` : ''}</td>
      <td>${money(totalReserva(r.id))}</td>
      <td>${money(pagadoReserva(r.id))}</td>
      <td><b style="color:var(--rojo)">${money(saldo)}</b></td>
      <td><span class="chip ${est.clase}">${est.label}</span></td>
      <td><button class="btn sec mini" onclick="gestionarInscripcion('${r.id}')">💳 Ver / Pago</button></td>
    </tr>`;
  }).join('');

  return `
  <h2 class="titulo">📊 Resultados</h2><p class="sub">Lo importante, sin llenar la pantalla de indicadores.</p>
  <div class="grid g4">
    <div class="kpi"><small>VENDIDO</small><b>${money(vendido)}</b></div>
    <div class="kpi"><small>COSTO DE MATERIALES</small><b>${money(costo)}</b></div>
    <div class="kpi"><small>UTILIDAD</small><b>${money(util)}</b></div>
    <div class="kpi"><small>MARGEN</small><b>${vendido > 0 ? (util / vendido * 100).toFixed(1) : 0}%</b></div>
  </div>
  <div class="card" style="margin-top:18px"><h3>Desglose</h3>
    <div class="linea"><span>Talleres (inscripciones)</span><b>${money(vT)}</b></div>
    <div class="linea"><span>Ventas de productos y juegos</span><b>${money(vV)}</b></div>
    <div class="linea cafe"><span>☕ Café para el negocio</span><b>${money(cafeTotal)}</b></div>
    <div class="linea final"><span>Total ingresado</span><b>${money(vendido)}</b></div>
  </div>
  <div class="card" style="margin-top:18px">
    <h3>💰 Cuentas por cobrar</h3>
    <div class="totales" style="margin-bottom:14px">
      <div class="linea final"><span>Total que te deben</span><b style="color:${totalPorCobrar > 0 ? 'var(--rojo)' : 'var(--verde)'}">${money(totalPorCobrar)}</b></div>
    </div>
    <div class="tabla-wrap"><table>
      <thead><tr><th>Fecha</th><th>Titular</th><th>Total</th><th>Pagado</th><th>Saldo</th><th>Estado</th><th>Acción</th></tr></thead>
      <tbody>${filasPendientes || `<tr><td colspan="7" style="text-align:center;color:var(--gris);padding:22px">🎉 No debe nadie, todo está pagado.</td></tr>`}</tbody>
    </table></div>
  </div>`;
};

/* =====================================================================
   ADMINISTRACIÓN
   ===================================================================== */
V.admin = () => `
  <h2 class="titulo">⚙️ Administración</h2><p class="sub">Configura una vez y simplifica la operación diaria.</p>
  <div class="grid g2">
    <div class="card"><h3>🎁 Juegos / combos (catálogo de talleres)</h3><p class="sub">Materiales, margen y precio de cada taller que se puede ofrecer.</p>
      <button class="btn" onclick="editarCombo()">＋ Crear juego / taller</button></div>
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
  const data = {
    exportado_en: new Date().toISOString(),
    materiales: DB.materiales, combos: DB.combos,
    reservas: DB.reservas, participantes: DB.participantes, participanteTalleres: DB.participanteTalleres, pagos: DB.pagos,
    ventas: DB.ventas, sesionesAntiguas: DB.sesionesAntiguas, settings: DB.settings
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'respaldo_talleres_' + hoy() + '.json';
  a.click();
}
