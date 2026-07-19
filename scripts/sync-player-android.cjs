#!/usr/bin/env node
//
// Sincroniza player/index.html → android/app/src/main/assets/index.html.
//
// El archivo Android es IDÉNTICO al web EXCEPTO dos bloques:
//
//   BLOQUE 1 — Init Supabase (web: SDK CDN / android: cliente REST ES5)
//     En web:    <!-- CDN --> + <script src="..."> + // INIT SUPABASE { ... }
//     En android: (sin CDN) + // CLIENTE REST MINIMAL { ... } + initAfterLib + helpers
//
//   BLOQUE 2 — Arranque (web: init() con guard SDK / android: init() llama initAfterLib)
//     Desde // ════...ARRANQUE hasta fin de archivo.
//
// El script:
//   1. Lee player/index.html (fuente para TODO lo que no sea los 2 bloques).
//   2. Lee android/index.html para extraer sus 2 bloques específicos.
//   3. Reconstruye el archivo android reemplazando los bloques web con los de android.
//
// Resultado: cambios en HTML, CSS, lógica compartida y logo del player van
// automáticamente al android. Los bloques de plataforma se preservan.
//
'use strict'

const fs   = require('fs')
const path = require('path')

const ROOT    = path.join(__dirname, '..')
const WEB_SRC = path.join(ROOT, 'player', 'index.html')
const APK_DST = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'index.html')

// Ancla única que separa el bloque init de la lógica compartida (existe en ambos).
const RESOLVE_ANCHOR = '// Un storage_path puede ser'
// Ancla del bloque de arranque (existe en ambos, ════ antes del título).
const ARRANQUE_TITLE = '//  ARRANQUE'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readLines(file) {
  return fs.readFileSync(file, 'utf8').split('\n')
}

function findLine(lines, needle, label) {
  const i = lines.findIndex(function(l) { return l.includes(needle) })
  if (i < 0) throw new Error('Marcador no encontrado en ' + label + ': ' + needle)
  return i
}

function sectionStart(lines, sectionTitle, label) {
  const ti = findLine(lines, sectionTitle, label)
  let i = ti - 1
  while (i > 0 && !lines[i].includes('════')) i--
  if (i <= 0) throw new Error('Borde ════ no encontrado antes de: ' + sectionTitle)
  return i
}

// ---------------------------------------------------------------------------
// Leer fuentes
// ---------------------------------------------------------------------------

const webLines = readLines(WEB_SRC)
const apkLines = readLines(APK_DST)

// ---------------------------------------------------------------------------
// PASO 1: Eliminar las 2 líneas CDN del web (comment + script tag).
// ---------------------------------------------------------------------------

const step1 = webLines.filter(function(l) {
  return !l.includes('<!-- ── Supabase como UMD') && !l.includes('cdn.jsdelivr.net')
})

// ---------------------------------------------------------------------------
// PASO 2: Reemplazar el bloque INIT SUPABASE (web) con el bloque
//         CLIENTE REST ES5 + initAfterLib + helpers (android).
// ---------------------------------------------------------------------------

const webInitStart   = sectionStart(step1,    '//  INIT SUPABASE',        'player/index.html')
const webInitEnd     = findLine    (step1,      RESOLVE_ANCHOR,             'player/index.html')

const apkClientStart = sectionStart(apkLines,  '//  CLIENTE REST MINIMAL', 'android/index.html')
const apkClientEnd   = findLine    (apkLines,   RESOLVE_ANCHOR,             'android/index.html')

const apkClientBlock = apkLines.slice(apkClientStart, apkClientEnd)

const step2 = step1.slice(0, webInitStart).concat(apkClientBlock, step1.slice(webInitEnd))

// ---------------------------------------------------------------------------
// PASO 3: Reemplazar el bloque ARRANQUE (web) con el ARRANQUE android.
// ---------------------------------------------------------------------------

const webArranqueStart = sectionStart(step2,    ARRANQUE_TITLE, 'player/index.html (step2)')
const apkArranqueStart = sectionStart(apkLines,  ARRANQUE_TITLE, 'android/index.html')

const apkArranqueBlock = apkLines.slice(apkArranqueStart)

const result = step2.slice(0, webArranqueStart).concat(apkArranqueBlock)

// ---------------------------------------------------------------------------
// Escribir resultado
// ---------------------------------------------------------------------------

fs.writeFileSync(APK_DST, result.join('\n'), 'utf8')

const ts = new Date().toLocaleTimeString('es', { hour12: false })
console.log(
  '[' + ts + '] sync-android ✅  ' + result.length + ' líneas → android/assets/index.html' +
  '  (HTML+CSS+lógica desde web, bloques ES5+arranque desde android)'
)
