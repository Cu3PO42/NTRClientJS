import { connect } from 'net';
import PullStream from 'pullstream';
import Promise from 'bluebird';

PullStream.prototype.pullAsync = Promise.promisify(PullStream.prototype.pull);

export class NtrClient {
  seqNumber = 1000;
  canSendHeartbeat = true;
  promises = {};

  constructor(ip, connectedCallback, disconnectedCallback) {
    this.sock = connect(8000, ip, () => {
      this.sock.setNoDelay(true);
      this.sock.setKeepAlive(true);

      this.heartbeatId = setInterval(this.heartbeat.bind(this), 1000);

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
    clearInterval(this.heartbeatId);
    this.sock.end();
  }

  // Receiving stuff

  async handleData() {
    try {
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

      this.handleData();
    } catch(e) {
      this.disconnect();
    }
  }

  handlePacket(cmd, seq, data) {
    switch (cmd) {
      case 0:
        this.canSendHeartbeat = true;
        const lines = data.toString().match(/^.+$/gm);
        const { type } = this.promises[seq];
        switch(type) {
          case 'processes':
            this.handleProcesses(seq, lines);
            break;
          case 'threads':
            this.handleThreads(seq, lines);
            break;
          case 'memlayout':
            this.handleMemlayout(seq, lines);
            break;
          case 'handle':
            this.handleHandles(seq, lines);
            break;
          default:
            this.promises[seq].reject(new Error('Unexpected message type.'));
            break;
        }
        break;

        if (lines[0] === 'valid memregions' && lines[lines.length - 1]) {
          this.handleMemlayout(seq, lines);
        } else if (lines[0].startsWith('tid: ')) {
          this.handleThreads(seq, lines);
        } else if (lines[lines.length - 1] === 'done') {

        }
    }

    if (this.promises[seq] !== undefined) {
      delete this.promises[seq];
    }

    if (data !== undefined) {
      console.log(`Received cmd ${cmd} at seq ${seq} with data:`);
      console.log(data.toString());
    } else {
      //console.log(`Received cmd ${cmd} at seq ${seq} without data`);
    }
  }

  handleProcesses(seq, lines) {
    const { resolve, reject } = this.promises[seq];
    if (lines[lines.length - 1] !== 'end of process list.') {
      reject(new Error('Unexpected reply for process list.'));
      return;
    }

    const processes = lines.slice(0, -1);
    try {
      resolve(processes.map(proc => {
        const m = proc.match(/^pid: 0x([\da-f]{8}), pname: *(\w+), tid: ([\da-f]{16}), kpobj: ([\da-f]{8})$/);

        if (m === null) {
          throw new Error('Response does not match expected format for process list.');
        }

        return {
          pid: parseInt(m[1], 16),
          name: m[2],
          tid: parseInt(m[3], 16)
          kpobj: parseInt(m[4], 16)
        };
      }));
    } catch(e) {
      reject(e);
    }
  }

  handleThreads(seq, lines) {
    const { resolve, reject } = this.promises[seq];
    const res = {
      threads: [],
      recommendedPc: [],
      recommendedLr: []
    };

    try {
      let i;
      for (i = 0; lines[i].startsWith('tid: '); i += 3) {
        const tid = parseInt(lines[i].match(/^tid: 0x([\da-f]{8})$/)[1], 16);
        const m = lines[i + 1].match(/^pc: ([\da-f]{8}), lr: ([\da-f]{8})$/);
        if (Number.isNaN(tid)) {
          throw null;
        }
        const pc = parseInt(m[1], 16);
        const lr = parseInt(m[2], 16);
        const data = lines[i + 1].split(' ');
        const dataBuf = Buffer.alloc(128);
        for (let j = 0; j < 32; ++j) {
          const val = parseInt(data[j], 16);
          if (Number.isNaN(val)) {
            throw null;
          }
          dataBuf.writeUInt32LE(val, j * 4);
        }
        res.threads.push({ tid, pc, lr, data: dataBuf });
      }

      if (lines[i++] !== 'recommended pc:') {
        throw null;
      }

      for (; /^[\da-f]{8}$/.test(lines[i]); ++i) {
        res.recommendedPc.push(parseInt(lines[i], 16));
      }

      if (lines[i++] !== 'recommended lr:') {
        throw null;
      }

      for (; /^[\da-f]{8}$/.test(lines[i]); ++i) {
        res.recommendedLr.push(parseInt(lines[i], 16));
      }

      if (i < lines.length) {
        throw null;
      }

      resolve(res);
    } catch(e) {
      reject(new Error('Response does not match expected format for thread list.'));
    }
  }

  handleMemlayout(seq, lines) {
    const { resolve, reject } = this.promises[seq];
    try {
      if (lines[0] !== 'valid memregions:' || lines[line.length - 1] !== 'end of memlayout.') {
        throw null;
      }

      const regions = lines.slice(1, -1);
      resolve(regions.map(region => {
        const m = region.match(/^([\da-f]{8}) - ([\da-f]{8}) , size: ([\da-f]{8}))$/);
        const start = parseInt(m[1], 16);
        const end = parseInt(m[2], 16);
        const size = parseInt(m[3], 16);

        return { start, end, size };
      }));
    } catch(e) {
      reject(new Error('Response does not match expected format for memlayout.'));
    }
  }

  // Sending stuff

  sendPacket(type, cmd, args = [], dataLen) {
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

    this.seqNumber += 1000;
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
    }
  }

  writeMemory(addr, pid, buf) {
    this.sendPacket(1, 10, [pid, addr, buf.byteLength], buf.byteLength);
    this.sock.write(buf);
  }

  readMemory(addr, size, pid) {
    this.sendPacket(0, 9, [pid, addr, size], 0);
    const seq = this.seqNumber;
    return new Promise((resolve, reject) => {
      this.promises[seq] = { resolve, reject, type: 'memory' };
    });
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
    const seq = this.seqNumber;
    return new Promise((resolve, reject) => {
      this.promises[seq] = { resolve, reject, type: 'processes' };
    });
  }

  listThreads(pid) {
    this.sendPacket(0, 7, [pid], 0);
    const seq = this.seqNumber;
    return new Promise((resolve, reject) => {
      this.promises[seq] = { resolve, reject, type: 'threads' };
    });
  }

  attachToProcess(pid, patchAddr = 0) {
    this.sendPacket(0, 6, [pid, patchAddr], 0);
  }

  queryHandle(pid) {
    this.sendPacket(0, 12, [pid], 0);
    const seq = this.seqNumber;
    return new Promise((resolve, reject) => {
      this.promises[seq] = { resolve, reject, type: 'handle' };
    });
  }

  getMemlayout(pid) {
    this.sendPacket(0, 8, [pid], 0);
    const seq = this.seqNumber;
    return new Promise((resolve, reject) => {
      this.promises[seq] = { resolve, reject, type: 'memlayout' };
    });
  }
}

export default function connectNTR(ip, disconnectedCallback) {
  return new Promise((resolve) => {
    const client = new NtrClient(ip, () => {
      resolve(client);
    }, disconnectedCallback);
  });
}
