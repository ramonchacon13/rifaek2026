const fs = require('fs')
const path = require('path')

const BASE = __dirname
const DATA = path.join(BASE, 'server', 'datos.json')
const URL = process.env.BACKUP_URL || 'https://raw.githubusercontent.com/ramonchacon13/rifaek2026/main/respaldo.json'

function cuenta(d) {
  if (!d || !d.numeros) return 0
  return Object.keys(d.numeros).filter(function (k) { return d.numeros[k] && d.numeros[k].estado !== 'libre' }).length
}

fetch(URL)
  .then(function (r) { return r.json() })
  .then(function (remoto) {
    const remotos = cuenta(remoto)
    if (!remotos) return
    let local = { numeros: {} }
    try { local = JSON.parse(fs.readFileSync(DATA, 'utf8')) } catch (e) {}
    if (cuenta(local) >= remotos) return
    fs.writeFileSync(DATA, JSON.stringify(remoto, null, 2), 'utf8')
    console.log('traidos ' + remotos + ' registros desde GitHub')
  })
  .catch(function () {})
