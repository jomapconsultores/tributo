// ------------------------------------------------------------
// Desarrollado por Marco Antonio Posligua San Martín
// ------------------------------------------------------------
//
// Genera el bookmarklet "Bajar EMITIDAS por fecha" que despacha la app:
//   sri_downloader/bookmarklet_emitidos.js  (fuente legible, se edita ACÁ)
//        -> esbuild --minify
//        -> frontend/src/utils/bajador-emitidos.bookmarklet.txt  (una sola línea)
//
// Por qué hace falta un paso propio y no basta con esbuild:
//   1. Un bookmarklet viaja como URL "javascript:", así que tiene que ser UNA
//      línea. esbuild pliega los saltos de línea de los mensajes dentro de
//      template literals y los deja como saltos REALES; acá se vuelven a escapar.
//   2. El carácter de porcentaje se leería como escape de URL: se verifica que no
//      haya quedado ninguno.
//   3. Se valida la sintaxis del resultado antes de escribirlo (new Function).
//
// Uso:  node scripts/build_bookmarklet_emitidos.mjs
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..')
const FUENTE = join(raiz, 'sri_downloader', 'bookmarklet_emitidos.js')
const DESTINO = join(raiz, 'frontend', 'src', 'utils', 'bajador-emitidos.bookmarklet.txt')
const ESBUILD = join(raiz, 'frontend', 'node_modules', 'esbuild', 'bin', 'esbuild')

const min = execFileSync(process.execPath, [ESBUILD, '--minify', '--target=es2020', FUENTE], {
  encoding: 'utf8',
})

// Saltos de línea reales (siempre dentro de template literals) -> escape \n
// (primero trim, si no el salto final del archivo se escaparía FUERA de todo string)
const unaLinea = min.replace(/\r/g, '').trim().replace(/\n/g, '\\n')

if (unaLinea.includes('%')) {
  throw new Error('El código minificado tiene un carácter de porcentaje: rompería la URL javascript:')
}
if (unaLinea.includes('\n')) {
  throw new Error('Quedaron saltos de línea reales en el bookmarklet')
}
new Function(unaLinea)  // valida sintaxis; tira si el escapado rompió algo

writeFileSync(DESTINO, 'javascript:' + unaLinea + '\n', 'utf8')
console.log('OK ->', DESTINO)
console.log('   ', unaLinea.length, 'caracteres (fuente:', readFileSync(FUENTE, 'utf8').length + ')')
