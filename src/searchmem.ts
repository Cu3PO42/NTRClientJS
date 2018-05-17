import NtrClient from './ntrclient';

/**
 * Search for a given uint32 value in the memory of a process.
 * 
 * @param client The NTRClient which should be used to access memory
 * @param pid The PID of the target process
 * @param value The uint32 value for which to search
 * @param locations A possible list of locations to check. If this argument is omitted, check all locations
 * @return A list of locations where the value was found
 */
export default async function search(client: NtrClient, pid: number, value: number, locations?: number[]) {
  if (locations !== undefined) {
    const res: number[] = [];

    for (const loc of locations) {
      const data = await client.readMemory(loc, 4, pid);
      const val = new DataView(data.buffer, data.byteOffset, data.byteLength);
      if (val.getUint32(0, true) === value) {
        res.push(loc);
      }
    }

    return res;
  }

  const memorymap = await client.getMemlayout(pid);
  const res: number[] = [];
  for (const region of memorymap) {
    console.log(`Scanning region from ${region.start.toString(16)} to ${region.end.toString(16)}`);
    const memArr = await client.readMemory(region.start, region.size, pid);
    const mem = new DataView(memArr.buffer, memArr.byteOffset, memArr.byteLength);
    for (let i = 0; i < mem.byteLength; i += 4) {
      if (mem.getUint32(i, true) === value) {
        res.push(region.start + i);
      }
    }
  }

  return res;
}
