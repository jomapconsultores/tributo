// ------------------------------------------------------------
// Desarrollado por Marco Antonio Posligua San Martín
// ------------------------------------------------------------
//
// Genera los bookmarklets que despacha la app (fuente legible -> .txt de una línea):
//   sri_downloader/bookmarklet_emitidos.js   -> frontend/src/utils/bajador-emitidos.bookmarklet.txt
//   sri_downloader/bookmarklet_recibidos.js  -> frontend/src/utils/bajador-gastos.bookmarklet.txt
// Las fuentes se editan SIEMPRE en sri_downloader/; los .txt son generados.
//
// Por qué hace falta un paso propio y no basta con esbuild:
//   1. Un bookmarklet viaja como URL "javascript:", así que tiene que ser UNA
//      línea. esbuild pliega los saltos de línea de los mensajes dentro de
//      template literals y los deja como saltos REALES; acá se vuelven a escapar.
//   2. El carácter de porcentaje se leería como escape de URL: se verifica que no
//      haya quedado ninguno.
//   3. Se valida la sintaxis del resultado antes de escribirlo (new Function).
//
// Uso:  node scripts/build_bookmarklets.mjs
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..')
const ESBUILD = join(raiz, 'frontend', 'node_modules', 'esbuild', 'bin', 'esbuild')

const BOOKMARKLETS = [
  {
    fuente: join(raiz, 'sri_downloader', 'bookmarklet_emitidos.js'),
    destino: join(raiz, 'frontend', 'src', 'utils', 'bajador-emitidos.bookmarklet.txt'),
  },
  {
    fuente: join(raiz, 'sri_downloader', 'bookmarklet_recibidos.js'),
    destino: join(raiz, 'frontend', 'src', 'utils', 'bajador-gastos.bookmarklet.txt'),
  },
]

for (const { fuente, destino } of BOOKMARKLETS) {
  const min = execFileSync(process.execPath, [ESBUILD, '--minify', '--target=es2020', fuente], {
    encoding: 'utf8',
  })

  // Saltos de línea reales (siempre dentro de template literals) -> escape \n
  // (primero trim, si no el salto final del archivo se escaparía FUERA de todo string)
  const unaLinea = min.replace(/\r/g, '').trim().replace(/\n/g, '\\n')

  if (unaLinea.includes('%')) {
    throw new Error(`${fuente}: el código minificado tiene un carácter de porcentaje: rompería la URL javascript:`)
  }
  if (unaLinea.includes('\n')) {
    throw new Error(`${fuente}: quedaron saltos de línea reales en el bookmarklet`)
  }
  new Function(unaLinea)  // valida sintaxis; tira si el escapado rompió algo

  writeFileSync(destino, 'javascript:' + unaLinea + '\n', 'utf8')
  console.log('OK ->', destino)
  console.log('   ', unaLinea.length, 'caracteres (fuente:', readFileSync(fuente, 'utf8').length + ')')
}
