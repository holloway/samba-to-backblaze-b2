const usage = `
Usage:
 node samba-to-backblaze-b2.js SAMBA-USERNAME:SAMBA-PASSWORD:SHARE-URL BACKBLAZEB2-APPLICATIONKEYID:BACKBLAZEB2-APPLICATIONKEY [filterNonYears]
E.g.
 node samba-to-backblaze-b2.js USERNAME:PASSWORD://192.168.1.2/shareName keyId:key filterNonYears
`;

const fs = require("fs");
const SMB2 = require("@marsaud/smb2");
const SambaClient = require("samba-client");
const B2 = require("backblaze-b2");
const crypto = require("crypto");
const { shuffle, attempt } = require("lodash");

console.log(process.argv);

if (
  process.argv.length < 4 ||
  process.argv0.includes("--help") ||
  process.argv0.includes("-?")
) {
  throw Error(usage);
}

let directoryFilter = (val) => val;

if (process.argv.length === 5) {
  if (process.argv[4] === "filterNonYears") {
    directoryFilter = (rootDir) => !rootDir.replace(/[0-9]/gi, "");
  }
}

const sambaParts = process.argv[2].split(":");

if (sambaParts.length !== 3) {
  throw Error(usage);
}

const backBlazeParts = process.argv[3].split(":");
if (backBlazeParts.length !== 2) {
  throw Error(usage);
}

const [sambaUsername, sambaPassword, smbShareForwardSlashes] = sambaParts;
const [applicationKeyId, applicationKey] = backBlazeParts;

const sambaShareName = smbShareForwardSlashes.substr(
  smbShareForwardSlashes.lastIndexOf("/") + 1
);

// create an SMB2 connection
// This is just used for walking directories
const smb2Client = new SMB2({
  share: smbShareForwardSlashes.replace(/\//g, "\\"),
  domain: "WORKGROUP",
  username: sambaUsername,
  password: sambaPassword,
});

// create a 'smbclient' cli wrapper client
// because SMB2 crashes with large files
const smbclientcli = new SambaClient({
  address: smbShareForwardSlashes,
  username: sambaUsername,
  password: sambaPassword,
  domain: "WORKGROUP",
});

process.on("uncaughtException", function (exception) {
  console.error(exception);
});

process.on("unhandledRejection", (reason, p) => {
  console.error("Unhandled Rejection at: Promise ", p, " reason: ", reason);
});

(async () => {
  const rootDirs = await smb2Client.readdir("");
  rootDirs.sort();
  const years = shuffle(rootDirs.filter(directoryFilter));
  const b2 = new B2({
    applicationKeyId,
    applicationKey,
  });
  const { data: terms } = await b2.authorize(); // must authorize first (authorization lasts 24 hrs)
  const absoluteMinimumChunkSize = terms.absoluteMinimumPartSize;
  const chunkSize = terms.recommendedPartSize;
  console.log(`Recommended chunk size ${chunkSize} bytes.`);

  const {
    data: { buckets: rawBuckets },
  } = await b2.listBuckets();

  const buckets = Array.from(rawBuckets).map((bucket) => ({
    bucketName: bucket.bucketName,
    bucketId: bucket.bucketId,
  }));

  const getYearFiles = async (year) => {
    console.log(`Getting SMB files for ${year}`);
    const files = [];
    const walk = async (dir) => {
      const paths = await smb2Client.readdir(dir);
      const stats = await Promise.all(
        paths.map(async (path) => smb2Client.stat(`${dir}\\${path}`))
      );
      const isDirectories = stats.map((stat) => stat.isDirectory());
      for (let z = 0; z < isDirectories.length; z++) {
        const isDirectory = isDirectories[z];
        const smbPath = `${dir}\\${paths[z]}`;
        const targetPath = smbPath.replace(/\\/g, "/");
        files.push({ smbPath, targetPath, isDirectory });
        if (isDirectory) {
          await walk(smbPath);
        }
      }
    };

    await walk(year);

    return files.map((file) => ({
      ...file,
      targetPath: file.targetPath.substr(year.length + 1),
    }));
  };

  const backupYear = async (year) => {
    const bucketName = `${sambaShareName}-${year}`;
    const yearFilesSorted = await getYearFiles(year);
    const yearFiles = shuffle(yearFilesSorted);

    let bucket = buckets.find((bucket) => bucket.bucketName === bucketName);

    if (!bucket) {
      console.info(`Bucket "${bucketName}" doesn't exist, so creating it...`);
      try {
        const result = await b2.createBucket({
          bucketName,
          bucketType: "allPrivate",
        });
        bucket = result.data;
      } catch (e) {
        console.error(e);
        console.log("---------");
        console.log(e.response);
        console.log("---------");
        console.log(e.response.data);
        console.log("---------");
        console.log(e.response.data.code);
        console.log("---------");
        if (e.response.data.code === "duplicate_bucket_name") {
          console.log(
            "Duplicate bucket name error so it already exists but they weren't previously able to list it. Weird. Giving up for now."
          );
          return;
        } else {
          console.error({ "Unknown error": true, e });
        }
      }
    }

    console.log(`Syncing ${yearFiles.length} files into bucket ${bucketName}`);

    const listFileNamesArg = {
      bucketId: bucket.bucketId,
      maxFileCount: 10000, // after trial and error the max amount they support per bucket as of July 2021
    };

    // console.log(listFileNamesArg);

    const {
      data: { files: existingBucketFiles },
    } = await b2.listFileNames(listFileNamesArg);

    // console.log({ existingBucketFiles });

    for (let x = 0; x < yearFiles.length; x++) {
      const { smbPath, targetPath, isDirectory } = yearFiles[x];

      if (isDirectory) {
        // no need to create directories.
        // BackBlaze will make directories when
        // files have "/" in their name
        continue;
      }

      const TEMP_FILE_PATH = "smb-backup.tmp"; // all files are copied here

      // console.log(`Reading ${smbPath}`);

      await smbclientcli.getFile(smbPath, TEMP_FILE_PATH);

      // const readStream = await smb2Client.createReadStream(smbPath);

      const readStream = fs.createReadStream(TEMP_FILE_PATH);

      const sha1Hash = crypto.createHash("sha1");
      sha1Hash.setEncoding("hex");

      readStream.pipe(sha1Hash);

      const sha1 = await new Promise((resolve, reject) => {
        readStream.on("end", () => resolve(sha1Hash.read()));
        readStream.on("error", () => reject());
      });

      const { size } = fs.statSync(TEMP_FILE_PATH);

      //   console.log({ targetPath, size, sha1 });

      const existingBucketFile = existingBucketFiles.find(
        (existingBucketFile) => {
          // if (targetPath.includes("/") || targetPath.includes("\\")) {
          //   if (targetPath.includes(existingBucketFile.fileName)) {
          //     console.log(
          //       "UPLOADING DIRPATH",
          //       existingBucketFile,
          //       existingBucketFile.fileName,
          //       targetPath
          //     );
          //   }
          // }
          return existingBucketFile.fileName === targetPath;
        }
      );

      const noofChunks = Math.ceil(size / (chunkSize - 1));

      const hasNoBackblazeSha1 =
        existingBucketFile && existingBucketFile.contentSha1 === "none";
      const sameSha1 =
        existingBucketFile && existingBucketFile.contentSha1 === sha1;
      const sameSize =
        existingBucketFile && existingBucketFile.contentLength === size;

      if (
        (noofChunks === 1 && existingBucketFile && sameSha1 && sameSize) || // small files have sha1
        (noofChunks >= 2 &&
          existingBucketFile &&
          hasNoBackblazeSha1 &&
          sameSize) // large files don't have a sha1 (Backblaze have an excuse about storing large files as several files so apparently it's hard to make a sha1 but from a user's perspective of course we want a sha1 of a backup and we don't care about storage details and this is a crappy workaround)
      ) {
        console.log(
          `- ${targetPath} ${
            noofChunks >= 2 ? "(large file)" : ""
          } already backed up and identical (filename already exists, same filesize ${
            existingBucketFile.contentLength
          } vs ${size} ${
            !hasNoBackblazeSha1 && sameSha1 ? ", same hash" : ""
          }). Skipping...`
        );
        continue;
      }

      console.log(
        `- ${targetPath} not backed up yet (because ${
          !existingBucketFile ? "Filename doesn't exist." : ""
        } ${
          existingBucketFile && !sameSize
            ? `Different filesize ${
                existingBucketFile && existingBucketFile.contentLength
              } ${size}.`
            : ""
        } ${
          existingBucketFile && !sameSha1
            ? `Different sha1 hash ${existingBucketFile.contentSha1} != ${sha1}.`
            : ""
        })`
      );

      //   console.log(
      //     `  - Downloaded SMB file ${smbPath} written file to ${TEMP_FILE_PATH} (${size} bytes) SHA1:${sha1}`
      //   );

      if (noofChunks >= 2) {
        // Use large file API
        console.log(
          `  - Large file upload. Splitting file into ${noofChunks} parts`
        );
        const { data: startLargeFileResponse } = await b2.startLargeFile({
          bucketId: bucket.bucketId,
          fileName: targetPath,
        });

        const { fileId } = startLargeFileResponse;
        const { data: uploadPartUrlData } = await b2.getUploadPartUrl({
          fileId,
        });

        const { data: uploadedChunksData } = await b2.listParts({
          fileId,
          startPartNumber: 1, // optional
          maxPartCount: 1000, // optional (max: 1000)
        });

        const { parts: uploadedChunks } = uploadedChunksData;

        const partSha1Array = [];

        for (let y = 0; y < noofChunks; y++) {
          const partNumber = y + 1;
          const start = y * chunkSize;
          const end = (y + 1) * chunkSize - 1;

          const chunkReadStream = fs.createReadStream(TEMP_FILE_PATH, {
            start,
            end,
          });

          const chunkSha1Hash = crypto.createHash("sha1");
          chunkSha1Hash.setEncoding("hex");
          chunkReadStream.pipe(chunkSha1Hash);

          const chunkParts = [];
          chunkReadStream.on("data", (chunk) => {
            chunkParts.push(chunk);
          });

          const [chunkBuffer, chunkSha1] = await new Promise(
            (resolve, reject) => {
              chunkReadStream.on("end", () =>
                resolve([Buffer.concat(chunkParts), chunkSha1Hash.read()])
              );
              chunkReadStream.on("error", reject);
            }
          );

          partSha1Array.push(chunkSha1);

          if (uploadedChunks.includes(partNumber)) {
            console.log(
              `  - Already uploaded ${targetPath} part ${partNumber}`
            );
            continue;
          }

          console.log(
            `  - Uploading part number ${partNumber} ${start}-${end}`
          );

          const { data: uploadPartData } = await reattempt(
            async () => {
              return await b2.uploadPart({
                partNumber, // A number from 1 to 10000
                uploadUrl: uploadPartUrlData.uploadUrl,
                uploadAuthToken: uploadPartUrlData.authorizationToken, // comes from getUploadPartUrl();
                data: chunkBuffer, // this is expecting a Buffer not an encoded string,
                hash: chunkSha1, // optional data hash, will use sha1(data) if not provided
              });
            },
            10,
            () => {
              b2.cancelLargeFile({ fileId });
            }
          );
        }

        const fileLargeFileArgs = {
          fileId,
          partSha1Array,
        };

        const { data: finishLargeFileData } = await reattempt(async () => {
          return await b2.finishLargeFile(fileLargeFileArgs);
        }, 10);

        console.log(`  - Finished uploading large file ${targetPath}`);
      } else {
        const { data: uploadUrlData } = await b2.getUploadUrl({
          bucketId: bucket.bucketId,
        });

        const fileReadStream = fs.createReadStream(TEMP_FILE_PATH);

        const chunkParts = [];
        fileReadStream.on("data", (chunk) => {
          chunkParts.push(chunk);
        });

        const fileBuffer = await new Promise((resolve, reject) => {
          fileReadStream.on("end", () => resolve(Buffer.concat(chunkParts)));
          fileReadStream.on("error", reject);
        });

        const { data: uploadFileData } = await reattempt(async () => {
          return await b2.uploadFile({
            uploadUrl: uploadUrlData.uploadUrl,
            uploadAuthToken: uploadUrlData.authorizationToken,
            fileName: targetPath,
            data: fileBuffer, // this is expecting a Buffer, not an encoded string
            hash: sha1, // optional data hash, will use sha1(data) if not provided
          });
        }, 5);

        console.log(`  - uploaded ${targetPath}`);
      }
    }
  };

  for (let i = 0; i < years.length; i++) {
    const year = years[i];
    try {
      await backupYear(year);
    } catch (e) {
      console.error(e);
    }
  }

  console.log("Success? Probably. Maybe run it a few times.");
})();

const reattempt = async (callback, remainingAttempts, cleaup) => {
  let i = remainingAttempts;
  while (i > 0) {
    try {
      const result = await callback();
      return result;
    } catch (e) {
      console.error(e);
      i--;
      console.log(` - Retrying..${i} attempts remaining`);
    }
  }
  console.log(`Giving up trying after ${remainingAttempts} attempts.`);
  if (cleanup) {
    const cleanup = await cleaup();
    console.log(" - Ran cleanup", cleanup);
  }
};
