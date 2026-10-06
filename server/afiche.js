// Modulo de afiche: 83 puestos publicitarios con abonos.
// Vive junto a la rifa pero NO comparte tablas ni estado con ella:
//   rifa   -> tabla 'reservas'  (00-99, codigo de acceso)
//   afiche -> tablas 'puestos' y 'abonos' (1-83, saldo acumulado)
const { Pool } = require('pg')

const DATABASE_URL = String(process.env.DATABASE_URL || '').trim()
const TOTAL_PUESTOS = 83
const TOPE = 55000

const estado = {
  activo: !!DATABASE_URL,
  conectado: null,
  errorConexion: '',
  escrituraOk: null,
  errorEscritura: '',
  ultimoSync: null
}

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
    estado.conectado = false
    estado.errorConexion = e.message
  })
}

function asegurar() {
  return pool.query(
    'CREATE TABLE IF NOT EXISTS puestos (' +
    'puesto INTEGER PRIMARY KEY,' +
    'nombre TEXT NOT NULL DEFAULT \'\',' +
    'tel TEXT NOT NULL DEFAULT \'\',' +
    'estado TEXT NOT NULL DEFAULT \'libre\',' +
    'codigo TEXT NOT NULL DEFAULT \'\',' +
    'fecha TEXT NOT NULL DEFAULT \'\',' +
    'actualizado TEXT NOT NULL DEFAULT \'\')'
  ).then(function () {
    // El logo se agrega con ALTER TABLE y no dentro del CREATE: la tabla 'puestos'
    // ya existe en Neon con los datos, y recrearla seria perderlos.
    return pool.query('ALTER TABLE puestos ADD COLUMN IF NOT EXISTS logo TEXT NOT NULL DEFAULT \'\'')
  }).then(function () {
    return pool.query('ALTER TABLE puestos ADD COLUMN IF NOT EXISTS logo_tipo TEXT NOT NULL DEFAULT \'\'')
  }).then(function () {
    return pool.query('ALTER TABLE puestos ADD COLUMN IF NOT EXISTS logo_px INTEGER NOT NULL DEFAULT 0')
  }).then(function () {
    return pool.query('ALTER TABLE puestos ADD COLUMN IF NOT EXISTS logo_estado TEXT NOT NULL DEFAULT \'sin-logo\'')
  }).then(function () {
    return pool.query('ALTER TABLE puestos ADD COLUMN IF NOT EXISTS logo_nota TEXT NOT NULL DEFAULT \'\'')
  }).then(function () {
    return pool.query('ALTER TABLE puestos ADD COLUMN IF NOT EXISTS logo_fecha TEXT NOT NULL DEFAULT \'\'')
  }).then(function () {
    return pool.query(
      'CREATE TABLE IF NOT EXISTS abonos (' +
      'id SERIAL PRIMARY KEY,' +
      'puesto INTEGER NOT NULL,' +
      'monto INTEGER NOT NULL,' +
      'nota TEXT NOT NULL DEFAULT \'\',' +
      'fecha TEXT NOT NULL DEFAULT \'\')'
    )
  })
}

// Suma de abonos por puesto. El saldo nunca es negativo.
// La columna 'logo' NO se trae aqui a proposito: son hasta 83 archivos de
// varios MB cada uno, y esta consulta corre en cada abono. Leerlos todos
// dejaria el servidor sin respuesta. El archivo se pide de a uno con
// leerLogo() cuando hay que mostrarlo o descargarlo.
function cargar() {
  return pool.query(
    'SELECT p.puesto, p.nombre, p.tel, p.estado, p.codigo, p.fecha,' +
    ' p.logo_tipo, p.logo_px, p.logo_estado, p.logo_nota, p.logo_fecha,' +
    ' COALESCE(SUM(a.monto),0) AS pagado,' +
    ' (SELECT COUNT(*) FROM abonos x WHERE x.puesto=p.puesto) AS n_abonos' +
    ' FROM puestos p LEFT JOIN abonos a ON a.puesto=p.puesto' +
    ' GROUP BY p.puesto'
  ).then(function (r) {
    const puestos = {}
    r.rows.forEach(function (f) {
      const pagado = parseInt(f.pagado, 10) || 0
      // El estado se deriva SIEMPRE de la suma de abonos. Nunca se lee de la
      // columna 'estado': si alguien la edita a mano o queda desfasada, aqui se
      // corrige sola. 'libre' solo cuando no hay nombre y no hay dinero.
      const nombre = f.nombre || ''
      const estado = pagado <= 0 ? (nombre ? 'apartado' : 'libre') : (pagado >= TOPE ? 'pagado' : 'apartado')
      const logoEstado = f.logo_estado || 'sin-logo'
      puestos[f.puesto] = {
        puesto: f.puesto,
        nombre: nombre,
        tel: f.tel,
        estado: estado,
        codigo: f.codigo,
        fecha: f.fecha,
        pagado: pagado,
        saldo: Math.max(0, TOPE - pagado),
        nAbonos: parseInt(f.n_abonos, 10) || 0,
        // El estado del logo si viaja (pesa nada) y dice si hay archivo,
        // para no tener que bajar el archivo para saber si existe.
        tieneLogo: logoEstado !== 'sin-logo',
        logoTipo: f.logo_tipo || '',
        logoPx: parseInt(f.logo_px, 10) || 0,
        logoEstado: logoEstado,
        logoNota: f.logo_nota || '',
        logoFecha: f.logo_fecha || ''
      }
    })
    estado.conectado = true
    estado.errorConexion = ''
    estado.ultimoSync = Date.now()
    return puestos
  })
}

// El archivo de UN puesto. Es la unica forma de leer logos: nunca en bloque.
function leerLogo(puesto) {
  if (!pool) return Promise.reject(new Error('sin base de datos'))
  return pool.query('SELECT logo FROM puestos WHERE puesto=$1', [puesto]).then(function (r) {
    return (r.rows[0] && r.rows[0].logo) || ''
  })
}

// Todos los archivos, solo para el respaldo descargable.
function leerLogosTodos() {
  if (!pool) return Promise.resolve([])
  return pool.query("SELECT puesto, logo FROM puestos WHERE logo <> ''").then(function (r) { return r.rows })
}

function guardarPuesto(p) {
  return pool.query(
    'INSERT INTO puestos (puesto, nombre, tel, estado, codigo, fecha, actualizado)' +
    ' VALUES ($1,$2,$3,$4,$5,$6,$7)' +
    ' ON CONFLICT (puesto) DO UPDATE SET nombre=EXCLUDED.nombre, tel=EXCLUDED.tel,' +
    ' estado=EXCLUDED.estado, codigo=EXCLUDED.codigo, fecha=EXCLUDED.fecha,' +
    ' actualizado=EXCLUDED.actualizado',
    [p.puesto, p.nombre || '', p.tel || '', p.estado || 'libre', p.codigo || '',
     p.fecha || '', new Date().toISOString()]
  ).then(function () {
    estado.escrituraOk = true
    estado.errorEscritura = ''
    estado.conectado = true
    estado.ultimoSync = Date.now()
    return true
  }).catch(function (e) {
    estado.escrituraOk = false
    estado.errorEscritura = e.message
    estado.conectado = false
    console.log('Afiche fallo al guardar puesto ' + p.puesto + ': ' + e.message)
    return false
  })
}

// El logo se actualiza solo en sus propias columnas, sin tocar nombre ni abonos:
// guardar el registro completo podria pisar un abono que entro al mismo tiempo.
function guardarLogo(puesto, logo) {
  return pool.query(
    'UPDATE puestos SET logo=$1, logo_tipo=$2, logo_px=$3, logo_estado=$4,' +
    ' logo_nota=$5, logo_fecha=$6, actualizado=$7 WHERE puesto=$8',
    [logo.logo || '', logo.tipo || '', logo.px || 0, logo.estado || 'sin-logo',
     logo.nota || '', logo.fecha || new Date().toISOString(), new Date().toISOString(), puesto]
  ).then(function () {
    estado.escrituraOk = true
    estado.errorEscritura = ''
    estado.conectado = true
    estado.ultimoSync = Date.now()
    return true
  }).catch(function (e) {
    estado.escrituraOk = false
    estado.errorEscritura = e.message
    estado.conectado = false
    console.log('Afiche fallo al guardar el logo del puesto ' + puesto + ': ' + e.message)
    return false
  })
}

// Aprobar, rechazar o dejar pendiente sin volver a subir el archivo.
function estadoLogo(puesto, est, nota) {
  return pool.query(
    'UPDATE puestos SET logo_estado=$1, logo_nota=$2, actualizado=$3 WHERE puesto=$4',
    [est, nota || '', new Date().toISOString(), puesto]
  ).then(function () {
    estado.escrituraOk = true
    estado.errorEscritura = ''
    estado.conectado = true
    estado.ultimoSync = Date.now()
    return true
  }).catch(function (e) {
    estado.escrituraOk = false
    estado.errorEscritura = e.message
    return false
  })
}

function borrarPuesto(puesto) {
  return pool.query('DELETE FROM abonos WHERE puesto=$1', [puesto])
    .then(function () { return pool.query('DELETE FROM puestos WHERE puesto=$1', [puesto]) })
    .then(function () {
      estado.conectado = true
      estado.ultimoSync = Date.now()
      return true
    }).catch(function (e) {
      estado.escrituraOk = false
      estado.errorEscritura = e.message
      return false
    })
}

// Anota un abono. El saldo se recalcula leyendo la suma, nunca sumando en memoria,
// para que no se acumule error si dos abonos llegan juntos.
function anotarAbono(puesto, monto, nota) {
  return pool.query(
    'INSERT INTO abonos (puesto, monto, nota, fecha) VALUES ($1,$2,$3,$4)',
    [puesto, monto, nota || '', new Date().toISOString()]
  ).then(function () {
    estado.escrituraOk = true
    estado.errorEscritura = ''
    estado.conectado = true
    estado.ultimoSync = Date.now()
    return true
  }).catch(function (e) {
    estado.escrituraOk = false
    estado.errorEscritura = e.message
    estado.conectado = false
    console.log('Afiche fallo al anotar abono del puesto ' + puesto + ': ' + e.message)
    return false
  })
}

// Historial de abonos, del mas reciente al mas antiguo.
function leerAbonos() {
  return pool.query(
    'SELECT id, puesto, monto, nota, fecha FROM abonos ORDER BY id DESC LIMIT 500'
  ).then(function (r) {
    return r.rows.map(function (f) {
      return { id: f.id, puesto: f.puesto, monto: f.monto, nota: f.nota, fecha: f.fecha }
    })
  })
}

function selftest() {
  return pool.query('SELECT 1').then(function () {
    estado.conectado = true
    estado.errorConexion = ''
    return leerAbonos().then(function () {
      // escritura real sobre una fila de prueba que se borra enseguida
      return anotarAbono(-999, 1, 'prueba').then(function (ok) {
        if (!ok) return false
        return pool.query('DELETE FROM abonos WHERE puesto=$1', [-999]).then(function () {
          return true
        })
      })
    })
  }).catch(function (e) {
    estado.conectado = false
    estado.escrituraOk = false
    estado.errorConexion = e.message
    estado.errorEscritura = e.message
    return false
  })
}

module.exports = {
  activo: estado.activo,
  estado: estado,
  TOTAL: TOTAL_PUESTOS,
  TOPE: TOPE,
  asegurar: asegurar,
  cargar: cargar,
  leerLogo: leerLogo,
  leerLogosTodos: leerLogosTodos,
  guardarPuesto: guardarPuesto,
  guardarLogo: guardarLogo,
  estadoLogo: estadoLogo,
  borrarPuesto: borrarPuesto,
  anotarAbono: anotarAbono,
  leerAbonos: leerAbonos,
  probar: selftest
}