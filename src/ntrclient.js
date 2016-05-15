import { connect } from 'net';
import PullStream from 'pullstream';

class NtrClient {
  seqNumber = 0;
  canSendHeartbeat = true;

  constructor(ip, connectedCallback, disconnectedCallback) {
    this.sock = connect(5000, ip, connectedCallback);
    this.sock.setNoDelay(true);
    this.sock.on('close', disconnectedCallback);

    this.stream = new PullStream();
    this.sock.pipe(this.stream);

    this.stream.pull(84, this.handleData);
  }

  disconnect() {
    this.sock.end();
  }

  // Receiving stuff

  handleData = (err, data) => {
    if (err) {
      return;
    }

    const magic = data.readUInt32LE(0);
    const seq = data.readUInt32LE(4);
    const type = data.readUInt32LE(8);
    const cmd = data.readUInt32LE(12);
    const args = new Uint32Array(data.buffer, data.byteOffset + 16, 16);
    const dataLen = data.readUInt32LE(80);

    if (magic != 0x12345678) {
      return;
    }

    if (dataLen !== 0) {
      this.stream.pull(dataLen, (err, data) => {
        this.stream.pull(84, this.handleData);

        if (!err) {
          this.handlePacket(cmd, seq, data);
        }
      });
    } else {
      this.stream.pull(84, this.handleData);
      this.handlePacket(cmd, seq, undefined);
    }

    this.canSendHeartbeat = 1;
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

    const buf = new Uint32Array(21);
    buf[0] = 0x12345678;
    buf[1] = seqNumber;
    buf[2] = type;
    buf[3] = cmd;
    for (let i = 0; i < Math.min(16, args.length); ++i) {
      buf[4 + i] = args[i];
    }
    buf[20] = dataLen;
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

  attachToProcess(pid, patchAddr = 0) {
    this.sendPacket(0, 6, [pid, patchAddr], 0);
  }

  queryHandle(pid) {
    this.sendPacket(0, 12, [pid], 0);
    // TODO return
  }

  getMemlayout(pid) {
    this.sendPacket(0, 8, [pid], 0);
  }
}

export default function connect(ip, disconnectedCallback) {
  return new Promise((resolve) => {
    const client = new NtrClient(ip, () => {
      resolve(client);
    }, disconnectedCallback);
  });
}
