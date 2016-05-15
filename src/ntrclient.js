import { connect } from 'net';
import PullStream from 'pullstream';
import Promise from 'bluebird';

PullStream.prototype.pullAsync = Promise.promisify(PullStream.prototype.pull);

export class NtrClient {
  seqNumber = 0;
  canSendHeartbeat = true;
  promises = {};

  constructor(ip, connectedCallback, disconnectedCallback) {
    this.sock = connect(8000, ip, () => {
      this.sock.setNoDelay(true);
      this.sock.setKeepAlive(true);
      if (typeof connectedCallback === 'function') {
        connectedCallback();
      }
    });
    if (typeof disconnectedCallback === 'function') {
      this.sock.on('close', disconnectedCallback);
    }

    this.stream = new PullStream();
    this.sock.pipe(this.stream);

    this.handleData();
  }

  disconnect() {
    this.sock.end();
  }

  // Receiving stuff

  async handleData() {
    const cmdBuf = await this.stream.pullAsync(84);

    const magic = cmdBuf.readUInt32LE(0);
    const seq = cmdBuf.readUInt32LE(4);
    const type = cmdBuf.readUInt32LE(8);
    const cmd = cmdBuf.readUInt32LE(12);
    const args = new Uint32Array(cmdBuf.buffer, cmdBuf.byteOffset + 16, 16);
    const dataLen = cmdBuf.readUInt32LE(80);

    if (magic != 0x12345678) {
      return;
    }

    if (dataLen !== 0) {
      const data = await this.stream.pullAsync(dataLen);
      this.handlePacket(cmd, seq, data);
    } else {
      this.handlePacket(cmd, seq, undefined);
    }

    this.canSendHeartbeat = 1; // TODO only do this as response to heartbeats
    this.handleData();
  }

  handlePacket(cmd, seq, data) {
    if (data !== undefined) {
      console.log(`Received cmd ${cmd} with data:`);
      console.log(data.toString());
    } else {
      console.log(`Received cmd ${cmd} without data`);
    }
  }

  // Sending stuff

  sendPacket(type, cmd, args = [], dataLen) {
    this.seqNumber += 1000;

    const buf = new Buffer(84);
    buf.writeUInt32LE(0x12345678, 0);
    buf.writeUInt32LE(this.seqNumber, 4);
    buf.writeUInt32LE(type, 8);
    buf.writeUInt32LE(cmd, 12);
    for (let i = 0; i < Math.min(16, args.length); ++i) {
      buf.writeUInt32LE(args[i], 4 * (4 + i));
    }
    buf.writeUInt32LE(dataLen, 20);
    this.sock.write(buf);
  }

  saveFile(name, data) {
    const nameBuffer = Buffer.alloc(200);
    nameBuffer.write(name);
    this.sendPacket(1,1, undefined, 200 + data.byetLength);
    this.sock.write(nameBuffer);
    this.sock.write(data);
  }

  reload() {
    this.sendPacket(0, 4, undefined, 0);
  }

  hello() {
    this.sendPacket(0, 3, undefined, 0);
  }

  heartbeat() {
    if (this.canSendHeartbeat) {
      this.canSendHeartbeat = false;
      this.sendPacket(0, 0, undefined, 0);

      // TODO return
    }
  }

  writeMemory(addr, pid, buf) {
    this.sendPacket(1, 10, [pid, addr, buf.byteLength], buf.byteLength);
    this.sock.write(buf);
  }

  readMemory(addr, size, pid) {
    this.sendPacket(0, 9, [pid, addr, size], 0);
    // TODO figure out return handling here
  }

  addBreakpoint(addr, type) {
    if (type === 'always') {
      this.sendPacket(0, 11, [1, addr, 1], 0);
    } else if (type === 'once') {
      this.sendPacket(0, 11, [2, addr, 1], 0);
    }
  }

  disBreakpoint(id) { // TODO what does this do?
    this.sendPacket(0, 11, [id, 0, 3], 0);
  }

  enaBreakpoint(id) { // TODO what does this do?
    this.sendPacket(0, 11, [id, 0, 2], 0);
  }

  resume() {
    this.sendPacket(0, 11, [0, 0, 4], 0);
  }

  listProcesses() {
    this.sendPacket(0, 5, undefined, 0);
    // TODO figure out return
  }

  listThreads(pid) {
    this.sendPacket(0, 7, [pid], 0);
    // TODO return
  }

  attachToProcess(pid, patchAddr = 0) {
    this.sendPacket(0, 6, [pid, patchAddr], 0);
  }

  queryHandle(pid) {
    this.sendPacket(0, 12, [pid], 0);
    // TODO return
  }

  getMemlayout(pid) {
    this.sendPacket(0, 8, [pid], 0);
    // TODO return
  }
}

export default function connectNTR(ip, disconnectedCallback) {
  return new Promise((resolve) => {
    const client = new NtrClient(ip, () => {
      resolve(client);
    }, disconnectedCallback);
  });
}
