// Rutas del modulo de afiche (83 puestos publicitarios con abonos).
// Montado aparte en server.js. Comparte la MISMA base de datos Neon que la rifa,
// pero usa sus propias tablas: 'puestos' y 'abonos'. La rifa no se toca.
const crypto = require('crypto')
const afiche = require('./afiche')

const TOTAL = afiche.TOTAL
const TOPE = afiche.TOPE
const SIN_BASE = 'no se pudo guardar en la base de datos, intenta de nuevo en un momento'

// --- logos ---
// Los puestos son todos del mismo tamano, asi que hay UNA sola medida de
// referencia. Se mide en cm del lado mas largo del logo ya placedo en el afiche.
const MEDIDA_CM = 15
const DPI = 300
// px minimos = cm / 2.54 * DPI. A 15 cm y 300 dpi son 1772 px.
const PX_MIN = Math.round((MEDIDA_CM / 2.54) * DPI)
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

function codigo() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let s = ''
  for (let i = 0; i < 6; i++) s += abc[crypto.randomInt(abc.length)]
  return s
}

function baseVacia() {
  return { puesto: 0, nombre: '', tel: '', estado: 'libre', codigo: '', fecha: '', pagado: 0, saldo: TOPE, nAbonos: 0 }
}

// Estado derivado del saldo, no un campo que se pueda desincronizar:
//   sin abono          -> libre
//   abono parcial      -> apartado
//   abono completo     -> pagado
function deriva(pagado, nombre) {
  if (pagado <= 0) return nombre ? 'apartado' : 'libre'
  if (pagado >= TOPE) return 'pagado'
  return 'apartado'
}

// Lo que ve el publico: sin telefono y sin codigo.
function publico(p) {
  return { puesto: p.puesto, nombre: p.nombre, estado: p.estado, pagado: p.pagado, saldo: p.saldo }
}

// Totales del afiche. El 'cobrado' es la suma real de abonos; el 'por cobrar'
// es lo que falta para completar todos los puestos que ya tienen_dueno.
function resumen(puestos) {
  let libre = 0, apartado = 0, pagado = 0, cobrado = 0, porCobrar = 0, conDueno = 0
  for (let i = 1; i <= TOTAL; i++) {
    const p = puestos[i] || baseVacia()
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
    metaTotal: TOTAL * TOPE
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

// Que tan vectorial es un PDF: cuenta operators de dibujo y texto.
// Un PDF de captura de pantalla es una sola imagen; uno de Illustrator es
// decenas de operadores de trazo y texto.
function pesoVectorPdf(buf) {
  const s = buf.toString('latin1')
  let ops = 0
  for (const p of [' c\n', ' l\n', ' m\n', ' re\n', ' Tj\n', ' TJ\n']) {
    let i = 0
    while ((i = s.indexOf(p, i)) !== -1) { ops++; i++ }
  }
  return ops
}

// Decide si el archivo sirve para imprimir. Devuelve el veredicto y el motivo,
// en palabras que se puedan entender sin saber de diseno.
function validaLogo(buf, ext) {
  if (VECTOR[ext]) {
    const ops = pesoVectorPdf(buf)
    if (ext === 'pdf' && ops < 20) {
      return {
        sirve: false,
        tipo: VECTOR[ext],
        px: 0,
        aviso: 'Este PDF parece una captura o una imagen, no un dibujo vectorial. Vuelvelo a exportar desde el programa de diseno con la opcion de curvas.'
      }
    }
    return { sirve: true, tipo: VECTOR[ext], px: 0, aviso: '' }
  }
  if (RASTER[ext]) {
    if (ext === 'gif') {
      return { sirve: false, tipo: RASTER[ext], px: 0, aviso: 'El formato GIF no sirve para imprimir, se pixelea. Exporta en PNG.' }
    }
    if (ext === 'jpg' || ext === 'jpeg') {
      return {
        sirve: false,
        tipo: RASTER[ext],
        px: 0,
        aviso: 'El JPG comprime y deja los bordes sucios. Para un logo es mejor PNG o PDF vectorial.'
      }
    }
    const d = dimensiones(buf, ext)
    if (!d) {
      return { sirve: false, tipo: RASTER[ext], px: 0, aviso: 'No se pudo leer la imagen. Revisa que el archivo no este danado.' }
    }
    const px = Math.max(d.ancho, d.alto)
    if (px < PX_MIN) {
      return {
        sirve: false,
        tipo: RASTER[ext],
        px: px,
        aviso: 'La imagen es de ' + px + ' px y necesita al menos ' + PX_MIN + ' px para medir ' + MEDIDA_CM + ' cm sin pixelarse. Vuelve a exportarla mas grande.'
      }
    }
    return { sirve: true, tipo: RASTER[ext] + ' ' + px + ' px', px: px, aviso: '' }
  }
  return { sirve: false, tipo: ext.toUpperCase(), px: 0, aviso: 'Formato no admitido. Sube un PDF vectorial o un PNG.' }
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
// la rifa. Solo se guardan PDF/SVG/PNG y hasta 4 MB. El cuerpo se lee una sola
// vez y se devuelve entero para no perder el numero de puesto.
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
      const data = String(b.logo || '')
      const m = data.match(/^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/i)
      if (!m) return resolve({ error: 'formato de archivo no reconocido' })
      const mime = m[1].toLowerCase()
      const ext = mime.split('/')[1]
      if (!VECTOR[ext] && !RASTER[ext]) return resolve({ error: 'solo se admiten PDF, SVG y PNG' })
      let buf
      try { buf = Buffer.from(m[2], 'base64') } catch (e) { return resolve({ error: 'el archivo esta danado' }) }
      if (!buf.length) return resolve({ error: 'el archivo esta vacio' })
      if (buf.length > MAX_BYTES) {
        return resolve({ error: 'el archivo pesa ' + Math.round(buf.length / 1024) + ' KB y el maximo son 4096 KB' })
      }
      resolve({ ext: ext, mime: mime, buf: buf, dataUrl: data, puesto: puesto })
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

function opApartar(p, nombre, tel, abonoInicial) {
  const pagadoInicial = abonoInicial || 0
  const reg = {
    puesto: p,
    nombre: nombre,
    tel: tel,
    estado: deriva(pagadoInicial, nombre),
    codigo: codigo(),
    fecha: new Date().toISOString()
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
    fecha: actual.fecha
  }).then(function (ok) {
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
      let abono = 0
      if (b.abono != null && String(b.abono).trim() !== '') {
        abono = montoOk(b.abono)
        if (abono === null) return sendJson(res, { ok: false, error: 'el abono no es un monto valido' }, 400)
      }
      return opApartar(n, nombre, tel, abono).then(function (ok) {
        if (!ok) return sendJson(res, { ok: false, error: SIN_BASE }, 503)
        const r = cache[n] || {}
        return sendJson(res, { ok: true, puesto: n, codigo: r.codigo || '', pagado: r.pagado || 0, saldo: r.saldo != null ? r.saldo : TOPE })
      })
    }).then(function () { return true }), true
  }

  if (p === '/api/afiche/mio' && req.method === 'POST') {
    return leerBody(req).then(function (b) {
      const c = String(b.codigo || '').trim().toUpperCase()
      for (const k in cache) {
        if (cache[k].codigo === c) {
          const r = cache[k]
          return sendJson(res, { ok: true, r: { puesto: r.puesto, nombre: r.nombre, tel: r.tel || '', estado: r.estado, pagado: r.pagado, saldo: r.saldo, nAbonos: r.nAbonos } })
        }
      }
      return sendJson(res, { ok: false, error: 'codigo no encontrado' }, 404)
    }).then(function () { return true }), true
  }

  if (p === '/api/afiche/mio/abonar' && req.method === 'POST') {
    return leerBody(req).then(function (b) {
      const c = String(b.codigo || '').trim().toUpperCase()
      let puesto = null
      for (const k in cache) if (cache[k].codigo === c) puesto = parseInt(k, 10)
      if (puesto === null) return sendJson(res, { ok: false, error: 'codigo no encontrado' }, 404)
      const monto = montoOk(b.monto)
      if (monto === null) return sendJson(res, { ok: false, error: 'escribe un monto valido' }, 400)
      return opAbonar(puesto, monto, 'abono del cliente').then(function (ok) {
        if (!ok) return sendJson(res, { ok: false, error: SIN_BASE }, 503)
        const r = cache[puesto] || {}
        return sendJson(res, { ok: true, puesto: puesto, pagado: r.pagado, saldo: r.saldo, estado: r.estado })
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
      if (r && (r.nombre || r.pagado > 0)) puestos.push(r)
    }
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
  }

  // Ver un logo. Solo con sesion de admin: es un archivo de trabajo, no va
  // publicado. Se sirve con no-store porque el mismo puesto puede cambiar.
  if (p.indexOf('/api/afiche/admin/logo/') === 0 && req.method === 'GET') {
    if (!esAdmin(req)) return sendJson(res, { ok: false, error: 'sin sesion' }, 401), true
    const n = puestoOk(p.split('/').pop())
    if (n === null) return sendJson(res, { ok: false, error: 'numero de puesto invalido' }, 400), true
    const r = cache[n]
    if (!r || !r.logo) return sendJson(res, { ok: false, error: 'este puesto no tiene logo' }, 404), true
    // En la base esta la data URL completa; hay que sacar solo los bytes, o el
    // navegador recibiria texto en vez de una imagen.
    const m = String(r.logo).match(/^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/i)
    if (!m) return sendJson(res, { ok: false, error: 'el archivo guardado esta danado' }, 500), true
    const buf = Buffer.from(m[2], 'base64')
    res.writeHead(200, {
      'Content-Type': m[1].toLowerCase(),
      'Content-Length': buf.length,
      'Cache-Control': 'no-store'
    })
    return res.end(buf), true
  }

  if (p === '/api/afiche/admin/logo/subir' && req.method === 'POST') {
    if (!esAdmin(req)) return sendJson(res, { ok: false, error: 'sin sesion' }, 401), true
    return leerLogoBinario(req).then(function (file) {
      if (file.error) return sendJson(res, { ok: false, error: file.error }, 400)
      const n = puestoOk(file.puesto)
      if (n === null) return sendJson(res, { ok: false, error: 'numero de puesto invalido' }, 400)
      if (!cache[n]) return sendJson(res, { ok: false, error: 'ese puesto no esta en uso' }, 404)
      const v = validaLogo(file.buf, file.ext)
      if (!v.sirve) {
        // Se guarda igual para que puedas mirarlo, pero queda como rechazado
        // con el motivo a la vista.
        return guardaLogoArchivo(n, file, v, 'rechazado').then(function (ok) {
          if (!ok) return sendJson(res, { ok: false, error: SIN_BASE }, 503)
          return sendJson(res, { ok: false, error: v.aviso, tipo: v.tipo, px: v.px, guardado: true })
        })
      }
      return guardaLogoArchivo(n, file, v, 'recibido').then(function (ok) {
        if (!ok) return sendJson(res, { ok: false, error: SIN_BASE }, 503)
        return sendJson(res, { ok: true, puesto: n, tipo: v.tipo, px: v.px })
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
      if (!prev || !prev.logo) return sendJson(res, { ok: false, error: 'este puesto no tiene logo todavia' }, 404)
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
      if (!r || (!r.logo && r.estado === 'libre')) continue
      lista.push({
        puesto: i,
        nombre: r.nombre,
        estado: r.estado,
        pagado: r.pagado,
        saldo: r.saldo,
        logoEstado: r.logoEstado,
        logoTipo: r.logoTipo,
        logoNota: r.logoNota
      })
    }
    const falta = []
    for (let i = 1; i <= TOTAL; i++) {
      const r = cache[i]
      if (r && r.estado !== 'libre' && r.logoEstado !== 'aprobado') falta.push(i)
    }
    return sendJson(res, { ok: true, lista: lista, faltan: falta, pxMin: PX_MIN, medidaCm: MEDIDA_CM }), true
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