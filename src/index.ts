import { forEachFileInDir } from "./util/fs"

require('dotenv').config()
const debug = require('debug')('index')

async function init() {
  if (typeof process.env.SCAN_DIR === 'string') {
    await forEachFileInDir(process.env.SCAN_DIR, async (file) => {
      console.log(file);
    }, (file) => file.includes(".nfo"))
  }
}

init()
