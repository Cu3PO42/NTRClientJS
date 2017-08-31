/// <reference types="node" />
export default class NtrClient {
    private seqNumber;
    private canSendHeartbeat;
    private promises;
    private sock;
    private heartbeatId;
    private connectedCallback;
    private disconnectedCallback;
    private stream;
    constructor(ip: any, connectedCallback: any, disconnectedCallback: any);
    disconnect(): void;
    static connectNTR(ip: any, disconnectedCallback: any): Promise<{}>;
    handleData(): Promise<void>;
    handlePacket(cmd: any, seq: any, data: any): void;
    handleProcesses(seq: any, lines: any): void;
    handleThreads(seq: any, lines: any): void;
    handleMemlayout(seq: any, lines: any): void;
    handleHandles(seq: any, lines: any): void;
    handleHello(seq: any, lines: any): void;
    handleReadMemoryText(seq: any, lines: any): void;
    handleReadMemoryData(seq: any, data: any): void;
    sendPacket(type: any, cmd: any, args: any[], dataLen: any): void;
    saveFile(name: any, data: any): void;
    reload(): void;
    hello(): Promise<{}>;
    heartbeat(): void;
    writeMemory(addr: any, pid: any, buf: any): void;
    readMemory(addr: any, size: any, pid: any): Promise<Buffer>;
    addBreakpoint(addr: any, type: any): void;
    disBreakpoint(id: any): void;
    enaBreakpoint(id: any): void;
    resume(): void;
    listProcesses(): Promise<{}>;
    listThreads(pid: any): Promise<{}>;
    attachToProcess(pid: any, patchAddr?: number): void;
    queryHandle(pid: any): Promise<{}>;
    getMemlayout(pid: any): Promise<{
        start: number;
        end: number;
        size: number;
    }[]>;
    remoteplay(priorityMode?: number, priorityFactor?: number, quality?: number, qosValue?: number): void;
}
