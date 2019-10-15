// Copyright (c) 2019, The TurtleCoin Developers
//
// Please see the included LICENSE file for more information.

'use strict'

process.env.NODE_ENV = process.env.NODE_ENV || 'production'

require('colors')
const DNS = require('dns')
require('dotenv').config()
const IPFS = require('ipfs')
const Metronome = require('node-metronome')
const os = require('os')
const path = require('path')
const util = require('util')

const ipfsRepoPath = process.env.IPFS_REPO_PATH || path.join(os.homedir(), '/TurtleCoinIPFS')
const checkpointsHostname = process.env.CHECKPOINTS_HOSTNAME || 'checkpoints.turtlecoin.dev'
const testMinutes = process.env.TEST_MAXIMUM_MINUTES || 15
const args = process.argv.slice(2)
const isTesting = (args.indexOf('test') !== -1)

class Logger {
  static debug (message) {
    Logger.doLog(util.format('[DEBUG] %s', message).cyan)
  }

  static doLog (message) {
    console.log(util.format('%s: %s', (new Date()).toUTCString(), message))
  }

  static error (message) {
    Logger.doLog(util.format('[ERROR] %s', message).red)
  }

  static info (message) {
    Logger.doLog(util.format('[INFO] %s', message).green)
  }

  static warn (message) {
    Logger.doLog(util.format('[WARN] %s', message).yellow)
  }
}

(async function () {
  if (isTesting) Logger.debug('Starting test run...')

  Logger.info(util.format('Starting IPFS node in: %s', ipfsRepoPath))

  /* Create the IPFS node */
  const node = await IPFS.create({
    silent: true,
    repo: path.resolve(ipfsRepoPath),
    relay: {
      enabled: true,
      hop: {
        enabled: true,
        active: true
      }
    },
    libp2p: {
      config: {
        dht: {
          enabled: true
        }
      }
    }
  })

  Logger.info('IPFS node started')

  /* This is a helper method that creates a promises
     that does not resolve until we are connected to the swarm */
  function isReady () {
    return new Promise((resolve, reject) => {
      function check () {
        node.swarm.peers((err, peers) => {
          if (err) {
            setTimeout(check, 1000 * 5)
          } else if (peers.length === 0) {
            setTimeout(check, 1000 * 5)
          } else {
            return resolve()
          }
        })
      }
      check()
    })
  }

  Logger.info('Waiting for IPFS node to connect to swarm...')

  await isReady()

  var lastIPFSHash

  node.on('error', error => Logger.error(error.toString()))

  Logger.info('IPFS node connected to swarm...')

  /* Helper method to get the latest IPFS checkpoints hash from DNS */
  function getLatestCheckpointsIPFSHash () {
    return new Promise((resolve, reject) => {
      DNS.resolveTxt(util.format('_dnslink.%s', checkpointsHostname), (err, records) => {
        if (err) {
          return reject(new Error(util.format('Error querying DNS for: %s: %s', checkpointsHostname, err.toString())))
        } else if (records.length === 0 || records[0].length === 0) {
          return reject(new Error(util.format('Could not retieve the latest checkpoints IPFS hash from: %s', checkpointsHostname)))
        } else {
          const record = records[0][0]
          const hash = record.split('/').pop()
          return resolve(hash)
        }
      })
    })
  }

  /* Helper method that clears all old pins but the current
     checkpoints hash object */
  function cleanPins (hashToSave) {
    return new Promise((resolve, reject) => {
      function unpin (hash) {
        return new Promise((resolve, reject) => {
          node.pin.rm(hash, (err, pinset) => {
            if (err) return reject(err)
            return resolve(hash)
          })
        })
      }

      node.pin.ls((err, pinset) => {
        if (err) return reject(err)

        const promises = []
        const removedPins = []

        pinset.forEach((pin) => {
          if (pin.hash === hashToSave) return
          if (pin.type === 'indirect') return
          removedPins.push(pin.hash)
          promises.push(unpin(pin.hash))
        })

        Promise.all(promises).then(() => {
          return resolve(removedPins)
        }).catch((error) => {
          return reject(error)
        })
      })
    })
  }

  /* Timer to tick every 60 mins */
  const timer = new Metronome(1000 * 60 * 60, true)

  /* At every interval, check to see if the hash has been
     updated in DNS, and if so, let's try to pin it locally */
  timer.on('tick', () => {
    var newHash
    getLatestCheckpointsIPFSHash().then((hash) => {
      newHash = hash
      const promises = []

      if (hash !== lastIPFSHash) {
        Logger.info(util.format('Detected new checkpoints IPFS hash: %s', hash))
        lastIPFSHash = hash
        Logger.info(util.format('Attempting to pin locally: %s', hash))
        promises.push(node.pin.add(hash))
      }

      /* If we are testing, then we need to throw some output
         to the screen while we wait for the hash to pin otherwise
         most of the CI packages will timeout */
      if (isTesting) {
        const testPingTimer = new Metronome(1000 * 30, true)
        testPingTimer.on('tick', () => {
          Logger.debug(util.format('Waiting for pin of: %s', hash))
        })
      }

      return Promise.all(promises)
    }).then((results) => {
      if (results.length === 1) {
        Logger.info(util.format('Pinned successfully: %s', newHash))
        if (isTesting) {
          Logger.debug('Test completed. Stopping...')
          process.exit(0)
        }
      }

      return cleanPins(lastIPFSHash)
    }).then((pins) => {
      pins.forEach((hash) => {
        Logger.warn(util.format('Unpinned hash: %s', hash))
      })
    }).catch(error => Logger.warn(error.toString()))
  })

  /* Tick right away so that we don't have to wait */
  timer.tick()

  if (isTesting) {
    setTimeout(() => {
      Logger.error(util.format('Could not pin %s within test period. Check your Internet connection and try again. Cancelling test...', lastIPFSHash))
      process.exit(0)
    }, 1000 * 60 * testMinutes)
  }
})()
