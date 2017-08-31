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
      const val = await client.readMemory(loc, 4, pid);
      if (val.readUInt32LE(0) === value) {
        res.push(loc);
      }
    }

    return res;
  }

  const memorymap = await client.getMemlayout(pid);
  const res: number[] = [];
  for (const region of memorymap) {
    console.log(`Scanning region from ${region.start.toString(16)} to ${region.end.toString(16)}`);
    const mem = await client.readMemory(region.start, region.size, pid);
    for (let i = 0; i < mem.length; i += 4) {
      if (mem.readUInt32LE(i) === value) {
        res.push(region.start + i);
      }
    }
  }

  return res;
}
