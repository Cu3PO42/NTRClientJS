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
function search(client, pid, value, locations) {
    return __awaiter(this, void 0, void 0, function* () {
        if (locations !== undefined) {
            const res = [];
            for (const loc of locations) {
                const data = yield client.readMemory(loc, 4, pid);
                const val = new DataView(data.buffer, data.byteOffset, data.byteLength);
                if (val.getUint32(0, true) === value) {
                    res.push(loc);
                }
            }
            return res;
        }
        const memorymap = yield client.getMemlayout(pid);
        const res = [];
        for (const region of memorymap) {
            console.log(`Scanning region from ${region.start.toString(16)} to ${region.end.toString(16)}`);
            const memArr = yield client.readMemory(region.start, region.size, pid);
            const mem = new DataView(memArr.buffer, memArr.byteOffset, memArr.byteLength);
            for (let i = 0; i < mem.byteLength; i += 4) {
                if (mem.getUint32(i, true) === value) {
                    res.push(region.start + i);
                }
            }
        }
        return res;
    });
}
exports.default = search;
//# sourceMappingURL=searchmem.js.map