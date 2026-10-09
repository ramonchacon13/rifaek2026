// Rutas del modulo de afiche (83 puestos publicitarios con abonos).
// Montado aparte en server.js. Comparte la MISMA base de datos Neon que la rifa,
// pero usa sus propias tablas: 'puestos' y 'abonos'. La rifa no se toca.
const crypto = require('crypto')
const afiche = require('./afiche')

const TOTAL = afiche.TOTAL
const TOPE = afiche.TOPE
const SIN_BASE = 'no se pudo guardar en la base de datos, intenta de nuevo en un momento'

// --- logos ---
// Se recibe lo que sea: JPG, PNG, PDF o captura. Quien lo baja y lo prepara
// para el diseno es el organizador, asi que el formato no lo decide el servidor.
// Lo unico que se limita es el peso del archivo y el archivo vacio.
const MAX_BYTES = 4 * 1024 * 1024
const VECTOR = { pdf: 'PDF vector', svg: 'SVG vector', eps: 'EPS vector', ai: 'AI vector' }
const RASTER = { png: 'PNG', jpg: 'JPG', jpeg: 'JPG', webp: 'WEBP', gif: 'GIF' }

// Solo en memoria: los abonos viven en la tabla 'abonos' y se suman por SQL.
// El archivo local es una copia de trabajo para seguir funcionando sin base.
const DATA_LOCAL = process.env.AFICHE_DATA || require('path').join(__dirname, 'afiche.json')

function leerLocal() {
  try {
    const d = JSON.parse(require('fs').readFileSync(DATA_LOCAL, 'utf8'))
    if (d && typeof d === 'object') return d
  } catch (e) {}
  return {}
}

let cache = leerLocal()

function persistirLocal() {
  try {
    require('fs').writeFileSync(DATA_LOCAL, JSON.stringify(cache, null, 2), 'utf8')
  } catch (e) {}
}

function puestoOk(v) {
  const i = parseInt(v, 10)
  if (String(i) !== String(v == null ? '' : v).trim() && !/^\d{1,2}$/.test(String(v == null ? '' : v).trim())) return null
  if (isNaN(i) || i < 1 || i > TOTAL) return null
  return i
}

function soloDigitos(v, max) {
  return String(v == null ? '' : v).replace(/\D+/g, '').slice(0, max)
}

function montoOk(v) {
  const m = parseInt(v, 10)
  if (isNaN(m) || m <= 0 || m > 5e7) return null
  return m
}

// El precio de un puesto puede ser 0 (canje o regalo) o cualquier monto mayor.
function precioOk(v) {
  const m = parseInt(v, 10)
  if (isNaN(m) || m < 0 || m > 5e7) return null
  return m
}

function codigo() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let s = ''
  for (let i = 0; i < 6; i++) s += abc[crypto.randomInt(abc.length)]
  return s
}

// Precio de un puesto: el suyo, o el de siempre si todavia no tiene fila.
function precioDe(p) {
  return p && p.precio != null ? p.precio : TOPE
}

function baseVacia() {
  return { puesto: 0, nombre: '', tel: '', estado: 'libre', codigo: '', fecha: '', precio: TOPE, pagado: 0, saldo: TOPE, nAbonos: 0 }
}

// Estado derivado del saldo contra el precio de ESE puesto, no un campo que se
// pueda desincronizar:
//   precio 0 (canje)   -> pagado
//   sin abono          -> libre
//   abono parcial      -> apartado
//   abono completo     -> pagado
function deriva(pagado, nombre, precio) {
  const tope = precio != null ? precio : TOPE
  if (tope <= 0) return 'pagado'
  if (pagado <= 0) return nombre ? 'apartado' : 'libre'
  if (pagado >= tope) return 'pagado'
  return 'apartado'
}

// Lo que ve el publico: sin telefono y sin codigo.
function publico(p) {
  return { puesto: p.puesto, nombre: p.nombre, estado: p.estado, precio: precioDe(p), pagado: p.pagado, saldo: p.saldo }
}

// Totales del afiche. El 'cobrado' es la suma real de abonos; el 'por cobrar'
// es lo que falta para completar todos los puestos que ya tienen_dueno.
function resumen(puestos) {
  let libre = 0, apartado = 0, pagado = 0, cobrado = 0, porCobrar = 0, conDueno = 0, metaTotal = 0
  for (let i = 1; i <= TOTAL; i++) {
    const p = puestos[i] || baseVacia()
    metaTotal += precioDe(p)
    if (p.estado === 'pagado') pagado++
    else if (p.estado === 'apartado') apartado++
    else libre++
    cobrado += p.pagado || 0
    if (p.nombre) { conDueno++; porCobrar += p.saldo || 0 }
  }
  return {
    total: TOTAL,
    libre: libre,
    apartado: apartado,
    pagado: pagado,
    conDueno: conDueno,
    cobrado: cobrado,
    porCobrar: porCobrar,
    topePorPuesto: TOPE,
    metaTotal: metaTotal
  }
}

// Lectura del ancho y alto de una imagen sin depender de librerias externas.
// Solo mira la cabecera del archivo: PNG, GIF y JPEG.
function dimensiones(buf, ext) {
  try {
    // PNG: la firma son 8 bytes, luego 4 de longitud y 4 de tipo 'IHDR',
    // y el ancho y el alto siguen como enteros de 4 bytes.
    if (ext === 'png') {
      if (buf.length < 24) return null
      if (buf.toString('hex', 12, 16) !== '49484452') return null
      const ancho = buf.readUInt32BE(16)
      const alto = buf.readUInt32BE(20)
      if (!ancho || !alto || ancho > 20000 || alto > 20000) return null
      return { ancho: ancho, alto: alto }
    }
    if (ext === 'gif' && buf.length > 10) {
      const ancho = buf.readUInt16LE(6)
      const alto = buf.readUInt16LE(8)
      if (!ancho || !alto) return null
      return { ancho: ancho, alto: alto }
    }
    if ((ext === 'jpg' || ext === 'jpeg') && buf.length > 4) {
      let i = 2
      while (i < buf.length - 9) {
        if (buf[i] !== 0xFF) { i++; continue }
        const m = buf[i + 1]
        // SOF0..SOF15, menos los marcadores que no son de marco
        if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
          const alto = buf.readUInt16BE(i + 5)
          const ancho = buf.readUInt16BE(i + 7)
          if (!ancho || !alto) return null
          return { alto: alto, ancho: ancho }
        }
        i += 2 + buf.readUInt16BE(i + 2)
      }
      return null
    }
  } catch (e) {}
  return null
}

// Identifica que es el archivo y que tan grande esta. No se rechaza nada por
// formato ni por resolucion: quien lo baja y lo prepara para el diseno es el
// organizador, asi que ahi el JPG, la captura o el PDF chiquito no molestan.
// Lo unico que si se corta es el tamano del archivo (4 MB) y el archivo vacio.
function describeLogo(buf, ext) {
  if (VECTOR[ext]) return { tipo: VECTOR[ext], px: 0 }
  if (RASTER[ext]) {
    const d = dimensiones(buf, ext)
    const px = d ? Math.max(d.ancho, d.alto) : 0
    return { tipo: RASTER[ext] + (px ? ' ' + px + ' px' : ''), px: px }
  }
  return { tipo: (ext ? ext.toUpperCase() : '') || 'archivo', px: 0 }
}

function sendJson(res, obj, code) {
  res.writeHead(code || 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(obj))
}

function leerBody(req) {
  return new Promise((resolve) => {
    let s = ''
    req.on('data', c => { s += c; if (s.length > 1e6) req.destroy() })
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')) } catch (e) { resolve({}) } })
    req.on('error', () => resolve({}))
  })
}

// El logo llega como data URL (base64) dentro del JSON, igual que las fotos de
// la rifa. Se recibe cualquier formato; lo unico que se corta es el tamano
// (4 MB) y el archivo vacio. El cuerpo se lee una sola vez y se devuelve entero
// para no perder el numero de puesto.
function leerLogoBinario(req) {
  return new Promise((resolve) => {
    let s = ''
    let roto = false
    req.on('data', c => {
      if (roto) return
      s += c
      // 4 MB en base64 son ~5.6 MB de texto; cortamos un poco por encima
      if (s.length > 6e6) { roto = true; req.destroy(); resolve({ error: 'el archivo es demasiado grande' }) }
    })
    req.on('end', () => {
      if (roto) return
      let b
      try { b = JSON.parse(s || '{}') } catch (e) { return resolve({ error: 'no se pudo leer el archivo' }) }
      const puesto = b.puesto
      const cod = String(b.codigo == null ? '' : b.codigo).trim().toUpperCase()
      const data = String(b.logo || '')
      // El payload puede venir vacio ('data:...;base64,'): eso se rechaza con
      // el mensaje de archivo vacio, no con el de formato no reconocido.
      const m = data.match(/^data:([a-z]+\/[a-z0-9.+-]+);base64,(.*)$/i)
      if (!m) return resolve({ error: 'formato de archivo no reconocido' })
      const mime = m[1].toLowerCase()
      // 'image/svg+xml' -> 'svg'. Cualquier otro tipo se toma tal cual:
      // aqui no se decide si el formato sirve o no.
      let ext = mime.split('/')[1]
      if (ext.indexOf('+') >= 0) ext = ext.split('+')[0]
      let buf
      try { buf = Buffer.from(m[2], 'base64') } catch (e) { return resolve({ error: 'el archivo esta danado' }) }
      if (!buf.length) return resolve({ error: 'el archivo esta vacio' })
      if (buf.length > MAX_BYTES) {
        return resolve({ error: 'el archivo pesa ' + Math.round(buf.length / 1024) + ' KB y el maximo son 4096 KB' })
      }
      resolve({ ext: ext, mime: mime, buf: buf, dataUrl: data, puesto: puesto, codigo: cod })
    })
    req.on('error', () => resolve({ error: 'no se pudo leer el archivo' }))
  })
}

// Guarda el archivo (bueno o malo) y deja el puesto marcado con el veredicto.
function guardaLogoArchivo(n, file, v, est) {
  if (!afiche.activo) return Promise.resolve(false)
  return afiche.guardarLogo(n, {
    logo: file.dataUrl,
    tipo: v.tipo,
    px: v.px || 0,
    estado: est,
    nota: v.aviso || '',
    fecha: new Date().toISOString()
  }).then(function (ok) {
    if (ok) return cargarBase().then(function () { return true })
    return false
  })
}

function dinero(n) {
  return new Intl.NumberFormat('es-CO').format(n)
}

// ---- carga desde la base de datos ------------------------------------------
function cargarBase() {
  if (!afiche.activo) return Promise.resolve(cache)
  return afiche.cargar().then(function (mapa) {
    cache = {}
    for (const k in mapa) cache[k] = mapa[k]
    persistirLocal()
    return cache
  }).catch(function (e) {
    console.log('Afiche: no se pudo leer la base (' + e.message + '), se usan los datos locales')
    return cache
  })
}

function archivoListo() {
  if (!afiche.activo) return Promise.resolve(cache)
  return afiche.asegurar().then(cargarBase)
}

// ---- operaciones con escritura confirmada ---------------------------------
// Cada operacion devuelve un booleano: true solo si la base confirmo.
// El servidor usa ese booleano para no mentirle al cliente.

function opApartar(p, nombre, tel, abonoInicial, precio) {
  const pagadoInicial = abonoInicial || 0
  const tope = precio != null ? precio : TOPE
  const reg = {
    puesto: p,
    nombre: nombre,
    tel: tel,
    estado: deriva(pagadoInicial, nombre, tope),
    codigo: codigo(),
    fecha: new Date().toISOString(),
    precio: tope
  }
  if (!afiche.activo) return Promise.resolve(false)
  return afiche.guardarPuesto(reg).then(function (ok) {
    if (!ok) return false
    if (pagadoInicial <= 0) return true
    return afiche.anotarAbono(p, pagadoInicial, 'abono inicial')
  }).then(function (ok) {
    if (ok) return cargarBase().then(function () { return true })
    // Si el abono inicial fallo, no dejamos el puesto a medio hacer.
    return afiche.borrarPuesto(p).then(function () { return false })
  })
}

function opAbonar(p, monto, nota) {
  if (!afiche.activo) return Promise.resolve(false)
  return afiche.anotarAbono(p, monto, nota).then(function (ok) {
    if (!ok) return false
    return cargarBase().then(function () { return true })
  })
}

function opEditar(p, nombre, tel) {
  if (!afiche.activo) return Promise.resolve(false)
  const actual = cache[p]
  if (!actual) return Promise.resolve(false)
  return afiche.guardarPuesto({
    puesto: p,
    nombre: nombre,
    tel: tel,
    estado: actual.estado,
    codigo: actual.codigo,
    fecha: actual.fecha,
    precio: precioDe(actual)
  }).then(function (ok) {
    if (ok) return cargarBase().then(function () { return true })
    return false
  })
}

// Cambia el precio de un puesto ya apartado (una oferta, una correccion).
function opPrecio(p, precio) {
  if (!afiche.activo) return Promise.resolve(false)
  if (!cache[p]) return Promise.resolve(false)
  return afiche.guardarPrecio(p, precio).then(function (ok) {
    if (ok) return cargarBase().then(function () { return true })
    return false
  })
}

function opLiberar(p) {
  if (!afiche.activo) return Promise.resolve(false)
  // Liberar borra el puesto y todos sus abonos: queda como si nunca se hubiera
  // tocado. El historico de dinero se conserva en el respaldo descargable.
  return afiche.borrarPuesto(p).then(function (ok) {
    if (ok) return cargarBase().then(function () { return true })
    return false
  })
}

// ---- router ----------------------------------------------------------------
// Devuelve true si la peticion era del afiche (y ya fue respondida).
module.exports = function rutasAfiche(req, res, p, esAdmin, sesiones) {
  if (p !== '/api/afiche' && p.indexOf('/api/afiche/') !== 0) return false

  if (p === '/api/afiche/estado' && req.method === 'GET') {
    const out = {}
    for (let i = 1; i <= TOTAL; i++) out[i] = publico(cache[i] || baseVacia())
    return sendJson(res, { ok: true, puestos: out, resumen: resumen(cache) }), true
  }

  if (p === '/api/afiche/apartar' && req.method === 'POST') {
    return leerBody(req).then(function (b) {
      const n = puestoOk(b.puesto)
      if (n === null) return sendJson(res, { ok: false, error: 'numero de puesto invalido' }, 400)
      const actual = cache[n]
      if (actual && actual.estado !== 'libre') {
        return sendJson(res, { ok: false, error: 'ese puesto ya esta apartado' }, 409)
      }
      const nombre = String(b.nombre || '').trim().slice(0, 60)
      const tel = soloDigitos(b.tel, 20)
      if (!nombre) return sendJson(res, { ok: false, error: 'escribe tu nombre' }, 400)
      if (!tel) return sendJson(res, { ok: false, error: 'escribe tu numero de telefono (solo digitos)' }, 400)
      // El primer abono lo deja quien aparta (por eso vuelve a estar en la pagina
      // publica). El precio, en cambio, solo lo fija el organizador: desde la
      // pagina publica siempre es el de siempre (ofertas aparte). Los abonos
      // siguientes solo los registra el panel (/api/afiche/admin/abonar).
      let abono = 0
      if (b.abono != null && String(b.abono).trim() !== '') {
        abono = montoOk(b.abono)
        if (abono === null) return sendJson(res, { ok: false, error: 'el abono no es un monto valido' }, 400)
      }
      // El precio solo lo fija el organizador (ofertas, canjes). Desde la pagina
      // publica siempre es el de siempre.
      let precio = TOPE
      if (esAdmin(req) && b.precio != null && String(b.precio).trim() !== '') {
        precio = precioOk(b.precio)
        if (precio === null) return sendJson(res, { ok: false, error: 'el precio no es un monto valido' }, 400)
      }
      return opApartar(n, nombre, tel, abono, precio).then(function (ok) {
        if (!ok) return sendJson(res, { ok: false, error: SIN_BASE }, 503)
        const r = cache[n] || {}
        return sendJson(res, { ok: true, puesto: n, codigo: r.codigo || '', precio: r.precio != null ? r.precio : TOPE, pagado: r.pagado || 0, saldo: r.saldo != null ? r.saldo : TOPE })
      })
    }).then(function () { return true }), true
  }

  if (p === '/api/afiche/mio' && req.method === 'POST') {
    return leerBody(req).then(function (b) {
      const c = String(b.codigo || '').trim().toUpperCase()
      for (const k in cache) {
        if (cache[k].codigo === c) {
          const r = cache[k]
          // El archivo se pide de a uno, solo cuando alguien busca su codigo.
          return afiche.leerLogo(r.puesto).then(function (blob) {
            return sendJson(res, { ok: true, r: {
              puesto: r.puesto, nombre: r.nombre, tel: r.tel || '', estado: r.estado,
              precio: r.precio != null ? r.precio : TOPE,
              pagado: r.pagado, saldo: r.saldo, nAbonos: r.nAbonos,
              // El dueno y la vendedora ven su propio logo con el codigo. No lleva
              // telefono ni codigo de otros: solo lo de su puesto.
              logo: blob, logoTipo: r.logoTipo || '',
              logoEstado: r.logoEstado || 'sin-logo', logoNota: r.logoNota || ''
            } })
          }).catch(function () {
            // Si el archivo no se pudo leer, el resto del puesto sigue sirviendo.
            return sendJson(res, { ok: true, r: {
              puesto: r.puesto, nombre: r.nombre, tel: r.tel || '', estado: r.estado,
              precio: r.precio != null ? r.precio : TOPE,
              pagado: r.pagado, saldo: r.saldo, nAbonos: r.nAbonos,
              logo: '', logoTipo: r.logoTipo || '',
              logoEstado: r.logoEstado || 'sin-logo', logoNota: r.logoNota || ''
            } })
          })
        }
      }
      return sendJson(res, { ok: false, error: 'codigo no encontrado' }, 404)
    }).then(function () { return true }), true
  }

  if (p === '/api/afiche/mio/abonar' && req.method === 'POST') {
    // Cerrado a proposito: los abonos los registra el organizador desde el panel
    // (/api/afiche/admin/abonar). Antes el cliente podia anotarse un abono con su
    // solo codigo y el sistema lo daba por bueno; eso ya no ocurre.
    return leerBody(req).then(function () {
      return sendJson(res, { ok: false, error: 'los abonos los registra el organizador desde el panel' }, 403)
    }).then(function () { return true }), true
  }

  // El dueño o la vendedora suben el logo con el codigo. No lleva la clave de
  // admin: alcanza con el codigo del puesto. (El dinero, en cambio, solo lo
  // registra el organizador desde el panel.)
  if (p === '/api/afiche/mio/logo' && req.method === 'POST') {
    return leerLogoBinario(req).then(function (file) {
      if (file.error) return sendJson(res, { ok: false, error: file.error }, 400)
      const c = file.codigo
      if (!c) return sendJson(res, { ok: false, error: 'falta el codigo' }, 400)
      let n = null
      for (const k in cache) if (cache[k].codigo === c) n = parseInt(k, 10)
      if (n === null) return sendJson(res, { ok: false, error: 'codigo no encontrado' }, 404)
      const r = cache[n] || {}
      // El logo aprobado es el que va a imprimirse: desde afuera no se pisa.
      // Si hay que cambiarlo, se hace desde el panel del administrador.
      if (r.logoEstado === 'aprobado') {
        return sendJson(res, { ok: false, error: 'Tu logo ya fue aprobado y no se puede reemplazar. Si necesitas cambiarlo, habla con el organizador.' }, 409)
      }
      const d = describeLogo(file.buf, file.ext)
      return guardaLogoArchivo(n, file, d, 'recibido').then(function (ok) {
        if (!ok) return sendJson(res, { ok: false, error: SIN_BASE }, 503)
        return sendJson(res, { ok: true, puesto: n, tipo: d.tipo, px: d.px })
      })
    }).then(function () { return true }), true
  }

  if (p === '/api/afiche/admin/lista' && req.method === 'GET') {
    if (!esAdmin(req)) return sendJson(res, { ok: false, error: 'sin sesion' }, 401), true
    const todos = []
    for (let i = 1; i <= TOTAL; i++) {
      const r = cache[i]
      if (r && (r.nombre || r.pagado > 0)) todos.push(r)
    }
    return sendJson(res, { ok: true, todos: todos, resumen: resumen(cache) }), true
  }

  if (p === '/api/afiche/admin/abonos' && req.method === 'GET') {
    if (!esAdmin(req)) return sendJson(res, { ok: false, error: 'sin sesion' }, 401), true
    if (!afiche.activo) return sendJson(res, { ok: true, abonos: [] }), true
    return afiche.leerAbonos().then(function (h) {
      return sendJson(res, { ok: true, abonos: h })
    }).catch(function () {
      return sendJson(res, { ok: false, error: 'no se pudo leer el historial' }, 500)
    }).then(function () { return true }), true
  }

  if (p === '/api/afiche/admin/abonar' && req.method === 'POST') {
    if (!esAdmin(req)) return sendJson(res, { ok: false, error: 'sin sesion' }, 401), true
    return leerBody(req).then(function (b) {
      const n = puestoOk(b.puesto)
      if (n === null) return sendJson(res, { ok: false, error: 'numero de puesto invalido' }, 400)
      const monto = montoOk(b.monto)
      if (monto === null) return sendJson(res, { ok: false, error: 'el abono no es un monto valido' }, 400)
      const nota = String(b.nota || '').trim().slice(0, 120)
      const previo = cache[n]
      // Un abono sin puesto asignado no tiene a quien sumarselo: lo creamos como
      // apartado y sin cliente, para que el dinero nunca quede huerfano.
      const preparar = previo ? Promise.resolve(true)
        : afiche.activo
          ? afiche.guardarPuesto({ puesto: n, nombre: '(sin cliente)', tel: '', estado: 'apartado',
              codigo: '', fecha: new Date().toISOString() })
          : Promise.resolve(false)
      return preparar.then(function (listo) {
        if (!listo) return sendJson(res, { ok: false, error: SIN_BASE }, 503)
        return opAbonar(n, monto, nota || 'abono')
      }).then(function (ok) {
        if (!ok) return sendJson(res, { ok: false, error: SIN_BASE }, 503)
        const r = cache[n] || {}
        return sendJson(res, { ok: true, puesto: n, pagado: r.pagado, saldo: r.saldo, estado: r.estado })
      })
    }).then(function () { return true }), true
  }

  if (p === '/api/afiche/admin/editar' && req.method === 'POST') {
    if (!esAdmin(req)) return sendJson(res, { ok: false, error: 'sin sesion' }, 401), true
    return leerBody(req).then(function (b) {
      const n = puestoOk(b.puesto)
      if (n === null) return sendJson(res, { ok: false, error: 'numero de puesto invalido' }, 400)
      const prev = cache[n]
      if (!prev) return sendJson(res, { ok: false, error: 'ese puesto no esta en uso' }, 404)
      const nombre = String(b.nombre != null ? b.nombre : prev.nombre).trim().slice(0, 60)
      const tel = soloDigitos(b.tel != null ? b.tel : prev.tel, 20)
      return opEditar(n, nombre, tel).then(function (ok) {
        if (!ok) return sendJson(res, { ok: false, error: SIN_BASE }, 503)
        return sendJson(res, { ok: true })
      })
    }).then(function () { return true }), true
  }

  // Precio de un puesto ya apartado (oferta, canje, correccion). Solo admin.
  if (p === '/api/afiche/admin/precio' && req.method === 'POST') {
    if (!esAdmin(req)) return sendJson(res, { ok: false, error: 'sin sesion' }, 401), true
    return leerBody(req).then(function (b) {
      const n = puestoOk(b.puesto)
      if (n === null) return sendJson(res, { ok: false, error: 'numero de puesto invalido' }, 400)
      if (!cache[n]) return sendJson(res, { ok: false, error: 'ese puesto no esta en uso' }, 404)
      const precio = precioOk(b.precio)
      if (precio === null) return sendJson(res, { ok: false, error: 'el precio no es un monto valido' }, 400)
      return opPrecio(n, precio).then(function (ok) {
        if (!ok) return sendJson(res, { ok: false, error: SIN_BASE }, 503)
        const r = cache[n] || {}
        return sendJson(res, { ok: true, puesto: n, precio: r.precio, saldo: r.saldo, estado: r.estado })
      })
    }).then(function () { return true }), true
  }

  if (p === '/api/afiche/admin/liberar' && req.method === 'POST') {
    if (!esAdmin(req)) return sendJson(res, { ok: false, error: 'sin sesion' }, 401), true
    return leerBody(req).then(function (b) {
      const n = puestoOk(b.puesto)
      if (n === null) return sendJson(res, { ok: false, error: 'numero de puesto invalido' }, 400)
      return opLiberar(n).then(function (ok) {
        if (!ok) return sendJson(res, { ok: false, error: SIN_BASE }, 503)
        return sendJson(res, { ok: true })
      })
    }).then(function () { return true }), true
  }

  if (p === '/api/afiche/admin/descargar' && req.method === 'GET') {
    if (!esAdmin(req)) return sendJson(res, { ok: false, error: 'sin sesion' }, 401), true
    const puestos = []
    for (let i = 1; i <= TOTAL; i++) {
      const r = cache[i]
      // Se copia el objeto: meter el logo aqui a mano dejaria el archivo en la
      // caché, que es justamente lo que no se debe cargar.
      if (r && (r.nombre || r.pagado > 0)) puestos.push(JSON.parse(JSON.stringify(r)))
    }
    // Los archivos no viven en la caché, se piden de a uno. Sin este paso el
    // respaldo saldria sin ningun logo.
    return (afiche.activo ? afiche.leerLogosTodos() : Promise.resolve([])).then(function (filas) {
      const mapa = {}
      filas.forEach(function (f) { mapa[f.puesto] = f.logo })
      puestos.forEach(function (p) {
        p.logo = mapa[p.puesto] || ''
        p.tieneLogo = !!p.logo
      })
      const txt = JSON.stringify({
        generado: new Date().toISOString(),
        resumen: resumen(cache),
        puestos: puestos
      }, null, 2)
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="afiche-' + new Date().toISOString().slice(0, 10) + '.json"'
      })
      res.end(txt)
      return true
    }).then(function () { return true }), true
  }

  // Ver un logo. Solo con sesion de admin: es un archivo de trabajo, no va
  // publicado. Se sirve con no-store porque el mismo puesto puede cambiar.
  // El archivo se trae de la base de a uno, nunca en bloque.
  if (p.indexOf('/api/afiche/admin/logo/') === 0 && req.method === 'GET') {
    if (!esAdmin(req)) return sendJson(res, { ok: false, error: 'sin sesion' }, 401), true
    const n = puestoOk(p.split('/').pop())
    if (n === null) return sendJson(res, { ok: false, error: 'numero de puesto invalido' }, 400), true
    const r = cache[n]
    if (!r || !r.tieneLogo) return sendJson(res, { ok: false, error: 'este puesto no tiene logo' }, 404), true
    return afiche.leerLogo(n).then(function (blob) {
      // En la base esta la data URL completa; hay que sacar solo los bytes, o el
      // navegador recibiria texto en vez de una imagen.
      const m = String(blob).match(/^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/i)
      if (!m) return sendJson(res, { ok: false, error: 'el archivo guardado esta danado' }, 500)
      const buf = Buffer.from(m[2], 'base64')
      res.writeHead(200, {
        'Content-Type': m[1].toLowerCase(),
        'Content-Length': buf.length,
        'Cache-Control': 'no-store'
      })
      return res.end(buf)
    }).catch(function (e) {
      return sendJson(res, { ok: false, error: SIN_BASE }, 503)
    }).then(function () { return true }), true
  }

  if (p === '/api/afiche/admin/logo/subir' && req.method === 'POST') {
    if (!esAdmin(req)) return sendJson(res, { ok: false, error: 'sin sesion' }, 401), true
    return leerLogoBinario(req).then(function (file) {
      if (file.error) return sendJson(res, { ok: false, error: file.error }, 400)
      const n = puestoOk(file.puesto)
      if (n === null) return sendJson(res, { ok: false, error: 'numero de puesto invalido' }, 400)
      if (!cache[n]) return sendJson(res, { ok: false, error: 'ese puesto no esta en uso' }, 404)
      const d = describeLogo(file.buf, file.ext)
      return guardaLogoArchivo(n, file, d, 'recibido').then(function (ok) {
        if (!ok) return sendJson(res, { ok: false, error: SIN_BASE }, 503)
        return sendJson(res, { ok: true, puesto: n, tipo: d.tipo, px: d.px })
      })
    }).catch(function (e) {
      return sendJson(res, { ok: false, error: 'no se pudo guardar el logo: ' + e.message }, 500)
    }).then(function () { return true }), true
  }

  if (p === '/api/afiche/admin/logo/estado' && req.method === 'POST') {
    if (!esAdmin(req)) return sendJson(res, { ok: false, error: 'sin sesion' }, 401), true
    return leerBody(req).then(function (b) {
      const n = puestoOk(b.puesto)
      if (n === null) return sendJson(res, { ok: false, error: 'numero de puesto invalido' }, 400)
      const est = ['recibido', 'aprobado', 'rechazado', 'sin-logo'].indexOf(b.estado) >= 0 ? b.estado : 'recibido'
      if (est === 'sin-logo') {
        if (!afiche.activo) return sendJson(res, { ok: false, error: SIN_BASE }, 503)
        return afiche.guardarLogo(n, { logo: '', tipo: '', px: 0, estado: 'sin-logo', nota: '' }).then(function (ok) {
          if (!ok) return sendJson(res, { ok: false, error: SIN_BASE }, 503)
          return cargarBase().then(function () { return sendJson(res, { ok: true }) })
        })
      }
      const prev = cache[n]
      if (!prev || !prev.tieneLogo) return sendJson(res, { ok: false, error: 'este puesto no tiene logo todavia' }, 404)
      const nota = String(b.nota || '').trim().slice(0, 200)
      if (!afiche.activo) return sendJson(res, { ok: false, error: SIN_BASE }, 503)
      return afiche.estadoLogo(n, est, nota).then(function (ok) {
        if (!ok) return sendJson(res, { ok: false, error: SIN_BASE }, 503)
        return cargarBase().then(function () { return sendJson(res, { ok: true, estado: est }) })
      })
    }).then(function () { return true }), true
  }

  // Hoja de revision: todos los puestos con su logo, para revisarlos de una vez.
  if (p === '/api/afiche/admin/logos' && req.method === 'GET') {
    if (!esAdmin(req)) return sendJson(res, { ok: false, error: 'sin sesion' }, 401), true
    const lista = []
    for (let i = 1; i <= TOTAL; i++) {
      const r = cache[i]
      if (!r || (!r.tieneLogo && r.estado === 'libre')) continue
      lista.push({
        puesto: i,
        nombre: r.nombre,
        estado: r.estado,
        pagado: r.pagado,
        saldo: r.saldo,
        tieneLogo: r.tieneLogo,
        logoTipo: r.logoTipo,
        logoEstado: r.logoEstado,
        logoNota: r.logoNota
      })
    }
    const falta = []
    for (let i = 1; i <= TOTAL; i++) {
      const r = cache[i]
      if (r && r.estado !== 'libre' && r.logoEstado !== 'aprobado') falta.push(i)
    }
    return sendJson(res, { ok: true, lista: lista, faltan: falta }), true
  }

  if (p === '/api/afiche/admin/salud' && req.method === 'GET') {
    if (!esAdmin(req)) return sendJson(res, { ok: false, error: 'sin sesion' }, 401), true
    return sendJson(res, { ok: true, bd: afiche.estado, resumen: resumen(cache) }), true
  }

  return sendJson(res, { ok: false, error: 'no encontrado' }, 404), true
}

module.exports.dinero = dinero
module.exports.iniciar = archivoListo
module.exports.resumen = resumen