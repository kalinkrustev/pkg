import { STORE_BLOB, STORE_CONTENT, snapshotify } from '../prelude/common.js';
import { log, wasReported } from './log.js';
import assert from 'assert';
import bufferStream from 'simple-bufferstream';
import { fabricateTwice } from './fabricator.js';
import fs from 'fs';
import multistream from 'multistream';
import streamMeter from 'stream-meter';
import path from 'path';

function discoverPlaceholder (binaryBuffer, searchString, padder) {
  const placeholder = Buffer.from(searchString);
  const position = binaryBuffer.indexOf(placeholder);
  if (position === -1) return { notFound: true };
  return { position, size: placeholder.length, padder };
}

function injectPlaceholder (fd, placeholder, value, cb) {
  const { notFound, position, size, padder } = placeholder;
  if (notFound) assert(false, 'Placeholder for not found');
  if (typeof value === 'number') value = value.toString();
  if (typeof value === 'string') value = Buffer.from(value);
  const padding = Buffer.from(padder.repeat(size - value.length));
  value = Buffer.concat([ value, padding ]);
  fs.write(fd, value, 0, value.length, position, cb);
}

function discoverPlaceholders (binaryBuffer) {
  return {
    BAKERY: discoverPlaceholder(binaryBuffer, '\0' + '// BAKERY '.repeat(20), '\0')
  };
}

function injectPlaceholders (fd, placeholders, values, cb) {
  injectPlaceholder(fd, placeholders.BAKERY, values.BAKERY, cb);
}

function makeBakeryValueFromBakes (bakes) {
  const parts = [];
  if (bakes.length) {
    for (let i = 0; i < bakes.length; i += 1) {
      parts.push(Buffer.from(bakes[i]));
      parts.push(Buffer.alloc(1));
    }
    parts.push(Buffer.alloc(1));
  }
  return Buffer.concat(parts);
}

function replaceDollarWise (s, sf, st) {
  return s.replace(sf, () => st);
}

function makePreludeBufferFromPrelude (prelude) {
  return Buffer.from(
    '(function(process, require, console, EXECPATH_FD, PAYLOAD_POSITION, PAYLOAD_SIZE) { ' +
      prelude +
    '\n})' // dont remove \n
  );
}

export default function ({ backpack, bakes, slash, target }) {
  return new Promise((resolve, reject) => {
    if (!Buffer.alloc) {
      throw wasReported('Your node.js does not have Buffer.alloc. Please upgrade!');
    }

    let { prelude, entrypoint, stripes } = backpack;
    entrypoint = snapshotify(entrypoint, slash);
    stripes = stripes.slice();

    const vfs = {};
    for (const stripe of stripes) {
      let { snap } = stripe;
      snap = snapshotify(snap, slash);
      if (!vfs[snap]) vfs[snap] = {};
    }

    let meter;
    let count = 0;

    function pipeToNewMeter (s) {
      meter = streamMeter();
      return s.pipe(meter);
    }

    function next (s) {
      count += 1;
      return pipeToNewMeter(s);
    }

    const binaryBuffer = fs.readFileSync(target.binaryPath);
    const placeholders = discoverPlaceholders(binaryBuffer);
    const sizes = Buffer.alloc(12);
    const binary = path.join(path.dirname(target.output), path.basename(target.output, path.extname(target.output)) + '.bin');

    let track = 0;
    let prevStripe;

    let payloadPosition;
    let payloadSize;
    let preludePosition;
    let preludeSize;

    multistream((cb) => {
      if (count === 0) {
        return cb(undefined, next(
          bufferStream(sizes)
        ));
      } else
      if (count === 1) {
        payloadPosition = meter.bytes;
        return cb(undefined, next(
          bufferStream(Buffer.alloc(0))
        ));
      } else
      if (count === 2) {
        if (prevStripe && !prevStripe.skip) {
          let { snap, store } = prevStripe;
          snap = snapshotify(snap, slash);
          vfs[snap][store] = [ track, meter.bytes ];
          track += meter.bytes;
        }

        if (stripes.length) {
          // clone to prevent 'skip' propagate
          // to other targets, since same stripe
          // is used for several targets
          const stripe = Object.assign({}, stripes.shift());
          prevStripe = stripe;

          if (stripe.buffer) {
            if (stripe.store === STORE_BLOB) {
              const snap = snapshotify(stripe.snap, slash);
              return fabricateTwice(bakes, target.fabricator, snap, stripe.buffer, (error, buffer) => {
                if (error) {
                  log.warn(error.message);
                  stripe.skip = true;
                  return cb(undefined, bufferStream(Buffer.alloc(0)));
                }

                cb(undefined, pipeToNewMeter(bufferStream(buffer)));
              });
            } else {
              return cb(undefined, pipeToNewMeter(bufferStream(stripe.buffer)));
            }
          } else
          if (stripe.file) {
            if (stripe.file === target.output) {
              return cb(wasReported(
                'Trying to take executable into executable', stripe.file
              ));
            }

            assert.equal(stripe.store, STORE_CONTENT); // others must be buffers from walker
            return cb(undefined, pipeToNewMeter(fs.createReadStream(stripe.file)));
          } else {
            assert(false, 'producer: bad stripe');
          }
        } else {
          payloadSize = track;
          preludePosition = payloadPosition + payloadSize;
          return cb(undefined, next(
            bufferStream(makePreludeBufferFromPrelude(
              replaceDollarWise(
              replaceDollarWise(prelude, '%VIRTUAL_FILESYSTEM%', JSON.stringify(vfs)),
                                         '%DEFAULT_ENTRYPOINT%', JSON.stringify(entrypoint))
            ))
          ));
        }
      } else {
        return cb();
      }
    }).on('error', (error) => {
      reject(error);
    }).pipe(
      fs.createWriteStream(binary)
    ).on('error', (error) => {
      reject(error);
    }).on('close', () => {
      preludeSize = meter.bytes;
      fs.writeFileSync(target.output, binaryBuffer);
      fs.open(target.output, 'r+', (error, fd) => {
        if (error) return reject(error);
        injectPlaceholders(fd, placeholders, {
          BAKERY: makeBakeryValueFromBakes(bakes),
        }, (error2) => {
          if (error2) return reject(error2);
          fs.close(fd, (error3) => {
            if (error3) return reject(error3);
            fs.open(binary, 'r+', (error4, fdb) => {
              if (error4) return reject(error4);
              sizes.writeInt32BE(payloadSize, 0);
              sizes.writeInt32BE(preludePosition, 4);
              sizes.writeInt32BE(preludeSize, 8);
              console.log(sizes);
              fs.write(fdb, sizes, 0, 12, 0, error5 => {
                if (error5) return reject(error5);
                fs.close(fdb, error6 => {
                  if (error6) return reject(error6);
                  resolve();
                })
              })
            })
          });
        });
      });
    });
  });
}
