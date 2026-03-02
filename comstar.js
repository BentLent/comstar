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

process.removeAllListeners('warning')

import { createSwarm, generateSecureRandomString } from './core-module-hyperswarm.js';
import { program } from 'commander';
import { createHash } from 'node:crypto';

import { topicCode, encodingBase } from './directory-module.js';

// import { callRender } from './tui-ink-module.js';

let invokedCommand = null;
let topicArg;  // will hold the topic from `host`
let lobbyArg;  // will hold the lobby from `join`
let isServer;

program
  .description('Simple UDP relay server for one-to-many packet transmission')
  .option('--host <host>', 'interface to bind to', '127.0.0.1')
  .option('-p, --port <port>', 'port to listen on', 1337)
  // .option('-s, --switch', 'behave like network switch (fwd only to dest mac)', false)
  .option('-v, --verbose', 'enable verbose log output', false);

program
  .command('host [topic]')
  .description('host a lobby on an optional topic')
  .action(function (topic) {
	invokedCommand = this.name(); // "host"
    topicArg = topic; // store in variable
	isServer = true;
  });

program
  .command('join <lobby>')
  .description('join a lobby on a particular lobby code')
  .action(function (lobby) {
	invokedCommand = this.name(); // "join"
    lobbyArg = lobby; // store in variable
	isServer = false;
  });

let isInteractive = false;
let args;
// Check if no arguments other than the node executable and script name are provided
if (process.argv.length <= 2) {
  isInteractive = process.stdout.isTTY
} else {
  program.parse(process.argv);
  args = program.opts();
}

if (isInteractive) {
	//console.clear()
  //callRender()
  program.help();
  process.exit(1);
} else {
  const log = (...msg) => console.log(...msg);
  const debug = (...msg) => { if (args.verbose) console.debug(...msg); };
  
  if (!invokedCommand) {
    console.error('Error: You must specify either "host" or "join" in non-interactive mode.');
    process.exit(1);
  }

  if (topicArg && lobbyArg) {
    console.error('Error: You cannot specify both "host" and "join" at the same time.');
    process.exit(1);
  }

  let topic = null;
  let roomCode = null;
  if (isServer) {
	  let pretopic = null;
	  if (topicArg === undefined) {
		  pretopic = createHash('sha256').update(generateSecureRandomString(32)).digest()
	  } else {
		  pretopic = createHash('sha256').update(topicArg).digest()
	  }
	  console.clear()
	  // Generate room code from pretopic
	  roomCode = topicCode(pretopic)
	  topic = createHash('sha256').update(`p2p-xemu-room-${roomCode}`).digest()
	  console.log(`Hosting with Room Code: ${roomCode}`);
  } else if (!isServer) {
	  var validCode = false
	  while (!validCode) {
		  console.clear()
		  if (lobbyArg === undefined) {
			  console.error('Error: You must specify a lobby code with "join" in non-interactive mode.');
			  process.exit(1);
		  }
		  var decoded = encodingBase.decode(lobbyArg)
		  if (decoded.length > 0) {
			  console.log(`Joining as client with Room Code: ${lobbyArg}`);
			  roomCode = lobbyArg;
			  topic = createHash('sha256').update(`p2p-xemu-room-${roomCode}`).digest()
			  validCode = true;
		  } else {
			  console.log(`Oops! That wasn't a valid Room Code! Please try again.`);
			  continue;
		  }
	  }
  } else {
      console.error('Error: You must specify either "host" or "join" in non-interactive mode.');
	  process.exit(1);
  }
  
  const swarm = createSwarm(isServer, topic, args.port, args.host, args.switch);
  swarm.on('log', log);
  swarm.on('debug', debug)
  swarm.on('peer-joined', p => log(`Peer joined: ${p}`));
  swarm.on('peer-dropped', p => log(`Peer dropped: ${p}`));
}
