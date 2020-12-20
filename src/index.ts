require('dotenv').config()

import { join, parse } from "path"
import { fileExists, forEachFileInDir, readJSONFile, writeFile } from "./util/fs"
import { debug as debugInit } from 'debug'

const debug = debugInit('movie-scraper:init')

debug("HELLO!")

if (typeof process.env.DATA_DIR === 'undefined')
  throw 'DATA_DIR must be set to a valid directory'

const LIBRARY_PATH = join(process.env.DATA_DIR, 'lib.json')
let library: { nfoFiles: string[] } = { nfoFiles: [] }

async function init() {
  if (await fileExists(LIBRARY_PATH)) {
    debug(`${LIBRARY_PATH} library file found!\nReading...`)
    library = await readJSONFile(LIBRARY_PATH, debug)

    debug(`Library has ${library.nfoFiles.length} NFO files`)
  }

  if (typeof process.env.SCAN_DIR === 'string') {
    debug(`Scanning directory ${process.env.SCAN_DIR}...`)
    await forEachFileInDir(process.env.SCAN_DIR, async (file) => {
      const filePath = parse(file)
      if (filePath.ext === '.nfo' && !library.nfoFiles.includes(file)) {
        library.nfoFiles.push(file)
        debug(`found ${file}`)
      }
    }, undefined, true, undefined, debug)

    debug(`Writing library file to ${LIBRARY_PATH}`)
    writeFile(LIBRARY_PATH, JSON.stringify(library))
  }
}

init()
