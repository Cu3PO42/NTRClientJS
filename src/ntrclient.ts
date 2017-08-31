import { connect, Socket } from 'net';
import PullStream from 'pullstream';

function promisify(fn) {
  return function(...args) {
    return new Promise(function(resolve, reject) {
      fn(...args, function(err, res) {
        if (err) reject(err);
        else resolve(res);
      });
    });
  }
}

PullStream.prototype.pullAsync = promisify(PullStream.prototype.pull);

/**
 * A descriptor for a process on a device.
 */
export interface ProcessDescriptor {
  /**
   * Process ID.
   */
  pid: number;

  /**
   * Thread ID of (presumably) the main thread of the process.
   */
  tid: number;

  /**
   * Process name on the remote device.
   */
  name: string;

  /**
   * Unknown.
   */
  kpobj: number;
}

/**
 * A descriptor for a thread running on a device.
 */
export interface ThreadDescriptor {
  /**
   * Thread ID.
   */
  tid: number;

  /**
   * Progam counter.
   */
  pc: number;

  /**
   * Link register. Contains the return address of a function.
   */
  lr: number;

  /**
   * Unknown.
   */
  data: Buffer;
}

export interface ThreadListResponse {
  /**
   * List of threads running in the process.
   */
  threads: ThreadDescriptor[];

  /**
   * Unknown.
   */
  recommendedPc: number[];

  /**
   * Unknown.
   */
  recommendedLr: number[];
}

export interface HandleDescriptor {
  /**
   * Unknown.
   */
  h: number;

  /**
   * Unknown.
   */
  p: number;
}

/**
 * This class represents a connection to a 3DS system running the NTR debugger.
 * 
 * It provides methods to execute all supported operations and will keep the connection alive by handdling heartbeats.
 */
export default class NtrClient {

  /**
   * The next sequence number to be used for a package.
   */
  private seqNumber = 1000;

  /**
   * Flag signifying whether we can send heartbeats at this time.
   */
  private canSendHeartbeat = true;

  /**
   * A map of promises for actions that have yet to be resolved through an incoming reply and the expected type of
   * reply.
   */
  private promises: { [id: number]: { resolve(arg?: any), reject(err: Error), type: string } } = {};

  /**
   * The raw socket used for communication with the 3DS.
   */
  private sock: Socket;

  /**
   * The cancellation id for the periodic heartbeat.
   */
  private heartbeatId: number;

  /**
   * The callback to be called when a connection was established.
   */
  private connectedCallback: () => void;

  /**
   * The callback to be called when the connection is closed.
   */
  private disconnectedCallback: (error: boolean) => void;

  /**
   * The raw data stream from the server.
   */
  private stream: PullStream;

  /**
   * Create a new NtrClient. In most cases it is preferable to use [[connectNTR]].
   * 
   * @param ip The IPv4 address of the target device
   * @param connectedCallback  Callback to call once the connection is established
   * @param disconnectedCallback Callback to call when the connection is dropped. Takes a parameter indicating if it
   *                             was due to an error
   */
  public constructor(ip: string, connectedCallback: () => void, disconnectedCallback: (error: boolean) => void) {
    this.sock = connect(8000, ip, () => {
      this.sock.setNoDelay(true);
      this.sock.setKeepAlive(true);

      this.heartbeatId = setInterval(this.heartbeat.bind(this), 1000);
    });

    if (typeof connectedCallback === 'function') {
      this.connectedCallback = connectedCallback;
    }

    if (typeof disconnectedCallback === 'function') {
      this.sock.on('close', disconnectedCallback);
    }
    this.sock.on('end', () => {});

    this.stream = new PullStream();
    this.sock.pipe(this.stream);

    this.handleData();
  }

  /**
   * Disconnect from the device. Any pending actions will not be completed.
   */
  public disconnect() {
    clearInterval(this.heartbeatId);
    this.sock.end();
  }

  /**
   * Create a new [[NtrClient]], wait for the connection to be established and return it as a Promise.
   * 
   * @param ip The IPv4 address of the target device
   * @param disconnectedCallback Callback to call when the connection is dropped. Takes a parameter indicating if it
   *                             was due to an error
   * @return A Promise that resolves to the new [[NtrClient]] when the connection is established
   */
  public static connectNTR(ip: string, disconnectedCallback: (error: boolean) => void) {
    return new Promise((resolve, reject) => {
      let connected = false;
      const client = new NtrClient(ip, () => {
        connected = true;
        resolve(client);
      }, (err) => {
        if (!connected) {
          reject(new Error('Connection could not be established.'));
        }
        if (typeof disconnectedCallback === 'function') {
          disconnectedCallback(err);
        }
      });
    });
  }

  // Receiving stuff

  /**
   * Receive incoming data, verify it download the payload and dispatch it to [[handlePacket]].
   */
  private async handleData() {
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

      if (this.connectedCallback) {
        this.connectedCallback();
        this.connectedCallback = undefined;
      }

      this.handleData();
    } catch(e) {
      this.disconnect();
    }
  }

  /**
   * Handle a command response with optional payload by dispatching it to the correct handler.
   * 
   * @param cmd The id of the command response
   * @param seq The sequence number of the response
   * @param data The response payload
   */
  private handlePacket(cmd: number, seq: number, data?: Buffer) {
    switch (cmd) {
      case 0:
        this.canSendHeartbeat = true;
        if (this.promises[seq] === undefined) {
          break;
        }
        const { type } = this.promises[seq];
        const lines = data !== undefined ? data.toString().match(/^.+$/gm) : [];
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
          case 'hello':
            this.handleHello(seq, lines);
            break;
          case 'memory':
            this.handleReadMemoryText(seq, lines);
            break;
          default:
            this.promises[seq].reject(new Error(`No handler registered for ${type}.`));
            break;
        }
        break;
      case 9:
        this.handleReadMemoryData(seq, data);
        break;
    }

    if (this.promises[seq] !== undefined) {
      delete this.promises[seq];
    }
  }

  /**
   * Handle the response to a requested list of processes.
   * 
   * @param seq The sequence number of the reply
   * @param lines The lines sent as a reply
   */
  private handleProcesses(seq: number, lines: string[]) {
    const { resolve, reject } = this.promises[seq];
    if (lines[lines.length - 1] !== 'end of process list.') {
      reject(new Error('Unexpected reply for process list.'));
      return;
    }

    const processes = lines.slice(0, -1);
    try {
      resolve(processes.map(proc => {
        const m = proc.match(/^pid: 0x([\da-f]{8}), pname: *([^,]+), tid: ([\da-f]{16}), kpobj: ([\da-f]{8})$/);

        if (m === null) {
          console.log(proc);
          throw new Error('Response does not match expected format for process list.');
        }

        return {
          pid: parseInt(m[1], 16),
          name: m[2],
          tid: parseInt(m[3], 16),
          kpobj: parseInt(m[4], 16)
        };
      }));
    } catch(e) {
      reject(e);
    }
  }

  /**
   * Handle the reply to a requested list of threads for a process.
   * 
   * @param seq The sequence number of the reply
   * @param lines The lines sent as a reply
   */
  private handleThreads(seq: number, lines: string[]) {
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
        const data = lines[i + 2].split(' ');
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

      if (lines[i++] !== 'recommend pc:') {
        throw null;
      }

      for (; /^[\da-f]{8}$/.test(lines[i]); ++i) {
        res.recommendedPc.push(parseInt(lines[i], 16));
      }

      if (lines[i++] !== 'recommend lr:') {
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

  /**
   * Handle the reply to a requested list of mapped memory areas of a process.
   * 
   * @param seq The sequence number of the reply
   * @param lines The lines sent as a reply
   */
  private handleMemlayout(seq: number, lines: string[]) {
    const { resolve, reject } = this.promises[seq];
    try {
      if (lines[0] !== 'valid memregions:' || lines[lines.length - 1] !== 'end of memlayout.') {
        throw null;
      }

      const regions = lines.slice(1, -1);
      resolve(regions.map(region => {
        const m = region.match(/^([\da-f]{8}) - ([\da-f]{8}) , size: ([\da-f]{8})$/);
        const start = parseInt(m[1], 16);
        const end = parseInt(m[2], 16);
        const size = parseInt(m[3], 16);

        return { start, end, size };
      }));
    } catch(e) {
      reject(new Error('Response does not match expected format for memlayout.'));
    }
  }

  /**
   * Handle the reply to a requested list of handles owned by a process.
   * 
   * @param seq The sequence number of the reply
   * @param lines The lines sent as a reply
   */
  private handleHandles(seq: number, lines: string[]) {
    const { resolve, reject } = this.promises[seq];
    try {
      if (lines[lines.length - 1] !== 'done') {
        throw null;
      }

      const handles = lines.slice(0, -1);
      resolve(handles.map(handle => {
        const m = handle.match(/^h: ([\da-f]{8}), p: ([\da-f]{8})$/);
        const h = parseInt(m[1], 16);
        const p = parseInt(m[2], 16);
        return { h, p };
      }));
    } catch(e) {
      reject(new Error('Response does not match expected format for handles.'));
    }
  }

  /**
   * Handle the reply to a hello command.
   * 
   * @param seq The sequence number of the reply
   * @param lines The lines sent as a reply
   */
  private handleHello(seq: number, lines: string[]) {
    const { resolve, reject } = this.promises[seq];

    if (lines.length === 1 && lines[0] === 'hello') {
      resolve();
    } else {
      reject(new Error('Unexpected reply to hello: ' + lines.join('\n')));
    }
  }

  /**
   * Handle the end of a 'read memory' reply.
   * 
   * @param seq The sequence number of the reply
   * @param lines The lines sent as a reply
   */
  private handleReadMemoryText(seq: number, lines: string[]) {
    if (lines.length !== 1 || lines[0] !== 'finished') {
      this.promises[seq].reject(new Error('Did not receive memory.'));
    }
  }

  /**
   * Handle the data sent as a reply to a 'read memory' command.
   * 
   * @param seq The sequence number of the reply
   * @param data The raw data received
   */
  private handleReadMemoryData(seq: number, data: Buffer) {
    if (this.promises[seq + 1000] === undefined) {
      return;
    }

    const { resolve, reject } = this.promises[seq + 1000];

    if (data === undefined) {
      reject(new Error('Did not receive data.'));
      return;
    }

    resolve(data);
  }

  // Sending stuff

  /**
   * Send a packet with the given paramaters to NTR.
   * 
   * @param type The type of the command
   * @param cmd The command ID
   * @param args Up to 16 arguments of type uint32
   * @param dataLen Length of the payload that will be sent
   */
  private sendPacket(type: number, cmd: number, args: number[] = [], dataLen: number) {
    const buf = Buffer.alloc(84);
    buf.writeUInt32LE(0x12345678, 0);
    buf.writeUInt32LE(this.seqNumber, 4);
    buf.writeUInt32LE(type, 8);
    buf.writeUInt32LE(cmd, 12);
    for (let i = 0; i < Math.min(16, args.length); ++i) {
      buf.writeUInt32LE(args[i], 4 * (4 + i));
    }
    buf.writeUInt32LE(dataLen, 80);
    this.sock.write(buf);

    this.seqNumber += 1000;
  }

  /**
   * Save a file to the connected device under the given path.
   * 
   * @param name The path of the target file
   * @param data The data to be saved
   */
  public saveFile(name: string, data: Buffer) {
    const nameBuffer = Buffer.alloc(200);
    nameBuffer.write(name);
    this.sendPacket(1,1, undefined, 200 + data.byteLength);
    this.sock.write(nameBuffer);
    this.sock.write(data);
  }

  /**
   * TODO: Figure out usage and document.
   */
  public reload() {
    this.sendPacket(0, 4, undefined, 0);
  }

  /**
   * Send a hello packet - roughly equivalent to a ping.
   */
  public hello(): Promise<void> {
    this.sendPacket(0, 3, undefined, 0);
    const seq = this.seqNumber;
    return new Promise((resolve, reject) => {
      this.promises[seq] = { resolve, reject, type: 'hello' };
    });
  }

  /**
   * Send a heartbeat packet to the device.
   */
  private heartbeat() {
    if (this.canSendHeartbeat) {
      this.canSendHeartbeat = false;
      this.sendPacket(0, 0, undefined, 0);
    }
  }

  /**
   * Write an area of memory to an address in the memory space of a process.
   * 
   * @param addr The address to write to
   * @param pid PID
   * @param buf The data to be written
   */
  public writeMemory(addr: number, pid: number, buf: Buffer) {
    this.sendPacket(1, 10, [pid, addr, buf.byteLength], buf.byteLength);
    this.sock.write(buf);
  }

  /**
   * Read memory from an address in the memory space of a process.
   * 
   * @param addr The address to read from
   * @param size The size of the memory region to read
   * @param pid PID
   */
  public readMemory(addr: number, size: number, pid: number): Promise<Buffer> {
    this.sendPacket(0, 9, [pid, addr, size], 0);
    const seq = this.seqNumber;
    return new Promise((resolve, reject) => {
      this.promises[seq] = { resolve, reject, type: 'memory' };
    });
  }

  /**
   * Add a breakpoint at an address in the attacked process that triggers either once or always.
   * This function is untested.
   * 
   * @param addr Address of the instruction to break at
   * @param type Whether to break once or always
   */
  public addBreakpoint(addr: number, type: 'always' | 'once') {
    if (type === 'always') {
      this.sendPacket(0, 11, [1, addr, 1], 0);
    } else if (type === 'once') {
      this.sendPacket(0, 11, [2, addr, 1], 0);
    }
  }

  /**
   * Probably disable a breakpoint with the given ID.
   * This function is untested.
   * 
   * @param id ID of the breakpoit to disable
   */
  public disableBreakpoint(id) {
    this.sendPacket(0, 11, [id, 0, 3], 0);
  }

  /**
   * Probably enable a breakpoint with the given ID.
   * This function is untested.
   * 
   * @param id ID of the breakpoit to enable
   */
  public enableBreakpoint(id) {
    this.sendPacket(0, 11, [id, 0, 2], 0);
  }

  /**
   * Probably resume the execution of the attacked stopped at a breakpoint.
   * This function is untested.
   */
  public resume() {
    this.sendPacket(0, 11, [0, 0, 4], 0);
  }

  /**
   * Get a list of all processes running on the target device.
   * 
   * @return A Promise for a list of all running processe
   */
  public listProcesses(): Promise<ProcessDescriptor[]> {
    this.sendPacket(0, 5, undefined, 0);
    const seq = this.seqNumber;
    return new Promise((resolve, reject) => {
      this.promises[seq] = { resolve, reject, type: 'processes' };
    });
  }

  /**
   * Get a list of all threads that are part of a given process.
   * 
   * @param pid The process ID for which to retrieve the threads
   * @return A promise for the threads
   */
  public listThreads(pid): Promise<ThreadListResponse> {
    this.sendPacket(0, 7, [pid], 0);
    const seq = this.seqNumber;
    return new Promise((resolve, reject) => {
      this.promises[seq] = { resolve, reject, type: 'threads' };
    });
  }

  /**
   * Attach the debugger to a given process.
   * 
   * @param pid Process to attach to
   * @param patchAddr Unknown
   */
  public attachToProcess(pid, patchAddr = 0) {
    this.sendPacket(0, 6, [pid, patchAddr], 0);
  }

  /**
   * Request the handles owned by a given process.
   * 
   * @param pid The process from which to retrieve the handles.
   * @return A promis for the list of handles
   */
  public queryHandle(pid): Promise<HandleDescriptor[]> {
    this.sendPacket(0, 12, [pid], 0);
    const seq = this.seqNumber;
    return new Promise((resolve, reject) => {
      this.promises[seq] = { resolve, reject, type: 'handle' };
    });
  }

  /**
   * Get the memory regions mapped by a given process.
   * 
   * @param pid The process for which to retrieve the memory regions
   * @return A promise for the memory regions
   */
  public getMemlayout(pid): Promise<{ start: number, end: number, size: number }[]> {
    this.sendPacket(0, 8, [pid], 0);
    const seq = this.seqNumber;
    return new Promise((resolve, reject) => {
      this.promises[seq] = { resolve, reject, type: 'memlayout' };
    });
  }

  /**
   * Start the remote play, i.e. streaming of the screens to a supported program.
   * 
   * @param priorityMode Controls which screen has the priority to be transferred.
   *                     0 for the top screen, and 1 for the bottom screen
   * @param priorityFactor Controls the priority promoted screen's frame-rate factor.
   *                       When it is set to 1, the top screen have same frame-rate with bottom.
   *                       When set to 0, only the screen set by priorityMode will be displayed.
   * @param quality Controls the JPEG compression quality. Ranged from 1 to 100; from 1 being lowest, 100 being highest
   * @param qosValue Limits the bandwidth to work on different wireless environments, the actual bandwidth cost could
   *                 be lower than this value. Set to 25, 30 or higher on good wireless environment, set to 15 if the
   *                  WiFi quality is not so good. Setting qosValue higher than 100 will disable the QoS feature.
   */
  public remoteplay(priorityMode: 0 | 1 = 0, priorityFactor = 5, quality = 90, qosValue = 15.0) {
    const num = (qosValue * 1024 * 1024 / 8);
    this.sendPacket(0, 901, [(priorityMode << 8 | priorityFactor), quality], 0);
  }
}
