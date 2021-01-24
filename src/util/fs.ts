import archiver from "archiver";
import extract from "extract-zip";
import {
  access as fsAccess,
  constants as fsConstants,
  createWriteStream,
  promises as fsPromises,
  watch as fsWatch,
} from "fs";
import { ncp } from "ncp";
import {
  basename,
  basename as pathBasename,
  dirname as pathDirname,
  join as pathJoin,
  normalize as pathNormalise,
  resolve as pathResolve,
} from "path";
import { Builder as XmlBuilder, parseString as xmlParser } from "xml2js";

// Adapted from https://stackoverflow.com/a/36856787
export async function writeFile(
  path: string,
  data: any,
  encoding: BufferEncoding = "utf8",
  debug = console.log
) {
  debug(`writing file ${path} with encoding ${encoding}`);
  try {
    await fsPromises.writeFile(path, data, encoding);
    debug(`finished writing file ${path} with encoding ${encoding}`);
  } catch (error) {
    throw `ERROR writing file ${path} with encoding ${encoding}: ${error}`;
  }
}

// Adapted from https://stackoverflow.com/a/36856787
export async function readFile(
  path: string,
  encoding: BufferEncoding = "utf8",
  debug = console.log
) {
  debug(`reading file ${path} with encoding ${encoding}`);
  try {
    const file = await fsPromises.readFile(path, encoding);
    debug(`finished reading file ${path} with encoding ${encoding}`);
    return file;
  } catch (error) {
    throw `ERROR reading file ${path} with encoding ${encoding}: ${error}`;
  }
}

export async function readJSONFile(path: string, debug = console.log) {
  if (!(await fileExists(path))) {
    throw `ERROR JSON file does not exist at ${path}`;
  }

  debug(`loading JSON config file at ${path}`);
  const jsonString = (await readFile(path, "utf8", debug)).toString();

  try {
    return JSON.parse(jsonString);
  } catch (error) {
    throw `FAILED to parse JSON file: ${error}`;
  }
}

export async function cpDir(
  source: string,
  dest: string,
  flatten = false,
  debug = console.log
) {
  debug(
    `copying directory ${source} to ${dest}${
      flatten ? " (flatten = true)" : ""
    }`
  );
  if (flatten) {
    try {
      await forEachDirInDir(
        source,
        async (dir) => {
          await cpDir(pathJoin(source, dir), dest, true);
        },
        () => true,
        debug
      );
      await forEachFileInDir(
        source,
        async (file) => {
          await fsPromises.copyFile(
            pathJoin(source, file),
            pathJoin(dest, basename(file))
          );
        },
        () => true,
        false,
        undefined,
        debug
      );
    } catch (error) {
      throw `FAILED to copy directory ${source} to ${dest}: ${error}`;
    }
  } else {
    await new Promise((resolve, reject) => {
      ncp(source, dest, (error) => {
        if (error) {
          reject(`FAILED to copy directory ${source} to ${dest}: ${error}`);
        } else {
          resolve(null);
        }
      });
    });
  }
}

export async function rmFile(
  file: string,
  throwError = false,
  debug = console.log
) {
  if (await fileExists(file)) {
    try {
      await fsPromises.unlink(file);
      debug(`deleted file ${file}`);
    } catch (error) {
      if (throwError) {
        throw `FAILED to delete file ${file}: ${error}`;
      }
      debug(`FAILED to delete file ${file}: ${error}`);
    }
  }
}

export async function rmFilesInDir(dir: string, debug = console.log) {
  try {
    if (await dirExists(dir)) {
      const files = await fsPromises.readdir(dir);
      for (const file of files) {
        const filePath = pathJoin(dir, file);
        if ((await fsPromises.lstat(filePath)).isDirectory()) {
          await rmFilesInDir(filePath, debug);
          await rmDirectory(filePath, debug);
        } else {
          try {
            await fsPromises.unlink(filePath);
          } catch (unlinkError) {
            debug(unlinkError);
          }
        }
      }
    }
  } catch (readDirError) {
    debug(readDirError);
  }
}

export async function rmDirectory(dir: string, debug = console.log) {
  // Remove directory if it exists
  try {
    const stat = await fsPromises.stat(dir);
    if (stat.isDirectory()) {
      await fsPromises.rmdir(dir);
    }
  } catch (err) {
    if (err && err.code === "ENOENT") {
    } else {
      throw `error removing directory ${err}`;
    }
  }
}

export async function makeDirectory(dir: string, debug = console.log) {
  // Make directory if it doesn't exist
  try {
    await fsPromises.stat(dir);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      try {
        debug(`creating directory ${dir}`);
        await fsPromises.mkdir(dir, { recursive: true });
      } catch (error) {
        debug(`error creating output directory ${error}`);
      }
    }
  }
}

/**
 *
 *
 * @export
 * @param sourceDir
 * @param func Function performed on each directory in sourceDir (the file argument is only the basename of the sourceDir - use join(sourceDir, file) to resolve path)
 * @param [debug=console.log]
 */
export async function forEachDirInDir(
  sourceDir: string,
  func: (fileName: string) => Promise<void>,
  filter: (file: string) => boolean = (file) => true,
  debug = console.log
) {
  for (const filename of await fsPromises.readdir(sourceDir)) {
    if ((await fsPromises.stat(pathJoin(sourceDir, filename))).isDirectory()) {
      if (filter(filename)) {
        await func(filename);
      }
    }
  }
}

/**
 *
 *
 * @export
 * @param sourceDir
 * @param func Function performed on each directory in sourceDir (the file argument is only the basename of the sourceDir - use join(sourceDir, file)) to resolve path)
 * @param [debug=console.log]
 */
export async function forEachFileInDir(
  sourceDir: string,
  func: (filePath: string) => Promise<void>,
  filter: (file: string) => boolean = (file) => true,
  recursive = false,
  encoding: BufferEncoding = "utf8",
  debug = console.log
) {
  for (const filename of await fsPromises.readdir(sourceDir, encoding)) {
    const filePath = pathJoin(sourceDir, filename);
    if ((await fsPromises.stat(filePath)).isFile()) {
      if (filter(filename)) {
        await func(filePath);
      }
    } else if (recursive && filter(filename)) {
      await forEachFileInDir(filePath, func, filter, true, encoding, debug);
    }
  }
}

export async function lsDir(
  dir: string,
  encoding: BufferEncoding = "utf8",
  debug = console.log
) {
  if ((await fsPromises.stat(dir)).isDirectory()) {
    try {
      return await fsPromises.readdir(dir, encoding);
    } catch (error) {
      throw `failed to read directory ${dir}: ${error}`;
    }
  }

  throw `failed to read directory ${dir}: it isn't a valid directory`;
}

export function zipDir(
  dir: string,
  outputPath: string,
  debug = console.log
): Promise<void> {
  return new Promise((resolve, reject) => {
    debug(`zipping ${outputPath}: from directory ${dir}`);
    const output = createWriteStream(outputPath);
    const archive = archiver("zip", {
      zlib: { level: 9 }, // Sets the compression level.
    });

    // listen for all archive data to be written
    // 'close' event is fired only when a file descriptor is involved
    output.on("close", () => {
      debug(`zipping complete ${outputPath}: ${archive.pointer()} total bytes`);
      resolve();
    });

    // This event is fired when the data source is drained no matter what was the data source.
    // It is not part of this library but rather from the NodeJS Stream API.
    // @see: https://nodejs.org/api/stream.html#stream_event_end
    output.on("end", () => {
      debug(`zipping end${outputPath}: data has been drained`);
    });

    // good practice to catch warnings (ie stat failures and other non-blocking errors)
    archive.on("warning", (err) => {
      if (err.code === "ENOENT") {
        debug(`zipping ERROR ${outputPath}: ${err}`);
      } else {
        reject(`zipping ERROR ${outputPath}: ${err}`);
      }
    });

    // good practice to catch this error explicitly
    archive.on("error", (err) => {
      reject(`zipping ERROR ${outputPath}: ${err}`);
    });

    // pipe archive data to the file
    archive.pipe(output);

    // append files from a sub-directory, putting its contents at the root of archive
    archive.directory(dir, false);

    // finalize the archive (ie we are done appending files but streams have to finish yet)
    // 'close', 'end' or 'finish' may be fired right after calling this method so register to them beforehand
    archive.finalize();
  });
}

export async function unzipToDir(
  inZip: string,
  outDir: string,
  debug = console.log
): Promise<void> {
  debug(`unzipping ${inZip}: to directory ${outDir}`);
  try {
    await extract(pathResolve(inZip), { dir: pathResolve(outDir) });
  } catch (err) {
    debug(err);
    throw `unzipping error ${inZip}: ${err}`;
  }
  debug(`unzipping complete ${inZip}`);
}

export async function fileExists(
  filePath: string,
  debug = console.log
): Promise<boolean> {
  try {
    await fsPromises.access(filePath, fsConstants.R_OK);
    const stat = await fsPromises.stat(filePath);
    if (stat.isFile()) {
      return true;
    }
  } catch (err) {}
  return false;
}

export async function dirExists(
  filePath: string,
  debug = console.log
): Promise<boolean> {
  try {
    await fsPromises.access(filePath, fsConstants.R_OK);
    const stat = await fsPromises.stat(filePath);
    if (stat.isDirectory()) {
      return true;
    }
  } catch (err) {}
  return false;
}

export async function dirIsEmpty(dir: string) {
  try {
    return (await fsPromises.readdir(dir)).length === 0;
  } catch (err) {
    return undefined;
  }
}

// Adapted from https://stackoverflow.com/a/47764403
export function checkExistsWithTimeout(
  filePath: string,
  timeout: number,
  debug = console.log
) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      watcher.close();
      reject(
        `${filePath} did not exists and was not created during the timeout`
      );
    }, timeout);

    fsAccess(filePath, fsConstants.R_OK, (err) => {
      if (!err) {
        clearTimeout(timer);
        watcher.close();
        debug(`${filePath} is READY`);
        resolve(null);
      }
    });

    const dir = pathDirname(filePath);
    const basename = pathBasename(filePath);
    const watcher = fsWatch(dir, (eventType, filename) => {
      if (eventType === "rename" && filename === basename) {
        clearTimeout(timer);
        watcher.close();
        debug(`${filePath} has CHANGED`);
        resolve(null);
      }
    });
  });
}

export function removePathTraversals(filePath: string) {
  return pathNormalise(filePath).replace(/^(\.\.(\/|\\|$))+/, "");
}

export async function saveXMLFile(
  rootObj: any,
  file: string,
  debug = console.log
) {
  let xml;

  try {
    xml = new XmlBuilder().buildObject(rootObj);
    debug("XML generated");
  } catch (error) {
    throw `ERROR generating XML file (${error})`;
  }

  try {
    await fsPromises.writeFile(pathJoin(file), xml);
    debug("XML saved");
  } catch (error) {
    throw `ERROR saving XML file (${error})`;
  }
}

export async function loadXml(path: string, debug = console.log): Promise<any> {
  if (await fileExists(path)) {
    debug(`loading XML File: ${path}`);
    // FIXME: THIS CAN'T HANDLE CRLF LINE ENDINGS
    // -> see https://github.com/Leonidas-from-XIV/node-xml2js/issues/450

    try {
      const xml = await fsPromises.readFile(path);

      return await new Promise((resolve, reject) =>
        xmlParser(xml, (err, result) => {
          if (err) {
            reject(err);
          } else {
            resolve(result);
          }
        })
      );
    } catch (error) {
      throw `ERROR loading XML file (${error})`;
    }
  } else {
    throw `FAILED to load XML file: path does not exist - ${path}`;
  }
}

export async function readCsv(
  file: string,
  del = ",",
  debug = console.log
): Promise<string[][]> {
  return (await readFile(file, "utf8", debug))
    .toString()
    .replace(/[\r]+/g, "")
    .split("\n")
    .map((row) => (row !== "" ? row.split(del) : undefined))
    .filter((row) => typeof row !== "undefined") as string[][];
}
