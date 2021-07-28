# Uploads SMB share to Backblaze B2 (their cloud S3-like service)

This is a personal backup script and may not be suited to your use-case. It has some very specific features for my directory structure. It works for me but I'm not intending to support this, or make it general purpose. I've shared this in case it's useful as a reference.

Features:

- Bucket per directory in Samba share
- Files are uploaded with a SHA1 hash to prevent corruption;
- Handles small files and large files, splitting them up over multiple uploads;
- Large files can be resumed by uploading that chunk.
- File revisions: if the filename is the same but the SHA1 is different we'll upload another copy and you can access both (via the Backblaze B2 website or API, but not via this script);
- Never deletes, only appends to Backblaze. Deleting your files on Samba won't be synced to delete your files on Backblaze.

Limitations:

- Synchronous, although I consider this a feature (despite the slowness) because it makes it easier to comprehend errors.
- Requires top-level directories in Samba share. It will ignore top-level files.
- Only tested on Linux. Requires `smbclient` to be installed.

Usage:

```
node samba-to-backblaze-b2.js SAMBA-USERNAME:SAMBA-PASSWORD:SHARE-URL BACKBLAZEB2-APPLICATIONKEYID:BACKBLAZEB2-APPLICATIONKEY [filterNonYears]
```

E.g.

```
node samba-to-backblaze-b2.js USERNAME:PASSWORD://192.168.1.2/shareName keyId:key filterNonYears
```

It makes buckets based on the Samba shareName and the top-level directories of the share. E.g. if you connect to `//192.168.1.2/photos` and that has directories of 2010, 2011, 2012 then it will create Backblaze buckets named "photos-2010", "photos-2011", "photos-2012". Note that Backblaze limits 10k files per bucket, so "photos-2012" could only have 10k files.

The feature that's most specific to my use-case is that if you provide the fifth arg it will filter top-level directories whose names are entirely numbers, because for me those are years and I don't care about other directories.

Requires the package.json deps which includes `samba-client` which depends on 'smbclient'. This is available on Linux. See [upstream docs on samba-client](https://www.npmjs.com/package/samba-client) for more.
