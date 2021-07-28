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
const { shuffle } = require("lodash");

console.log(process.argv);

if (
  process.argv.length >= 4 ||
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
      const result = await b2.createBucket({
        bucketName,
        bucketType: "allPrivate",
      });
      bucket = result.data;
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
        (existingBucketFile) => existingBucketFile.fileName === targetPath
      );

      const sameSha1 =
        existingBucketFile && existingBucketFile.contentSha1 === sha1;
      const sameSize =
        existingBucketFile && existingBucketFile.contentLength === size;

      if (existingBucketFile && sameSha1 && sameSize) {
        console.log(
          `- ${targetPath} already backed up and identical. Skipping...`
        );
        continue;
      }

      console.log(
        `- ${targetPath} not backed up yet (because ${
          !existingBucketFile ? "Filename doesn't exist." : ""
        } ${existingBucketFile && !sameSize ? "Different filesize." : ""} ${
          existingBucketFile && !sameSha1 ? "Different sha1 hash." : ""
        } `
      );

      //   console.log(
      //     `  - Downloaded SMB file ${smbPath} written file to ${TEMP_FILE_PATH} (${size} bytes) SHA1:${sha1}`
      //   );

      const noofChunks = Math.ceil(size / chunkSize);

      if (noofChunks >= 2) {
        // Use large file API
        console.log("Large file upload...");
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

          const chunkReadStream = fs.createReadStream(TEMP_FILE_PATH, {
            start: y * chunkSize,
            end: (y + 1) * chunkSize,
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
            console.log(`Already uploaded ${targetPath} part ${partNumber}`);
            continue;
          }

          console.log(`Uploading part number ${partNumber}`);

          const { data: uploadPartData } = await b2.uploadPart({
            partNumber, // A number from 1 to 10000
            uploadUrl: uploadPartUrlData.uploadUrl,
            uploadAuthToken: uploadPartUrlData.authorizationToken, // comes from getUploadPartUrl();
            data: chunkBuffer, // this is expecting a Buffer not an encoded string,
            hash: chunkSha1, // optional data hash, will use sha1(data) if not provided
          });
        }

        const fileLargeFileArgs = {
          fileId,
          partSha1Array,
        };
        const { data: finishLargeFileData } = await b2.finishLargeFile(
          fileLargeFileArgs
        );
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

        const { data: uploadFileData } = await b2.uploadFile({
          uploadUrl: uploadUrlData.uploadUrl,
          uploadAuthToken: uploadUrlData.authorizationToken,
          fileName: targetPath,
          data: fileBuffer, // this is expecting a Buffer, not an encoded string
          hash: sha1, // optional data hash, will use sha1(data) if not provided
        });

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
