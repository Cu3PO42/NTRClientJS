"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const net_1 = require("net");
class SocketBase {
    constructor() {
        this.currentBuffer = new Uint8Array(0);
        this.nextPromises = [];
        this.disconnected = false;
    }
    onDisconnect() {
        this.disconnected = true;
        for (const promise of this.nextPromises) {
            promise.reject(new Error("Connection closed."));
        }
        this.nextPromises = [];
    }
    receiveData(data) {
        const newBuffer = new Uint8Array(this.currentBuffer.length + data.length);
        newBuffer.set(this.currentBuffer);
        newBuffer.set(data, this.currentBuffer.length);
        this.currentBuffer = newBuffer;
        let startOffset = 0;
        while (this.nextPromises.length) {
            const nextPromise = this.nextPromises[0];
            if (nextPromise.length <= this.currentBuffer.length) {
                this.nextPromises.shift();
                nextPromise.resolve(this.currentBuffer.subarray(startOffset, startOffset + nextPromise.length));
                startOffset += nextPromise.length;
            }
            else {
                break;
            }
        }
        if (startOffset > 0) {
            this.currentBuffer = this.currentBuffer.subarray(startOffset);
        }
    }
    read(bytes) {
        if (this.nextPromises.length === 0 && bytes <= this.currentBuffer.length) {
            const res = Promise.resolve(this.currentBuffer.subarray(0, bytes));
            this.currentBuffer = this.currentBuffer.subarray(bytes);
            return res;
        }
        if (this.disconnected) {
            return Promise.reject(new Error("Connection closed."));
        }
        return new Promise((resolve, reject) => {
            this.nextPromises.push({ resolve, reject, length: bytes });
        });
    }
}
class NativeSocket extends SocketBase {
    constructor(ip, port, connectedCallback, disconnectedCallback) {
        super();
        this.disconnectedCallback = disconnectedCallback;
        this.sock = net_1.connect(port, ip, () => {
            this.sock.setNoDelay(true);
            this.sock.setKeepAlive(true);
            connectedCallback();
        });
        this.sock.on('end', () => { });
        this.sock.on('data', data => {
            this.receiveData(new Uint8Array(data.buffer, data.byteOffset, data.length));
        });
        this.sock.on('close', (err) => {
            if (this.disconnectedCallback)
                this.disconnectedCallback(err);
            this.onDisconnect();
        });
    }
    write(data) {
        this.sock.write(Buffer.from(data.buffer, data.byteOffset, data.length));
    }
    close() {
        this.sock.end();
    }
}
function dataToString(data) {
    if (typeof TextDecoder !== 'undefined') {
        return new TextDecoder().decode(data);
    }
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return buf.toString();
}
function stringToBinaryPadded(str, size) {
    if (typeof TextEncoder !== 'undefined') {
        const res = new Uint8Array(size);
        res.set(new TextEncoder().encode(str));
        return res;
    }
    const buf = Buffer.alloc(size);
    buf.write(str);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
class NtrClient {
    constructor(ip, connectedCallback, disconnectedCallback) {
        this.seqNumber = 1000;
        this.canSendHeartbeat = true;
        this.promises = {};
        this.sock = new NativeSocket(ip, 8000, () => {
            this.heartbeatId = setInterval(this.heartbeat.bind(this), 1000);
        }, disconnectedCallback);
        if (typeof connectedCallback === 'function') {
            this.connectedCallback = connectedCallback;
        }
        this.handleData();
    }
    disconnect() {
        clearInterval(this.heartbeatId);
        this.sock.close();
    }
    static connectNTR(ip, disconnectedCallback) {
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
    handleData() {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const cmdBufArr = yield this.sock.read(84);
                const cmdBuf = new DataView(cmdBufArr.buffer, cmdBufArr.byteOffset, cmdBufArr.length);
                const magic = cmdBuf.getUint32(0, true);
                const seq = cmdBuf.getUint32(4, true);
                const type = cmdBuf.getUint32(8, true);
                const cmd = cmdBuf.getUint32(12, true);
                const args = new Uint32Array(cmdBuf.buffer, cmdBuf.byteOffset + 16, 16);
                const dataLen = cmdBuf.getUint32(80, true);
                if (magic != 0x12345678) {
                    return;
                }
                if (dataLen !== 0) {
                    const data = yield this.sock.read(dataLen);
                    this.handlePacket(cmd, seq, data);
                }
                else {
                    this.handlePacket(cmd, seq, undefined);
                }
                if (this.connectedCallback) {
                    this.connectedCallback();
                    this.connectedCallback = undefined;
                }
                this.handleData();
            }
            catch (e) {
                this.disconnect();
            }
        });
    }
    handlePacket(cmd, seq, data) {
        switch (cmd) {
            case 0:
                this.canSendHeartbeat = true;
                if (this.promises[seq] === undefined) {
                    break;
                }
                const { type } = this.promises[seq];
                const lines = data !== undefined ? dataToString(data).match(/^.+$/gm) : [];
                switch (type) {
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
    handleProcesses(seq, lines) {
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
        }
        catch (e) {
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
                const data = lines[i + 2].split(' ');
                const dataBuf = new Uint8Array(128);
                const dataBufView = new DataView(dataBuf.buffer, dataBuf.byteOffset, dataBuf.byteLength);
                for (let j = 0; j < 32; ++j) {
                    const val = parseInt(data[j], 16);
                    if (Number.isNaN(val)) {
                        throw null;
                    }
                    dataBufView.setUint32(j * 4, val, true);
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
        }
        catch (e) {
            reject(new Error('Response does not match expected format for thread list.'));
        }
    }
    handleMemlayout(seq, lines) {
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
        }
        catch (e) {
            reject(new Error('Response does not match expected format for memlayout.'));
        }
    }
    handleHandles(seq, lines) {
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
        }
        catch (e) {
            reject(new Error('Response does not match expected format for handles.'));
        }
    }
    handleHello(seq, lines) {
        const { resolve, reject } = this.promises[seq];
        if (lines.length === 1 && lines[0] === 'hello') {
            resolve();
        }
        else {
            reject(new Error('Unexpected reply to hello: ' + lines.join('\n')));
        }
    }
    handleReadMemoryText(seq, lines) {
        if (lines.length !== 1 || lines[0] !== 'finished') {
            this.promises[seq].reject(new Error('Did not receive memory.'));
        }
    }
    handleReadMemoryData(seq, data) {
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
    sendPacket(type, cmd, args = [], dataLen) {
        const data = new Uint8Array(84);
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        view.setUint32(0, 0x12345678, true);
        view.setUint32(4, this.seqNumber, true);
        view.setUint32(8, type, true);
        view.setUint32(12, cmd, true);
        for (let i = 0; i < Math.min(16, args.length); ++i) {
            view.setUint32(4 * (4 + i), args[i], true);
        }
        view.setUint32(80, dataLen, true);
        this.sock.write(data);
        this.seqNumber += 1000;
    }
    saveFile(name, data) {
        const nameBuffer = stringToBinaryPadded(name, 200);
        this.sendPacket(1, 1, undefined, 200 + data.byteLength);
        this.sock.write(nameBuffer);
        this.sock.write(data);
    }
    reload() {
        this.sendPacket(0, 4, undefined, 0);
    }
    hello() {
        this.sendPacket(0, 3, undefined, 0);
        const seq = this.seqNumber;
        return new Promise((resolve, reject) => {
            this.promises[seq] = { resolve, reject, type: 'hello' };
        });
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
        }
        else if (type === 'once') {
            this.sendPacket(0, 11, [2, addr, 1], 0);
        }
    }
    disableBreakpoint(id) {
        this.sendPacket(0, 11, [id, 0, 3], 0);
    }
    enableBreakpoint(id) {
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
    remoteplay(priorityMode = 0, priorityFactor = 5, quality = 90, qosValue = 15.0) {
        const num = (qosValue * 1024 * 1024 / 8);
        this.sendPacket(0, 901, [(priorityMode << 8 | priorityFactor), quality], 0);
    }
}
exports.default = NtrClient;
//# sourceMappingURL=ntrclient.js.map