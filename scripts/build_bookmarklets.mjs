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
  {
    fuente: join(raiz, 'sri_downloader', 'bookmarklet_devolucion.js'),
    destino: join(raiz, 'frontend', 'src', 'utils', 'enviador-devolucion.bookmarklet.txt'),
  },
]

for (const { fuente, destino } of BOOKMARKLETS) {
  const min = execFileSync(process.execPath, [ESBUILD, '--minify', '--target=es2020', fuente], {
    encoding: 'utf8',
  })

  // Saltos de línea reales (siempre dentro de template literals) -> escape \n
  // (primero trim, si no el salto final del archivo se escaparía FUERA de todo string)
  let unaLinea = min.replace(/\r/g, '').trim().replace(/\n/g, '\\n')

  // Fuera las comillas invertidas. El minificador deja los strings simples como
  // template literals (`\n`), y eso rompe el bookmarklet por un camino que no se
  // ve: al COPIAR la dirección de un marcador, Chrome la devuelve URL-codificada
  // y la comilla invertida sale como "%60"; pegar eso en la consola es un error
  // de sintaxis y el script no hace nada. Con comillas normales no hay nada que
  // codificar. (Solo se convierten los literales sin interpolación, que es lo
  // único que produce el minificador acá.)
  unaLinea = unaLinea.replace(/`((?:[^`$\\]|\\.|\$(?!\{))*)`/g, (_, cuerpo) => '"' + cuerpo.replace(/"/g, '\\"') + '"')

  if (unaLinea.includes('`')) {
    throw new Error(`${fuente}: quedaron comillas invertidas: al copiar el marcador se vuelven %60 y rompen el script`)
  }
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

// La extensión corre EL MISMO enviador que el marcador. Se genera de la misma
// fuente para que no puedan divergir: arreglar el marcador y olvidarse de la
// extensión (o al revés) sería la forma más fácil de que uno de los dos vuelva
// a fallar en el portal. Acá no hace falta una sola línea —es un archivo .js
// normal—, así que se copia tal cual, con un encabezado que avisa que es
// generado.
const FUENTE_EXT = join(raiz, 'sri_downloader', 'bookmarklet_devolucion.js')
const DESTINO_EXT = join(raiz, 'extension', 'enviador.js')
const cabecera = [
  '// ARCHIVO GENERADO — no editar acá.',
  '// Sale de sri_downloader/bookmarklet_devolucion.js con:',
  '//     node scripts/build_bookmarklets.mjs',
  '// Es el mismo enviador que usa el marcador; la extensión solo lo inyecta.',
  '',
].join('\n')
writeFileSync(DESTINO_EXT, cabecera + readFileSync(FUENTE_EXT, 'utf8'), 'utf8')
console.log('OK ->', DESTINO_EXT)
