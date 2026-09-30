const { Pool } = require('pg')

const DATABASE_URL = String(process.env.DATABASE_URL || '').trim()
const estado = { activo: !!DATABASE_URL, ok: null, error: '', ultimoSync: null }

let pool = null
if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    max: 2,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
    ssl: DATABASE_URL.includes('sslmode=disable') ? false : { rejectUnauthorized: false }
  })
  pool.on('error', function (e) {
    estado.ok = false
    estado.error = e.message
  })
}

function asegurar() {
  return pool.query(
    'CREATE TABLE IF NOT EXISTS reservas (' +
    'numero TEXT PRIMARY KEY,' +
    'nombre TEXT NOT NULL DEFAULT \'\',' +
    'tel TEXT NOT NULL DEFAULT \'\',' +
    'estado TEXT NOT NULL DEFAULT \'libre\',' +
    'foto TEXT NOT NULL DEFAULT \'\',' +
    'apto TEXT NOT NULL DEFAULT \'\',' +
    'codigo TEXT NOT NULL DEFAULT \'\',' +
    'fecha TEXT NOT NULL DEFAULT \'\',' +
    'actualizado TEXT NOT NULL DEFAULT \'\')'
  )
}

function cargar() {
  return pool.query('SELECT * FROM reservas').then(function (r) {
    const numeros = {}
    r.rows.forEach(function (f) {
      numeros[f.numero] = {
        n: f.numero,
        nombre: f.nombre,
        tel: f.tel,
        estado: f.estado,
        foto: f.foto,
        apto: f.apto,
        codigo: f.codigo,
        fecha: f.fecha
      }
    })
    estado.ok = true
    estado.error = ''
    estado.ultimoSync = Date.now()
    return { numeros: numeros }
  })
}

function guardar(reg) {
  return pool.query(
    'INSERT INTO reservas (numero, nombre, tel, estado, foto, apto, codigo, fecha, actualizado)' +
    ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)' +
    ' ON CONFLICT (numero) DO UPDATE SET nombre=EXCLUDED.nombre, tel=EXCLUDED.tel,' +
    ' estado=EXCLUDED.estado, foto=EXCLUDED.foto, apto=EXCLUDED.apto, codigo=EXCLUDED.codigo,' +
    ' fecha=EXCLUDED.fecha, actualizado=EXCLUDED.actualizado',
    [reg.n, reg.nombre || '', reg.tel || '', reg.estado || 'libre', reg.foto || '',
     reg.apto || '', reg.codigo || '', reg.fecha || '', new Date().toISOString()]
  ).then(function () {
    estado.ok = true
    estado.error = ''
    estado.ultimoSync = Date.now()
    return true
  }).catch(function (e) {
    estado.ok = false
    estado.error = e.message
    console.log('BD fallo al guardar ' + reg.n + ': ' + e.message)
    return false
  })
}

function borrar(numero) {
  return pool.query('DELETE FROM reservas WHERE numero=$1', [numero]).then(function () {
    estado.ok = true
    estado.ultimoSync = Date.now()
    return true
  }).catch(function (e) {
    estado.ok = false
    estado.error = e.message
    return false
  })
}

function probar() {
  if (!pool) return Promise.resolve(false)
  return pool.query('SELECT 1').then(function () {
    estado.ok = true
    estado.error = ''
    return true
  }).catch(function (e) {
    estado.ok = false
    estado.error = e.message
    return false
  })
}

module.exports = { activo: estado.activo, estado: estado, asegurar: asegurar, cargar: cargar, guardar: guardar, borrar: borrar, probar: probar }
