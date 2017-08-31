/// <reference types="node" />
export interface ProcessDescriptor {
    pid: number;
    tid: number;
    name: string;
    kpobj: number;
}
export interface ThreadDescriptor {
    tid: number;
    pc: number;
    lr: number;
    data: Buffer;
}
export interface ThreadListResponse {
    threads: ThreadDescriptor[];
    recommendedPc: number[];
    recommendedLr: number[];
}
export interface HandleDescriptor {
    h: number;
    p: number;
}
export default class NtrClient {
    private seqNumber;
    private canSendHeartbeat;
    private promises;
    private sock;
    private heartbeatId;
    private connectedCallback;
    private disconnectedCallback;
    private stream;
    constructor(ip: string, connectedCallback: () => void, disconnectedCallback: (error: boolean) => void);
    disconnect(): void;
    static connectNTR(ip: string, disconnectedCallback: (error: boolean) => void): Promise<{}>;
    private handleData();
    private handlePacket(cmd, seq, data?);
    private handleProcesses(seq, lines);
    private handleThreads(seq, lines);
    private handleMemlayout(seq, lines);
    private handleHandles(seq, lines);
    private handleHello(seq, lines);
    private handleReadMemoryText(seq, lines);
    private handleReadMemoryData(seq, data);
    private sendPacket(type, cmd, args, dataLen);
    saveFile(name: string, data: Buffer): void;
    reload(): void;
    hello(): Promise<void>;
    private heartbeat();
    writeMemory(addr: number, pid: number, buf: Buffer): void;
    readMemory(addr: number, size: number, pid: number): Promise<Buffer>;
    addBreakpoint(addr: number, type: 'always' | 'once'): void;
    disableBreakpoint(id: any): void;
    enableBreakpoint(id: any): void;
    resume(): void;
    listProcesses(): Promise<ProcessDescriptor[]>;
    listThreads(pid: any): Promise<ThreadListResponse>;
    attachToProcess(pid: any, patchAddr?: number): void;
    queryHandle(pid: any): Promise<HandleDescriptor[]>;
    getMemlayout(pid: any): Promise<{
        start: number;
        end: number;
        size: number;
    }[]>;
    remoteplay(priorityMode?: 0 | 1, priorityFactor?: number, quality?: number, qosValue?: number): void;
}
