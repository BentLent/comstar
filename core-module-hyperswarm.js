/*
Copyright (C) 2026 Trenton "Raz" Robichaux

This program is free software; you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation; either version 2 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License along
with this program; if not, write to the Free Software Foundation, Inc.,
51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA.
*/

import dgram from 'dgram'
import crypto from 'crypto'
import EventEmitter from 'events'

import Hyperswarm from 'hyperswarm'

const broadcast_mac = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff]
const fmt_mac = (o) => o.map(b => b.toString(16).padStart(2, '0')).join(':')

function arraysEqual(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// Normalise a topic to a 32-byte Buffer (accepts Buffer, Uint8Array or string)
function normaliseTopic(topic) {
  if (Buffer.isBuffer(topic) && topic.length === 32) return topic
  if (topic instanceof Uint8Array && topic.length === 32) return Buffer.from(topic)
  // Hash arbitrary strings / short buffers down to 32 bytes
  return crypto.createHash('sha256').update(topic).digest()
}

// --------------------------------------------------------------------------
// Core: start UDP hub + Hyperswarm room
// --------------------------------------------------------------------------
async function startUdpHub(isServer, topic, emitter, port, host, isSwitch) {
  const sock = dgram.createSocket('udp4')
  sock.bind(port, host, () => {
    emitter.emit('log', `Waiting for UDP packets on ${host}:${port}`)
  })

  // peers: peerKey (hex) -> { conn }
  const peers = new Map()
  // MAC learning: mac string -> conn
  const macs = new Map()

  // Track last UDP sender so we know where to forward inbound swarm packets
  let lastUdpSender = null

  // -------------------------------------------------------------------------
  // Hyperswarm setup
  // -------------------------------------------------------------------------
  const swarm = new Hyperswarm()
  const topicBuf = normaliseTopic(topic)

  swarm.on('connection', (conn, info) => {
    const peerKey = info.publicKey.toString('hex')

    if (!peers.has(peerKey)) {
      peers.set(peerKey, { conn })
      emitter.emit('peer-joined', peerKey)
      emitter.emit('debug', `Connected to peer: ${peerKey}`)
    } else {
      // Replace stale connection
      peers.set(peerKey, { conn })
    }

    // ---------- receive frames from this peer ----------
    conn.on('data', (data) => {
      emitter.emit('debug', `Received ${data.length} bytes from ${peerKey}`)
      if (data.length < 12) {
        emitter.emit('debug', 'Packet smaller than expected; dropping packet')
        return
      }

      const src_mac = Array.from(data.subarray(6, 12))
      const srcKey  = fmt_mac(src_mac)

      if (!macs.has(srcKey)) {
        emitter.emit('debug', `Learned swarm MAC ${srcKey}`)
      }
      macs.set(srcKey, conn)

      if (lastUdpSender) {
        const { address, port: p } = lastUdpSender
        emitter.emit('debug', `${address}:${p}`)
        sendToClient(data, `${address}:${p}`, sock, emitter)
      }
    })

    conn.on('close', () => {
      if (peers.get(peerKey)?.conn === conn) {
        peers.delete(peerKey)
        emitter.emit('peer-dropped', peerKey)
        emitter.emit('debug', `Peer disconnected: ${peerKey}`)
      }
      // Clean up MAC entries pointing at this connection
      for (const [mac, c] of macs.entries()) {
        if (c === conn) macs.delete(mac)
      }
    })

    conn.on('error', (err) => {
      emitter.emit('debug', `Peer connection error (${peerKey}): ${err.message}`)
    })
  })

  // Join the topic as server, client, or both
  const discovery = swarm.join(topicBuf, {
    server: isServer,
    client: !isServer
  })

  if (isServer) {
    await discovery.flushed()
    emitter.emit('debug', `Announced to DHT on topic: ${topicBuf.toString('hex')}`)
  } else {
    await swarm.flush()
    emitter.emit('debug', `Joined topic as client: ${topicBuf.toString('hex')}`)
  }

  // -------------------------------------------------------------------------
  // UDP → swarm forwarding
  // -------------------------------------------------------------------------
  sock.on('message', (data, rinfo) => {
    emitter.emit('debug', `Received ${data.length} bytes from ${rinfo.address}:${rinfo.port}`)
    if (data.length < 12) return

    lastUdpSender = { address: rinfo.address, port: rinfo.port }
    emitter.emit('debug', rinfo)

    const dest_mac = Array.from(data.subarray(0, 6))
    const src_mac  = Array.from(data.subarray(6, 12))
    const fmt_src  = fmt_mac(src_mac)
    const fmt_dest = fmt_mac(dest_mac)
    emitter.emit('debug', `${fmt_src} -> ${fmt_dest}`)

    if (!macs.has(fmt_src)) {
      emitter.emit('debug', `Learned MAC ${fmt_src}`)
    }

    let forwardedCount = 0

    if (isSwitch && !arraysEqual(dest_mac, broadcast_mac)) {
      // Switch behaviour: unicast to learned destination, else flood
      const destConn = macs.get(fmt_dest)
      if (!destConn) {
        emitter.emit('debug', 'Unknown destination')
        for (const { conn } of peers.values()) {
          sendToPeer(data, conn, emitter)
          forwardedCount++
        }
      } else {
        sendToPeer(data, destConn, emitter)
        forwardedCount++
      }
    } else {
      // Hub behaviour: flood to all peers
      for (const [pid, { conn }] of peers.entries()) {
        emitter.emit('debug', pid)
        sendToPeer(data, conn, emitter)
        forwardedCount++
      }
    }

    emitter.emit('debug', `Forwarded to ${forwardedCount} peers`)
  })

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------
  async function destroy() {
    try { sock.close() } catch {}
    for (const { conn } of peers.values()) {
      try { conn.destroy() } catch {}
    }
    peers.clear()
    try { await swarm.destroy() } catch {}
  }

  return { sock, swarm, destroy }
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------
function sendToPeer(data, conn, emitter) {
  try {
    conn.write(Buffer.from(data))
  } catch (err) {
    emitter.emit('debug', `Error sending to peer: ${err.message}`)
  }
}

function sendToClient(data, addrKey, socket, emitter) {
  const [address, portStr] = addrKey.split(':')
  const port = Number(portStr)
  try {
    emitter.emit('debug', `Sending ${data.length} bytes to ${address}:${port}`)
    socket.send(data, port, address)
  } catch (err) {
    emitter.emit('debug', `Error sending to client: ${err.message}`)
  }
}

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------
export function createSwarm(isServer, topic, port, host, isSwitch) {
  const emitter = new EventEmitter()
  let resources

  ;(async () => {
    resources = await startUdpHub(isServer, topic, emitter, port, host, isSwitch)
  })().catch(err => {
    emitter.emit('debug', `Failed to start swarm: ${err?.message || err}`)
  })

  emitter.destroy = async () => {
    emitter.removeAllListeners()
    if (resources?.destroy) {
      try { await resources.destroy() } catch {}
    }
  }

  return emitter
}

export function generateSecureRandomString(length) {
  const bytesLength = Math.ceil(length / 2)
  return crypto.randomBytes(bytesLength).toString('hex').slice(0, length)
}