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

// import Hyperswarm from 'hyperswarm';
import crypto from 'crypto';
import basex from 'base-x';

// const DIRECTORY_NAMESPACE = 'p2p-xemu-room-directory-v2';
// const DIRECTORY_TOPIC = crypto.createHash('sha256').update(DIRECTORY_NAMESPACE).digest().subarray(0, 32);

const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
export const encodingBase = basex(ALPHA)

// const HEARTBEAT_MS = 15_000;
// const ENTRY_EXPIRY_MS = 60_000;
// const SYNC_LIMIT = 500;

function toHex(buf) { return Buffer.from(buf).toString('hex'); }
function fromHex(hex) { return Buffer.from(hex, 'hex'); }

let verbose = false

const debug = (...msg) => { if (verbose) console.debug(...msg); };

export function topicCode(topicBuf, prefix = '', chars = 6) {
  const bitsPerChar = Math.log2(ALPHA.length);
  const bytesNeeded = Math.ceil((chars * bitsPerChar) / 8);

  const digest = crypto.createHash('sha256').update(topicBuf).digest();
  const truncated = digest.subarray(0, bytesNeeded);

  return prefix + encodingBase.encode(truncated);
}


// !!! DEAD CODE BELOW - Kept for Reference !!! //
// -------------------------------------------- //

/* function createLineCodec(socket, onMessage) {
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    let idx;
    while ((idx = buf.indexOf(0x0a)) !== -1) {
      const line = buf.subarray(0, idx).toString('utf8').replace(/\r$/, '');
      buf = buf.subarray(idx + 1);
      if (!line) continue;
      try { onMessage(JSON.parse(line)); } catch {}
    }
  });
  return {
    send(obj) { socket.write(JSON.stringify(obj) + '\n'); }
  };
} */

/* export class ServerWithDirectory {
  constructor(topicHex) {
    this.swarm = new Hyperswarm();
    this.topic = topicHex ? fromHex(topicHex) : crypto.randomBytes(32);
    this.topicHex = toHex(this.topic);
    this.roomCode = topicCode(this.topic);
    this.map = new Map(); // roomCode -> {topicHex, lastSeen}

    this._addOrUpdate(this.roomCode, this.topicHex);

    this._setup();
  }

  _setup() {

    // Join directory topic to gossip with other servers & answer client queries
    this.swarm.join(DIRECTORY_TOPIC, { server: true, client: true });

    this.swarm.on('connection', (socket, info) => {
	  socket.on('error', e => debug(`Connection error: ${e}`))
	  socket.on('close', e => debug(`Connection closed: ${e}`))
      const codec = createLineCodec(socket, (msg) => this._onMessage(msg, codec));
      // Send our own announce immediately
      this._sendAnnounce(codec);
      // Send sync of known mappings
      this._sendSync(codec);
    });

    // Heartbeat
    setInterval(() => { 
	    this._broadcastAnnounce()
	}, HEARTBEAT_MS).unref();
    // Cull stale entries
    setInterval(() => this._cull(), 10_000).unref();

    debug('Server topic:', this.topicHex);
    debug('Room code:', this.roomCode);
  }

  _onMessage(msg, codec) {
    switch (msg?.type) {
      case 'announce':
        this._addOrUpdate(msg.roomCode, msg.topicHex);
        break;
      case 'query': {
        const entry = this.map.get(msg.roomCode);
        if (entry && Date.now() - entry.lastSeen < ENTRY_EXPIRY_MS) {
          codec.send({ type: 'response', roomCode: msg.roomCode, topicHex: entry.topicHex, found: true });
        } else {
          codec.send({ type: 'response', roomCode: msg.roomCode, found: false });
        }
        break;
      }
      case 'sync':
        if (Array.isArray(msg.entries)) {
          msg.entries.forEach(e => this._addOrUpdate(e.roomCode, e.topicHex, e.lastSeen));
        }
        break;
    }
  }

  _addOrUpdate(roomCode, topicHex, lastSeen = Date.now()) {
    if (!roomCode || !topicHex) return;
    this.map.set(roomCode, { topicHex, lastSeen })
  }

  _sendAnnounce(codec) {
    codec.send({ type: 'announce', roomCode: this.roomCode, topicHex: this.topicHex, lastSeen: Date.now() });
  }

  _sendSync(codec) {
    const entries = [];
    let count = 0;
    for (const [roomCode, val] of this.map) {
      entries.push({ roomCode, topicHex: val.topicHex, lastSeen: val.lastSeen });
      if (++count >= SYNC_LIMIT) break;
    }
    codec.send({ type: 'sync', entries });
  }

  _broadcastAnnounce() {
	this._addOrUpdate(this.roomCode, this.topicHex);
    for (const conn of this.swarm.connections) {
      const codec = createLineCodec(conn, () => {});
      this._sendAnnounce(codec);
    }
  }

  _cull() {
    const now = Date.now();
    for (const [roomCode, val] of this.map) {
      if (now - val.lastSeen > ENTRY_EXPIRY_MS) {
        this.map.delete(roomCode);
      }
    }
  }
}

export class ClientResolver {
  constructor(roomCode) {
    this.roomCode = roomCode;
    this.swarm = new Hyperswarm();
    this._setup();
  }

  _setup() {
    this.swarm.join(DIRECTORY_TOPIC, { server: false, client: true });
    this.swarm.on('connection', (socket, info) => {
	  socket.on('error', e => debug(`Connection error: ${e}`))
	  socket.on('close', e => debug(`Connection closed: ${e}`))
      const codec = createLineCodec(socket, (msg) => {
        if (msg?.type === 'response' && msg.roomCode === this.roomCode) {
          if (msg.found) {
            debug(`Resolved ${this.roomCode}`);
          } else {
            debug(`Code ${this.roomCode} not found here`);
          }
        }
      });
      codec.send({ type: 'query', roomCode: this.roomCode });
    });
  }
} */

// module.exports = { ServerWithDirectory, ClientResolver, topicCode }