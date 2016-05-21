export default async function search(client, pid, value, locations) {
  if (locations !== undefined) {
    const res = [];

    for (const loc of locations) {
      const val = await client.readMemory(loc, 4, pid);
      if (val.readUInt32LE(0) === value) {
        res.push(loc);
      }
    }

    return res;
  }

  const memorymap = await client.getMemlayout(pid);
  const res = [];
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
