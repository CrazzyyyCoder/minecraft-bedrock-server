// Downloads the server code from Microsoft
const fs = require('fs-extra');
const assert = require('assert');
const archiver = require('archiver');
const unzipper = require('unzipper')
const util = require('util');

const stream = require('stream');
const pipeline = util.promisify(stream.pipeline);


const {
  CONFIG_FILE_PATH,
  SERVER_WORLDS_FOLDER_NAME,
  SERVER_WORLDS_FOLDER_PATH,
  BACKUP_FOLDER_NAME,
  BACKUP_FOLDER_PATH,
  BACKUP_TYPES,
  MS_IN_SEC,
  platform
} = require('./utils.js');


const configFile = fs.readFileSync(CONFIG_FILE_PATH, 'utf8');
const config = JSON.parse(configFile);
const backupConfig = config.backup;
assert(backupConfig, `Could not find field 'backup' at root of config`);
// too lazy for more error handling :/
const localBackupKeepCount = backupConfig["num-backups-to-keep-for-type"].local;
const remoteBackupKeepCount = backupConfig["num-backups-to-keep-for-type"].remote;

async function _createBackupFromFileToCopyLength(fileToCopyLength, backupStartTime, backupType) {
  assert(backupType, `Undefined backup type`);
  fs.ensureDirSync(BACKUP_FOLDER_PATH);
  const archive = archiver('zip');
  const outputArchiveStream = fs.createWriteStream(`${BACKUP_FOLDER_PATH}/${backupStartTime}_${backupType}.zip`);
  archive.pipe(outputArchiveStream);
  await Promise.all(Object.keys(fileToCopyLength).map(async (fileName) => {
    const contentLength = fileToCopyLength[fileName];

    // Sadly, the 'save query command' doesn't give us the correct path for all
    // files - attempting to fix that now
    if (!(await fs.pathExists(`${SERVER_WORLDS_FOLDER_PATH}/${fileName}`))) {
      fileName = fileName.replace('/', '/db/');
    }
    if (!(await fs.pathExists(`${SERVER_WORLDS_FOLDER_PATH}/${fileName}`))) {
      fileName = fileName.replace('/db/', '/db/lost/');
    }

    const source = `${SERVER_WORLDS_FOLDER_PATH}/${fileName}`;
    const readStream = fs.createReadStream(source, {
      end: contentLength - 1
    });
    archive.append(readStream, {
      name: fileName
    });
  }));
  archive.finalize();
  await new Promise(fulfill => outputArchiveStream.on("close", fulfill));
  // purge old backups now since we may have too many
  try {
    await purgeOldLocalBackups();
  } catch (e) {
    console.error(e);
  }
  console.log(`Finished creating backup of server state at ${new Date(backupStartTime*MS_IN_SEC).toLocaleString()} with type ${backupType}\n`);
};

async function createBackup(backupFileListString, backupStartTime, backupType) {
  const instructionStrings = backupFileListString.split(', ');
  const fileToCopyLength = {};
  instructionStrings.forEach((instruction) => {
    const splitInstruction = instruction.split(':');
    fileToCopyLength[splitInstruction[0]] = parseInt(splitInstruction[1]);
  });

  await _createBackupFromFileToCopyLength(fileToCopyLength, backupStartTime, backupType);
};


function getFilePathsSync(dir, files_) {
  files_ = files_ || [];
  const files = fs.readdirSync(dir);
  for (var i in files) {
    const name = dir + '/' + files[i];
    if (fs.statSync(name).isDirectory()) {
      getFilePathsSync(name, files_);
    } else {
      files_.push(name);
    }
  }
  return files_;
}

async function createUnscheduledBackup(backupStartTime) {
  // blindly tries to create a backup of everything in the current worlds folder
  // without the file and position list provided by 'save query'
  console.log('!!!!!!!!!!!\n\nRUNNING BACKUP DUE TO A FORCED STOP - creating a sketchy ad hoc backup of server state...');
  const filePaths = getFilePathsSync(SERVER_WORLDS_FOLDER_PATH).map(filePath => filePath.replace(`${SERVER_WORLDS_FOLDER_PATH}/`, ''));
  const fileToCopyLength = {};
  filePaths.forEach(path => {
    fileToCopyLength[path] = Infinity;
  });
  await _createBackupFromFileToCopyLength(fileToCopyLength, backupStartTime, BACKUP_TYPES.ON_FORCED_STOP);
  console.log(`\nPlease check the state of the server and make sure the latest backup is a valid one before continued use (use force-restore <BACKUP_FILE_NAME> if necessary)`);
  console.log(`\nIn the future, please use the 'stop' command to kill the server`);
}

async function restoreLatestLocalBackup() {
  fs.ensureDirSync(BACKUP_FOLDER_PATH);
  const backupFiles = await fs.readdir(BACKUP_FOLDER_PATH);
  // TODO: Restore and test
}

async function restoreLocalBackup(backupArchiveName) {

  if (!/\.zip$/gi.test(backupArchiveName)) {
    backupArchiveName = backupArchiveName + '.zip';
  }

  const backupArchivePath = `${BACKUP_FOLDER_PATH}/${backupArchiveName}`;
  if (!(await fs.pathExists(backupArchivePath))) {
    console.error(`Could not find backup archive: ${backupArchivePath}`);
    return false;
  } else {
    fs.removeSync(SERVER_WORLDS_FOLDER_PATH);
    fs.ensureDirSync(SERVER_WORLDS_FOLDER_PATH);
    await pipeline(
      fs.createReadStream(backupArchivePath),
      unzipper.Extract({
        path: SERVER_WORLDS_FOLDER_PATH
      })
    );
    console.log(`Successfully backed up state of server using ${backupArchivePath}`)
    return true;
  }
}

function getBackupsToPurge(backupFileNameList, maxToKeep) {
  backupFileNameList.sort((name1, name2) => {
    const ts1Match = name1.match(/\d*/);
    const ts2Match = name2.match(/\d*/);
    const ts1 = parseInt(ts1Match[0]);
    const ts2 = parseInt(ts2Match[0]);
    return ts2 - ts1;
  });
  if (maxToKeep != null && maxToKeep > -1) {
    return backupFileNameList.slice(maxToKeep);
  } else {
    return [];
  }
};

async function purgeOldLocalBackups() {
  await Promise.all(Object.keys(BACKUP_TYPES).map(async (backupType) => {
    const maxBackupTypes = localBackupKeepCount[backupType];
    const allArchives = await fs.readdir(BACKUP_FOLDER_PATH);
    const backupsToPurge = getBackupsToPurge(allArchives.filter(
      fileName => fileName.includes(backupType)
    ), maxBackupTypes);
    backupsToPurge.forEach(async (backupToPurge) => {
      console.log(`Removing ${backupToPurge} due to parameters defined in config["backup"]["num-backups-to-keep-for-type"]`);
      await fs.remove(`${BACKUP_FOLDER_PATH}/${backupToPurge}`);
    })
  }));
}

module.exports = {
  createBackup,
  restoreLocalBackup,
  restoreLatestLocalBackup,
  createUnscheduledBackup
};
