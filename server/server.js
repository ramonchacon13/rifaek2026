const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const PORT = parseInt(process.env.PORT, 10) || 3260
const DIR = __dirname
const PUBLIC = path.join(DIR, '..', 'public')
const DATA = process.env.DATA_FILE || path.join(DIR, 'datos.json')
const ADMIN_PASS = String(process.env.ADMIN_PASS || '1234').trim()
const TOTAL = 100
const SYNC_URL = process.env.SYNC_URL || ''
const SYNC_TOKEN = process.env.SYNC_TOKEN || ''
const SYNC_KEY = 'apartados'
const SYNC_PULL_MS = Number(process.env.SYNC_PULL_MS || 300e3)
const BACKUP_URL = process.env.BACKUP_URL || ''
const ES_RENDER = !!process.env.RENDER
const SNAP_DIR = path.join(__dirname, 'snapshots')
const MAX_SNAPS = 30

const salud = { remoto: !!SYNC_URL, ultimoSync: null, ok: null, error: '', pendiente: false }

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

function guardar(d) {
  fs.writeFileSync(DATA, JSON.stringify(d, null, 2), 'utf8')
  snapshot()
  if (SYNC_URL) { salud.pendiente = true; sincroniza() }
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
    guardar(db)
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
        guardar(db)
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
      ultimaSync: salud.ultimoSync,
      syncOk: salud.ok,
      error: salud.error,
      pendiente: salud.pendiente,
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
    guardar(db)
    return sendJson(res, { ok: true })
  }

  if (p === '/api/admin/liberar' && req.method === 'POST') {
    if (!esAdmin(req)) return sendJson(res, { ok: false, error: 'sin sesion' }, 401)
    const b = await leerBody(req)
    const n = numOk(b.numero)
    if (n !== null) { delete db.numeros[n]; guardar(db) }
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
    guardar(db)
    return sendJson(res, { ok: true })
  }

  let fp = path.join(PUBLIC, p === '/' ? 'index.html' : p)
  if (!fp.startsWith(PUBLIC)) return sendJson(res, { ok: false, error: 'forbidden' }, 403)
  fs.readFile(fp, (err, data) => {
    if (err) return sendJson(res, { ok: false, error: 'no encontrado' }, 404)
    const ext = path.extname(fp).toLowerCase()
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' }
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' })
    res.end(data)
  })
})

server.listen(PORT, '0.0.0.0', async () => {
  await restauraGit()
  cargaRemota()
  pullPeriodico()
  console.log('Apartados 00-99 escuchando en 0.0.0.0:' + PORT)
  console.log('Admin: /admin.html  clave: ' + ADMIN_PASS)
  console.log('Respaldo remoto: ' + (SYNC_URL || BACKUP_URL ? 'si' : 'no') + ' | snapshots: ' + (ES_RENDER ? 'no (Render)' : 'si'))
})
