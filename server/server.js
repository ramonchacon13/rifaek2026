const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const bd = require('./bd')
const rutasAfiche = require('./afiche-rutas')

const PORT = parseInt(process.env.PORT, 10) || 3260
const DIR = __dirname
const PUBLIC = path.join(DIR, '..', 'public')
const DATA = process.env.DATA_FILE || path.join(DIR, 'datos.json')
const ADMIN_PASS = String(process.env.ADMIN_PASS || '1234').trim()
const TOTAL = 100
const SYNC_URL = String(process.env.SYNC_URL || '').trim()
const SYNC_TOKEN = String(process.env.SYNC_TOKEN || '').trim()
const BACKUP_URL = String(process.env.BACKUP_URL || '').trim()
const GH_TOKEN = String(process.env.GITHUB_TOKEN || '').trim()
const GH_REPO = String(process.env.GITHUB_REPO || 'ramonchacon13/rifaek2026').trim()
const GH_PATH = 'apartados/respaldo.json'
const SYNC_KEY = 'apartados'
const SYNC_PULL_MS = Number(process.env.SYNC_PULL_MS || 300e3)
const ES_RENDER = !!process.env.RENDER
const SNAP_DIR = path.join(__dirname, 'snapshots')
const MAX_SNAPS = 30

const salud = { remoto: !!(GH_TOKEN || BACKUP_URL || SYNC_URL || bd.activo), github: !!BACKUP_URL || !!GH_TOKEN, githubOk: null, ultimoSync: null, ok: null, error: '', pendiente: false, bd: bd.estado }

function cargar() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA, 'utf8'))
    if (d && d.numeros) return d
  } catch (e) {}
  return { numeros: {} }
}

let db = cargar()

function headersSync() {
  const h = { 'Content-Type': 'application/json' }
  if (SYNC_TOKEN) h['Authorization'] = 'Bearer ' + SYNC_TOKEN
  return h
}

function urlGh() { return 'https://api.github.com/repos/' + GH_REPO + '/contents/' + GH_PATH }

function headersGh() {
  return {
    'Authorization': 'Bearer ' + GH_TOKEN,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'apartados',
    'Content-Type': 'application/json'
  }
}

function empujaGithub() {
  if (!GH_TOKEN) return Promise.resolve(false)
  const contenido = Buffer.from(JSON.stringify(db, null, 2), 'utf8').toString('base64')
  const mensaje = 'Respaldo automatico: ' + Object.keys(db.numeros).length + ' registros'
  return fetch(urlGh(), { headers: headersGh() })
    .then(function (r) { return r.json() })
    .then(function (meta) {
      const cuerpo = { message: mensaje, content: contenido }
      if (meta && meta.sha) cuerpo.sha = meta.sha
      return fetch(urlGh(), { method: 'PUT', headers: headersGh(), body: JSON.stringify(cuerpo) })
    })
    .then(function (r) {
      if (r.ok) {
        salud.githubOk = true
        salud.error = ''
        salud.ultimoSync = Date.now()
        return true
      }
      salud.githubOk = false
      salud.error = 'GitHub respondio ' + r.status
      return false
    })
    .catch(function (e) { salud.githubOk = false; salud.error = 'GitHub fallo: ' + e.message; return false })
}

function restauraGit() {
  if (!BACKUP_URL) return Promise.resolve(false)
  if (Object.keys(db.numeros).length) return Promise.resolve(false)
  return fetch(BACKUP_URL)
    .then(function (r) { return r.json() })
    .then(function (d) {
      if (d && d.numeros && Object.keys(d.numeros).length) {
        db = d
        fs.writeFileSync(DATA, JSON.stringify(db, null, 2), 'utf8')
        snapshot()
        salud.ok = true
        salud.ultimoSync = Date.now()
        console.log('datos restaurados desde BACKUP_URL: ' + Object.keys(d.numeros).length + ' registros')
        return true
      }
      return false
    })
    .catch(function (e) { console.log('BACKUP_URL fallo: ' + e.message); return false })
}

function cargaRemota() {
  if (!SYNC_URL) return Promise.resolve(db)
  const url = SYNC_TOKEN ? SYNC_URL : SYNC_URL + '/get/' + SYNC_KEY
  return fetch(url, {
    method: 'POST',
    headers: headersSync(),
    body: JSON.stringify(['GET', SYNC_KEY])
  })
    .then(function (r) { return r.json() })
    .then(function (j) {
      const d = SYNC_TOKEN ? (typeof j.result === 'string' ? JSON.parse(j.result) : j.result) : j
      if (d && d.numeros && Object.keys(d.numeros).length) {
        db = d
        fs.writeFileSync(DATA, JSON.stringify(db, null, 2), 'utf8')
        snapshot()
        console.log('datos restaurados desde SYNC_URL')
      }
      salud.ok = true
      salud.error = ''
      salud.ultimoSync = Date.now()
    })
    .catch(function (e) { salud.ok = false; salud.error = 'no se pudo leer el remoto: ' + e.message })
}

function snapshot() {
  if (ES_RENDER) return
  const hoy = new Date().toISOString().slice(0, 10)
  const fp = path.join(SNAP_DIR, 'apartados-' + hoy + '.json')
  try {
    fs.mkdirSync(SNAP_DIR, { recursive: true })
    fs.writeFileSync(fp, JSON.stringify(db, null, 2), 'utf8')
    const archivos = fs.readdirSync(SNAP_DIR).filter(f => f.startsWith('apartados-')).sort()
    while (archivos.length > MAX_SNAPS) {
      const viejo = archivos.shift()
      try { fs.unlinkSync(path.join(SNAP_DIR, viejo)) } catch (e) {}
    }
  } catch (e) {}
}

function sincroniza() {
  if (!SYNC_URL) return
  if (SYNC_TOKEN) {
    fetch(SYNC_URL, {
      method: 'POST',
      headers: headersSync(),
      body: JSON.stringify(['SET', SYNC_KEY, JSON.stringify(db)])
    })
      .then(function (r) { return r.json() })
      .then(function (j) {
        if (j && j.result === 'OK') { salud.ok = true; salud.error = ''; salud.ultimoSync = Date.now(); salud.pendiente = false }
        else { salud.ok = false; salud.error = 'el remoto no confirmo la escritura' }
      })
      .catch(function (e) { salud.ok = false; salud.error = 'no se pudo escribir: ' + e.message })
  } else {
    fetch(SYNC_URL + '/set/' + SYNC_KEY, {
      method: 'POST',
      headers: headersSync(),
      body: JSON.stringify(JSON.stringify(db))
    }).catch(function () {})
  }
}

function guardar(d, numero, borrado) {
  fs.writeFileSync(DATA, JSON.stringify(d, null, 2), 'utf8')
  snapshot()
  // Sin base de datos no hay almacenamiento durable: devolvemos false para que
  // el cliente NO reciba un "listo" que se perderia al reiniciar el servicio.
  let p = Promise.resolve(false)
  if (bd.activo) {
    if (borrado && numero) p = bd.borrar(numero)
    else if (numero) p = bd.guardar(d.numeros[numero])
  }
  if (GH_TOKEN) empujaGithub()
  if (SYNC_URL) { salud.pendiente = true; sincroniza() }
  return p
}

const SIN_BASE = 'no se pudo guardar en la base de datos, intenta de nuevo en un momento'

function revierte() {
  fs.writeFileSync(DATA, JSON.stringify(db, null, 2), 'utf8')
  snapshot()
}

function pullPeriodico() {
  if (!SYNC_URL || !SYNC_PULL_MS) return
  setInterval(function () {
    if (salud.pendiente) return
    cargaRemota()
  }, SYNC_PULL_MS).unref()
}

const sesiones = {}

function numOk(n) {
  const s = String(n == null ? '' : n).trim()
  if (!/^\d{1,2}$/.test(s)) return null
  const i = parseInt(s, 10)
  if (i < 0 || i >= TOTAL) return null
  return ('0' + i).slice(-2)
}

function soloDigitos(v, max) {
  return String(v == null ? '' : v).replace(/\D+/g, '').slice(0, max)
}

function registro(n) {
  return db.numeros[n] || { n, nombre: '', apto: '', tel: '', foto: '', estado: 'libre', codigo: '', fecha: '' }
}

function publico(r) {
  return { n: r.n, nombre: r.nombre || '', apto: r.apto || '', foto: r.foto || '', estado: r.estado || 'libre' }
}

function codigo() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let s = ''
  for (let i = 0; i < 6; i++) s += abc[crypto.randomInt(abc.length)]
  return s
}

function sendJson(res, obj, code) {
  res.writeHead(code || 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(obj))
}

function leerBody(req) {
  return new Promise((resolve) => {
    let s = ''
    req.on('data', c => { s += c; if (s.length > 3e6) req.destroy() })
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')) } catch (e) { resolve({}) } })
    req.on('error', () => resolve({}))
  })
}

function esAdmin(req) {
  const t = req.headers['x-admin']
  return !!(t && sesiones[t] && Date.now() - sesiones[t] < 12 * 3600e3)
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x')
  const p = u.pathname

  // Modulo de afiche (83 puestos con abonos). Si la peticion es suya, ya quedo
  // respondida aqui y el servidor no sigue al routing de la rifa.
  if (p === '/api/afiche' || p.indexOf('/api/afiche/') === 0) {
    const atendido = await rutasAfiche(req, res, p, esAdmin, sesiones)
    if (atendido) return
  }

  if (p === '/api/estado' && req.method === 'GET') {
    const out = {}
    for (let i = 0; i < TOTAL; i++) {
      const n = ('0' + i).slice(-2)
      out[n] = publico(registro(n))
    }
    return sendJson(res, { ok: true, numeros: out, total: TOTAL })
  }

  if (p === '/api/apartar' && req.method === 'POST') {
    const b = await leerBody(req)
    const n = numOk(b.numero)
    if (n === null) return sendJson(res, { ok: false, error: 'numero invalido' }, 400)
    const actual = registro(n)
    if (actual.estado !== 'libre') return sendJson(res, { ok: false, error: 'ese numero ya no esta libre' }, 409)
    const nombre = String(b.nombre || '').trim().slice(0, 60)
    const tel = soloDigitos(b.tel, 20)
    if (!nombre) return sendJson(res, { ok: false, error: 'escribe tu nombre' }, 400)
    if (!tel) return sendJson(res, { ok: false, error: 'escribe tu numero de telefono (solo digitos)' }, 400)
    const c = codigo()
    db.numeros[n] = { n, nombre, apto: '', tel, foto: '', estado: 'apartado', codigo: c, fecha: new Date().toISOString() }
    const ok = await guardar(db, n)
    if (ok === false) {
      db.numeros[n] = actual
      revierte()
      return sendJson(res, { ok: false, error: SIN_BASE }, 503)
    }
    return sendJson(res, { ok: true, numero: n, codigo: c })
  }

  if (p === '/api/mio' && req.method === 'POST') {
    const b = await leerBody(req)
    const c = String(b.codigo || '').trim().toUpperCase()
    for (const n in db.numeros) {
      if (db.numeros[n].codigo === c) {
        const r = db.numeros[n]
        return sendJson(res, { ok: true, r: { n: r.n, nombre: r.nombre, tel: r.tel || '', estado: r.estado } })
      }
    }
    return sendJson(res, { ok: false, error: 'codigo no encontrado' }, 404)
  }

  if (p === '/api/mio/editar' && req.method === 'POST') {
    const b = await leerBody(req)
    const c = String(b.codigo || '').trim().toUpperCase()
    for (const n in db.numeros) {
      if (db.numeros[n].codigo === c) {
        const r = db.numeros[n]
        r.nombre = String(b.nombre || r.nombre).trim().slice(0, 60)
        r.tel = soloDigitos(b.tel != null ? b.tel : r.tel, 20)
        r.apto = ''
        const ok = await guardar(db, n)
        if (ok === false) return sendJson(res, { ok: false, error: SIN_BASE }, 503)
        return sendJson(res, { ok: true })
      }
    }
    return sendJson(res, { ok: false, error: 'codigo no encontrado' }, 404)
  }

  if (p === '/api/admin/login' && req.method === 'POST') {
    const b = await leerBody(req)
    if (String(b.pass || '') !== ADMIN_PASS) return sendJson(res, { ok: false, error: 'clave incorrecta' }, 401)
    const t = crypto.randomBytes(16).toString('hex')
    sesiones[t] = Date.now()
    return sendJson(res, { ok: true, token: t })
  }

  if (p === '/api/admin/salud' && req.method === 'GET') {
    if (!esAdmin(req)) return sendJson(res, { ok: false, error: 'sin sesion' }, 401)
    let snaps = 0
    try { snaps = fs.readdirSync(SNAP_DIR).filter(f => f.startsWith('apartados-')).length } catch (e) {}
    return sendJson(res, {
      ok: true,
      remoto: salud.remoto,
      github: salud.github,
      githubOk: salud.githubOk,
      ultimaSync: salud.ultimoSync,
      syncOk: salud.ok,
      error: salud.error,
      pendiente: salud.pendiente,
      bd: salud.bd,
      snapshots: ES_RENDER ? 0 : snaps
    })
  }

  if (p === '/api/admin/descargar' && req.method === 'GET') {
    if (!esAdmin(req)) return sendJson(res, { ok: false, error: 'sin sesion' }, 401)
    const txt = JSON.stringify(db, null, 2)
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="apartados-' + new Date().toISOString().slice(0, 10) + '.json"'
    })
    return res.end(txt)
  }

  if (p === '/api/admin/lista' && req.method === 'GET') {
    if (!esAdmin(req)) return sendJson(res, { ok: false, error: 'sin sesion' }, 401)
    const todos = []
    for (let i = 0; i < TOTAL; i++) {
      const n = ('0' + i).slice(-2)
      const r = registro(n)
      if (r.estado !== 'libre' || r.nombre) todos.push(r)
    }
    return sendJson(res, { ok: true, todos })
  }

  if (p === '/api/admin/guardar' && req.method === 'POST') {
    if (!esAdmin(req)) return sendJson(res, { ok: false, error: 'sin sesion' }, 401)
    const b = await leerBody(req)
    const n = numOk(b.numero)
    if (n === null) return sendJson(res, { ok: false, error: 'numero invalido' }, 400)
    const prev = registro(n)
    const est = ['libre', 'apartado', 'confirmado'].indexOf(b.estado) >= 0 ? b.estado : (prev.estado || 'apartado')
    const foto = typeof b.foto === 'string' && b.foto.indexOf('data:image/') === 0 ? b.foto.slice(0, 900e3) : (prev.foto || '')
    db.numeros[n] = {
      n,
      nombre: String(b.nombre != null ? b.nombre : prev.nombre).trim().slice(0, 60),
      apto: String(b.apto != null ? b.apto : prev.apto).trim().slice(0, 40),
      tel: soloDigitos(b.tel != null ? b.tel : prev.tel, 20),
      foto,
      estado: est,
      codigo: prev.codigo || '',
      fecha: prev.fecha || new Date().toISOString()
    }
    if (db.numeros[n].estado === 'libre' && !db.numeros[n].nombre) delete db.numeros[n]
    const ok = await guardar(db, n, true)
    if (ok === false) return sendJson(res, { ok: false, error: SIN_BASE }, 503)
    return sendJson(res, { ok: true })
  }

  if (p === '/api/admin/liberar' && req.method === 'POST') {
    if (!esAdmin(req)) return sendJson(res, { ok: false, error: 'sin sesion' }, 401)
    const b = await leerBody(req)
    const n = numOk(b.numero)
    if (n !== null) { delete db.numeros[n]; const ok = await guardar(db, n, true); if (ok === false) return sendJson(res, { ok: false, error: SIN_BASE }, 503) }
    return sendJson(res, { ok: true })
  }

  if (p === '/api/admin/cambiar' && req.method === 'POST') {
    if (!esAdmin(req)) return sendJson(res, { ok: false, error: 'sin sesion' }, 401)
    const b = await leerBody(req)
    const n = numOk(b.numero)
    if (n === null) return sendJson(res, { ok: false, error: 'numero invalido' }, 400)
    const r = registro(n)
    const est = ['libre', 'apartado', 'confirmado'].indexOf(b.estado) >= 0 ? b.estado : r.estado
    r.estado = est
    if (!r.nombre && est === 'libre') delete db.numeros[n]
    else db.numeros[n] = r
    const ok = await guardar(db, n, !r.nombre && est === 'libre')
    if (ok === false) return sendJson(res, { ok: false, error: SIN_BASE }, 503)
    return sendJson(res, { ok: true })
  }

  let fp = path.join(PUBLIC, p === '/' ? 'index.html' : p)
  if (!fp.startsWith(PUBLIC)) return sendJson(res, { ok: false, error: 'forbidden' }, 403)
  fs.readFile(fp, (err, data) => {
    if (err) return sendJson(res, { ok: false, error: 'no encontrado' }, 404)
    const ext = path.extname(fp).toLowerCase()
    // Sin el tipo correcto el navegador descarga el archivo en vez de
    // mostrarlo, sobre todo en el celular. Lo que no se conoce sigue como
    // octet-stream, que es lo seguro.
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.pdf': 'application/pdf'
    }
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' })
    res.end(data)
  })
})

server.listen(PORT, '0.0.0.0', async () => {
  if (bd.activo) {
    try {
      await bd.asegurar()
      const prueba = await bd.probar()
      console.log(prueba ? 'prueba de escritura: CORRECTA' : 'prueba de escritura: FALLIDA')
      const remoto = await bd.cargar()
      if (Object.keys(remoto.numeros).length) {
        db = remoto
        fs.writeFileSync(DATA, JSON.stringify(db, null, 2), 'utf8')
        console.log('cargados ' + Object.keys(db.numeros).length + ' registros desde la base de datos')
      } else {
        console.log('base de datos vacia, se usan los datos locales')
      }
    } catch (e) {
      salud.bd.conectado = false
      salud.bd.escrituraOk = false
      salud.bd.errorConexion = e.message
      salud.bd.errorEscritura = e.message
      console.log('base de datos no disponible: ' + e.message + ' (se usan los datos locales)')
    }
  } else {
    await restauraGit()
    cargaRemota()
  }
  // Afiche: mismo Neon, tablas propias. Nunca toca la tabla 'reservas'.
  await rutasAfiche.iniciar()
  pullPeriodico()
  console.log('Apartados 00-99 escuchando en 0.0.0.0:' + PORT)
  console.log('Afiche 01-83 en /afiche.html  |  panel en /afiche-admin.html')
  console.log('Admin: /admin.html  clave: ' + (ES_RENDER ? '(definida en el servidor)' : ADMIN_PASS))
  console.log('Base de datos: ' + (bd.activo ? 'configurada, escritura ' + (salud.bd.escrituraOk === true ? 'OK' : 'FALLIDA') : 'NO CONFIGURADA') + ' | snapshots: ' + (ES_RENDER ? 'no (Render)' : 'si'))
})
