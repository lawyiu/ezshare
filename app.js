#!/usr/bin/env node
'use strict';

const express = require('express');
const formidable = require('formidable');
const { join, basename } = require('path');
const fs = require('fs-extra');
const morgan = require('morgan');
const asyncHandler = require('express-async-handler');
const archiver = require('archiver');
const pMap = require('p-map');
const os = require('os');
const flatMap = require('lodash/flatMap');
const contentDisposition = require('content-disposition');
const { createProxyMiddleware } = require('http-proxy-middleware');
const qrcode = require('qrcode-terminal');
const clipboardy = require('clipboardy');
const bodyParser = require('body-parser');
const filenamify = require('filenamify');
const util = require('util');
const stream = require('stream');
const https = require('https');
const selfsigned = require('selfsigned');

const pipeline = util.promisify(stream.pipeline);

const maxFields = 1000;
const debug = false;

const isDirectory = async (filePath) => (await fs.lstat(filePath)).isDirectory();

module.exports = ({ sharedPath: sharedPathIn, port, maxUploadSize, zipCompressionLevel, devMode }) => {
  // console.log({ sharedPath: sharedPathIn, port, maxUploadSize, zipCompressionLevel });
  const sharedPath = sharedPathIn || process.cwd();

  function getFilePath(relPath) {
    if (relPath == null) return sharedPath;
    return join(sharedPath, join('/', relPath));
  }

  const app = express();

  if (debug) app.use(morgan('dev'));

  // NOTE: Must support non latin characters
  app.post('/api/upload', asyncHandler(async (req, res) => {
    // console.log(req.headers)

    // parse a file upload
    const form = new formidable({
      multiples: true,
      keepExtensions: true,
      uploadDir: sharedPath,
      maxFileSize: maxUploadSize,
      maxFields,
    });
  
    form.parse(req, async (err, fields, { files: filesIn }) => {
      if (err) {
        console.error('Upload failed', err);
        res.status(400).send({ error: { message: err.message } });
        return;
      }

      if (filesIn) {
        const files = Array.isArray(filesIn) ? filesIn : [filesIn];

        // console.log(JSON.stringify({ fields, files }, null, 2));
        console.log('Uploaded files:');
        files.forEach((f) => console.log(f.name, `(${f.size} bytes)`));

        await pMap(files, async (file) => {
          try {
            const targetPath = join(sharedPath, filenamify(file.name));
            if (!(await fs.pathExists(targetPath))) await fs.rename(file.path, targetPath);
          } catch (err) {
            console.error(`Failed to rename ${file.name}`, err);
          }  
        }, { concurrency: 10 });
      }
      res.end();
    });
  }));

  // NOTE: Must support non latin characters
  app.post('/api/paste', bodyParser.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
    if (req.body.saveAsFile === 'true') {
      await fs.writeFile(getFilePath(`client-clipboard-${new Date().getTime()}.txt`), req.body.clipboard);
    } else {
      await clipboardy.write(req.body.clipboard);
    }
    res.end();
  }));

  // NOTE: Must support non latin characters
  app.post('/api/copy', asyncHandler(async (req, res) => {
    res.send(await clipboardy.read());
  }));
  
  async function serveDirZip(filePath, res) {
    const archive = archiver('zip', {
      zlib: { level: zipCompressionLevel },
    });

    res.writeHead(200, {
      'Content-Type': 'application/zip',
      // NOTE: Must support non latin characters
      'Content-disposition': contentDisposition(`${basename(filePath)}.zip`),
    });

    const promise = pipeline(archive, res);

    archive.directory(filePath, basename(filePath));
    archive.finalize();

    await promise;
  }

  app.get('/api/download', asyncHandler(async (req, res) => {
    const filePath = getFilePath(req.query.f);
    const forceDownload = req.query.forceDownload === 'true';
    const isDir = await isDirectory(filePath);
  
    if (isDir) {
      await serveDirZip(filePath, res);
    } else {
      if (forceDownload) {
        // NOTE: Must support non latin characters
        res.set('Content-disposition', contentDisposition(basename(filePath)));
      }

      await pipeline(fs.createReadStream(filePath), res);
    }
  }));

  app.get('/api/browse', asyncHandler(async (req, res) => {
    const curRelPath = req.query.p || '/';
    const curAbsPath = getFilePath(curRelPath);

    let readdirEntries = await fs.readdir(curAbsPath);
    readdirEntries = readdirEntries.sort(new Intl.Collator(undefined, {numeric: true}).compare);

    const entries = (await pMap(readdirEntries, async (entry) => {
      try {
        const fileAbsPath = join(curAbsPath, entry); // TODO what if a file called ".."
        const fileRelPath = join(curRelPath, entry);
        const isDir = await isDirectory(fileAbsPath);
  
        return {
          path: fileRelPath,
          isDir,
          fileName: entry,
        };
      } catch (err) {
        console.warn(err.message);
        // https://github.com/mifi/ezshare/issues/29
        return undefined;
      }
    }, { concurrency: 10 })).filter((f) => f);

    res.send({
      files: [
        { path: join(curRelPath, '..'), fileName: '..', isDir: true },
        ...entries
      ],
      curRelPath,
      sharedPath,
    });
  }));

  console.log(`Sharing path ${sharedPath}`);

  const certAttrs = [{ name: 'commonName', value: 'localhost' }];
  const pems = selfsigned.generate(certAttrs, { days: 999 });

  https.createServer({
    key: pems.private,
    cert: pems.cert,
  }, app).listen(port + 1, () => {
    console.log(`TLS server Listening on port ${port + 1}`);
  });

  app.listen(port, () => {
    const interfaces = os.networkInterfaces();
    const urls = flatMap(Object.values(interfaces), (addresses) => addresses).filter(({ family, address }) => family === 'IPv4' && address !== '127.0.0.1').map(({ address }) => `http://${address}:${port}/`);
    if (urls.length === 0) return;
    console.log('Server listening:');
    urls.forEach((url) => {
      console.log();
      console.log(`Scan this QR code on your phone or enter ${url}`);
      console.log();
      qrcode.generate(url);
    });
  });

  // Serving the frontend depending on dev/production
  if (devMode) app.use('/', createProxyMiddleware({ target: 'http://localhost:3000', ws: true }));
  else app.use('/', express.static(join(__dirname, 'ezshare-frontend/build')));

  // Default to index because SPA
  app.use('*', (req, res) => res.sendFile(join(__dirname, 'ezshare-frontend/build/index.html')));  
};
